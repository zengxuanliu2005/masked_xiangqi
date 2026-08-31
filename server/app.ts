import { existsSync } from "node:fs";
import path from "node:path";
import cors from "cors";
import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { z } from "zod";
import {
  applyMove,
  GameRuleError,
  legalMoves,
  resign,
  toPublicGame,
  undo,
} from "../engine/game";
import { GameStore, GameStoreCapacityError } from "../engine/store";
import { oppositeColor, type Color } from "../shared/contracts";
import {
  chooseMoveWithRetry,
  describeAiAvailability,
  OllamaClient,
  OllamaServiceError,
  type AiProvider,
} from "./ollama";
import {
  AgentSessionError,
  AgentSessionManager,
} from "./agent/session-manager";

const colorSchema = z.enum(["red", "black"]);
const modeSchema = z.enum(["standard", "capture-general"]);
const matchTypeSchema = z.enum(["human-human", "human-ai"]);
const positionSchema = z
  .object({
    x: z.number().int().min(0).max(8),
    y: z.number().int().min(0).max(9),
  })
  .strict();
const createGameSchema = z
  .object({
    mode: modeSchema.default("standard"),
    allowDraw: z.boolean().default(true),
    allowUndo: z.boolean().default(true),
    matchType: matchTypeSchema.default("human-human"),
    player1Side: colorSchema.optional(),
    aiModel: z.string().trim().min(1).max(200).optional(),
    seed: z.string().trim().min(1).max(80).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.matchType === "human-ai" && !value.aiModel) {
      context.addIssue({
        code: "custom",
        path: ["aiModel"],
        message: "人机对战必须指定本机模型。",
      });
    }
  });
const moveSchema = z
  .object({
    from: positionSchema,
    to: positionSchema,
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();
const resignSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();
const runnerStatusSchema = z
  .object({
    status: z.enum([
      "starting",
      "waiting-human",
      "thinking",
      "submitting",
      "paused",
      "finished",
      "stopped",
      "exited",
    ]),
    error: z.string().max(1_000).nullable().optional(),
  })
  .strict();

const emptyBodySchema = z.object({}).strict();
const legalMovesQuerySchema = z
  .object({ pieceId: z.string().min(1).max(120).optional() })
  .strict();

const jsonError = (
  response: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown,
) =>
  response.status(status).json({
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  });

const isLoopbackHost = (rawHost: string): boolean => {
  try {
    const hostname = new URL(`http://${rawHost}`).hostname.toLowerCase();
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
  } catch {
    return false;
  }
};

const getGameOr404 = (
  store: GameStore,
  request: Request,
  response: Response,
) => {
  const rawId = request.params.id;
  const game = store.get(Array.isArray(rawId) ? rawId[0] : rawId);
  if (!game) {
    response.status(404).json({
      error: { code: "GAME_NOT_FOUND", message: "没有找到该对局。" },
    });
  }
  return game;
};

const validate = <T extends z.ZodType>(
  schema: T,
  value: unknown,
  response: Response,
): z.infer<T> | undefined => {
  const result = schema.safeParse(value);
  if (!result.success) {
    response.status(400).json({
      error: {
        code: "INVALID_REQUEST",
        message: "请求参数格式不正确。",
        details: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    });
    return undefined;
  }
  return result.data;
};

export interface AppOptions {
  store?: GameStore;
  serveFrontend?: boolean;
  aiProvider?: AiProvider;
  agentSessionManager?: AgentSessionManager;
  apiBaseUrl?: string;
  random?: () => number;
}

export function createApp(options: AppOptions = {}) {
  const app = express();
  const store = options.store ?? new GameStore();
  const aiProvider = options.aiProvider ?? new OllamaClient();
  const agentSessionManager =
    options.agentSessionManager ?? new AgentSessionManager();
  const random = options.random ?? Math.random;
  const aiDecisions = new Map<string, AbortController>();
  app.locals.agentSessionManager = agentSessionManager;
  app.disable("x-powered-by");
  app.use((request, response, next) => {
    if (!isLoopbackHost(request.get("host") ?? "")) {
      jsonError(response, 403, "HOST_FORBIDDEN", "只允许通过本机 Host 访问。");
      return;
    }
    next();
  });
  app.use(
    cors({
      origin(origin, callback) {
        if (
          !origin ||
          /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
        ) {
          callback(null, true);
          return;
        }
        callback(new Error("Only local browser origins are allowed."));
      },
    }),
  );
  app.use((request, response, next) => {
    if (!request.path.startsWith("/api/")) {
      next();
      return;
    }
    const declaredLength = Number.parseInt(
      request.get("content-length") ?? "0",
      10,
    );
    if (Number.isFinite(declaredLength) && declaredLength > 16 * 1024) {
      jsonError(response, 413, "PAYLOAD_TOO_LARGE", "请求体不能超过 16 KiB。");
      return;
    }
    const hasBody =
      declaredLength > 0 || Boolean(request.get("transfer-encoding"));
    if (hasBody && !request.is("application/json")) {
      jsonError(
        response,
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "请求体必须使用 application/json 和 UTF-8 编码。",
      );
      return;
    }
    const contentType = request.get("content-type") ?? "";
    const charset = /charset\s*=\s*([^;]+)/i
      .exec(contentType)?.[1]
      ?.trim()
      .toLowerCase();
    if (charset && charset !== "utf-8" && charset !== "utf8") {
      jsonError(
        response,
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "JSON 请求仅支持 UTF-8 编码。",
      );
      return;
    }
    next();
  });
  app.use(express.json({ limit: "16kb" }));

  app.get("/api/v1/health", (_request, response) => {
    response.json({ ok: true, apiVersion: "v1" });
  });

  app.get("/api/v1/ai/models", async (_request, response) => {
    response.json(await describeAiAvailability(aiProvider));
  });

  app.post("/api/v1/games", async (request, response) => {
    const body = validate(createGameSchema, request.body, response);
    if (!body) return;
    if (body.matchType === "human-ai") {
      const models = await aiProvider.listModels();
      const selected = models.find((model) => model.name === body.aiModel);
      if (!selected) {
        throw new OllamaServiceError(
          "MODEL_NOT_FOUND",
          "所选模型已不存在，请重新检测本机模型。",
        );
      }
      if (selected.supportsCompletion === false) {
        throw new OllamaServiceError(
          "MODEL_NOT_GENERATIVE",
          "所选模型仅支持 embedding，不能用于对弈。",
        );
      }
    }
    const player1Side: Color =
      body.player1Side ?? (random() < 0.5 ? "red" : "black");
    const game = store.create({
      mode: body.mode,
      allowDraw: body.allowDraw,
      allowUndo: body.allowUndo,
      matchType: body.matchType,
      player1Side,
      aiModel: body.matchType === "human-ai" ? body.aiModel : null,
      seed: body.seed,
    });
    response.status(201).json(toPublicGame(game));
  });

  app.get("/api/v1/games/:id", (request, response) => {
    const game = getGameOr404(store, request, response);
    if (!game) return;
    response.json(toPublicGame(game));
  });

  app.get("/api/v1/games/:id/legal-moves", (request, response) => {
    const game = getGameOr404(store, request, response);
    if (!game) return;
    const query = validate(legalMovesQuerySchema, request.query, response);
    if (!query) return;
    response.json({
      gameId: game.id,
      revision: game.revision,
      turn: game.turn,
      moves: legalMoves(game, query.pieceId),
    });
  });

  app.post("/api/v1/games/:id/moves", (request, response) => {
    const game = getGameOr404(store, request, response);
    if (!game) return;
    const body = validate(moveSchema, request.body, response);
    if (!body) return;
    const nextGame = applyMove(game, body);
    aiDecisions
      .get(game.id)
      ?.abort(new DOMException("局面已被其他写请求更新。", "AbortError"));
    if (nextGame.status.phase === "finished") {
      agentSessionManager.finish(game.id);
    }
    response.json(toPublicGame(nextGame));
  });

  app.post("/api/v1/games/:id/resign", (request, response) => {
    const game = getGameOr404(store, request, response);
    if (!game) return;
    const body = validate(resignSchema, request.body, response);
    if (!body) return;
    const nextGame = resign(game, body.expectedRevision);
    aiDecisions
      .get(game.id)
      ?.abort(new DOMException("对局已经结束。", "AbortError"));
    agentSessionManager.finish(game.id);
    response.json(toPublicGame(nextGame));
  });

  app.post("/api/v1/games/:id/undo", (request, response) => {
    const game = getGameOr404(store, request, response);
    if (!game) return;
    const body = validate(resignSchema, request.body, response);
    if (!body) return;
    const nextGame = undo(game, body.expectedRevision);
    aiDecisions
      .get(game.id)
      ?.abort(new DOMException("局面已悔棋。", "AbortError"));
    response.json(toPublicGame(nextGame));
  });

  const assertAgentGame = (
    game: NonNullable<ReturnType<GameStore["get"]>>,
    response: Response,
  ) => {
    if (game.matchType !== "human-ai" || !game.aiModel) {
      response.status(422).json({
        error: { code: "NOT_AI_GAME", message: "该对局不是人机对战。" },
      });
      return false;
    }
    if (game.status.phase !== "active") {
      response.status(409).json({
        error: {
          code: "GAME_FINISHED",
          message: "对局已经结束，不能启动控制器。",
        },
      });
      return false;
    }
    return true;
  };

  const apiBaseUrlFor = (request: Request): string => {
    if (options.apiBaseUrl) return options.apiBaseUrl;
    const host = request.get("host") ?? "127.0.0.1:3001";
    const candidate = new URL(`${request.protocol}://${host}`);
    if (
      !["localhost", "127.0.0.1", "::1", "[::1]"].includes(candidate.hostname)
    ) {
      throw new AgentSessionError(
        "AGENT_SESSION_IO_ERROR",
        "无法从非本机 Host 创建 Agent 会话。",
      );
    }
    return candidate.origin;
  };

  app.post("/api/v1/games/:id/agent-session", async (request, response) => {
    if (!validate(emptyBodySchema, request.body ?? {}, response)) return;
    const game = getGameOr404(store, request, response);
    if (!game || !assertAgentGame(game, response)) return;
    const result = await agentSessionManager.create(
      game,
      apiBaseUrlFor(request),
    );
    response.status(result.created ? 201 : 200).json(result.state);
  });

  app.get("/api/v1/games/:id/agent-session", (request, response) => {
    const game = getGameOr404(store, request, response);
    if (!game) return;
    const state = agentSessionManager.get(game.id);
    if (!state) {
      response.status(404).json({
        error: {
          code: "AGENT_SESSION_NOT_FOUND",
          message: "该对局尚未创建 Agent 控制会话。",
        },
      });
      return;
    }
    response.json(state);
  });

  app.post(
    "/api/v1/games/:id/agent-session/restart",
    async (request, response) => {
      if (!validate(emptyBodySchema, request.body ?? {}, response)) return;
      const game = getGameOr404(store, request, response);
      if (!game || !assertAgentGame(game, response)) return;
      const result = await agentSessionManager.restart(
        game,
        apiBaseUrlFor(request),
      );
      response.status(result.created ? 201 : 200).json(result.state);
    },
  );

  app.delete("/api/v1/games/:id/agent-session", (request, response) => {
    const game = getGameOr404(store, request, response);
    if (!game) return;
    response.json(agentSessionManager.stop(game.id));
  });

  const bearerToken = (request: Request): string => {
    const authorization = request.get("authorization") ?? "";
    return authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : "";
  };

  app.get("/api/v1/games/:id/agent-session/runner", (request, response) => {
    const game = getGameOr404(store, request, response);
    if (!game) return;
    response.json(
      agentSessionManager.runnerControl(game.id, bearerToken(request)),
    );
  });

  app.patch("/api/v1/games/:id/agent-session/runner", (request, response) => {
    const game = getGameOr404(store, request, response);
    if (!game) return;
    const body = validate(runnerStatusSchema, request.body, response);
    if (!body) return;
    response.json(
      agentSessionManager.updateFromRunner(game.id, bearerToken(request), body),
    );
  });

  app.post("/api/v1/games/:id/ai-move", async (request, response) => {
    const game = getGameOr404(store, request, response);
    if (!game) return;
    const body = validate(resignSchema, request.body, response);
    if (!body) return;
    if (game.matchType !== "human-ai" || !game.aiModel) {
      response.status(422).json({
        error: { code: "NOT_AI_GAME", message: "该对局不是人机对战。" },
      });
      return;
    }
    if (game.status.phase !== "active") {
      response.status(409).json({
        error: {
          code: "GAME_FINISHED",
          message: "对局已经结束，不能继续操作。",
        },
      });
      return;
    }
    if (aiDecisions.has(game.id)) {
      jsonError(
        response,
        409,
        "AI_DECISION_IN_PROGRESS",
        "该对局已有一个模型决策正在进行。",
      );
      return;
    }
    const decisionController = new AbortController();
    aiDecisions.set(game.id, decisionController);
    const abortOnDisconnect = () =>
      decisionController.abort(
        new DOMException("客户端已经断开。", "AbortError"),
      );
    request.once("aborted", abortOnDisconnect);
    try {
      if (body.expectedRevision !== game.revision) {
        jsonError(
          response,
          409,
          "STALE_REVISION",
          "局面已更新，请读取最新版本后重试。",
          {
            expectedRevision: body.expectedRevision,
            actualRevision: game.revision,
          },
        );
        return;
      }
      const aiColor = oppositeColor(game.player1Side);
      if (game.turn !== aiColor) {
        jsonError(response, 409, "NOT_AI_TURN", "现在不是本机模型的回合。");
        return;
      }

      const moves = legalMoves(game);
      if (moves.length === 0) {
        jsonError(
          response,
          409,
          "NO_LEGAL_MOVES",
          "本机模型当前没有合法着法。",
        );
        return;
      }
      const decision = await chooseMoveWithRetry(
        aiProvider,
        {
          game: toPublicGame(game),
          legalMoves: moves,
          model: game.aiModel,
        },
        { signal: decisionController.signal },
      );
      if (
        decisionController.signal.aborted ||
        game.revision !== body.expectedRevision ||
        game.status.phase !== "active" ||
        game.turn !== aiColor
      ) {
        jsonError(
          response,
          409,
          "STALE_REVISION",
          "模型思考期间局面已更新，旧决定已丢弃。",
          { actualRevision: game.revision },
        );
        return;
      }
      const selectedMove = moves[decision.moveIndex];
      if (!selectedMove) {
        throw new OllamaServiceError(
          "OLLAMA_BAD_RESPONSE",
          "本机模型选择了不存在的着法。",
        );
      }
      const modelName = game.aiModel;
      const nextGame = applyMove(game, {
        from: selectedMove.from,
        to: selectedMove.to,
        expectedRevision: body.expectedRevision,
      });
      if (nextGame.status.phase === "finished") {
        agentSessionManager.finish(game.id);
      }
      response.json({
        game: toPublicGame(nextGame),
        decision: {
          model: modelName,
          source: decision.source,
          ...(decision.note ? { note: decision.note } : {}),
        },
      });
    } finally {
      request.off("aborted", abortOnDisconnect);
      if (aiDecisions.get(game.id) === decisionController) {
        aiDecisions.delete(game.id);
      }
    }
  });

  app.use("/api", (_request, response) => {
    response.status(404).json({
      error: { code: "ENDPOINT_NOT_FOUND", message: "API 地址不存在。" },
    });
  });

  if (options.serveFrontend) {
    const distDirectory = path.resolve(process.cwd(), "dist");
    if (existsSync(distDirectory)) {
      app.use(express.static(distDirectory));
      app.use((request, response, next) => {
        if (request.method === "GET" && request.accepts("html")) {
          response.sendFile(path.join(distDirectory, "index.html"));
          return;
        }
        next();
      });
    }
  }

  const errorHandler: ErrorRequestHandler = (
    error: unknown,
    request: Request,
    response: Response,
    next: NextFunction,
  ) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    const parserError = error as {
      type?: string;
      status?: number;
      statusCode?: number;
      message?: string;
    };
    if (parserError.type === "entity.too.large" || parserError.status === 413) {
      jsonError(response, 413, "PAYLOAD_TOO_LARGE", "请求体不能超过 16 KiB。");
      return;
    }
    if (parserError.type === "entity.parse.failed") {
      jsonError(response, 400, "INVALID_JSON", "请求体不是有效的 JSON。");
      return;
    }
    if (
      parserError.type === "charset.unsupported" ||
      parserError.status === 415 ||
      parserError.statusCode === 415
    ) {
      jsonError(
        response,
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "JSON 请求仅支持 application/json 和 UTF-8 编码。",
      );
      return;
    }
    if (error instanceof GameStoreCapacityError) {
      jsonError(response, 503, error.code, error.message);
      return;
    }
    if (error instanceof GameRuleError) {
      const status =
        error.code === "STALE_REVISION" ||
        error.code === "GAME_FINISHED" ||
        error.code === "UNDO_DISABLED" ||
        error.code === "NO_UNDO_AVAILABLE"
          ? 409
          : error.code === "PIECE_NOT_FOUND"
            ? 404
            : 422;
      response.status(status).json({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      });
      return;
    }
    if (error instanceof OllamaServiceError) {
      const status =
        error.code === "OLLAMA_UNAVAILABLE"
          ? 503
          : error.code === "MODEL_NOT_FOUND"
            ? 404
            : error.code === "MODEL_NOT_GENERATIVE"
              ? 422
              : 502;
      response.status(status).json({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      });
      return;
    }
    if (error instanceof AgentSessionError) {
      const status =
        error.code === "AGENT_SESSION_NOT_FOUND"
          ? 404
          : error.code === "AGENT_TOKEN_INVALID"
            ? 401
            : error.code === "CAPACITY_EXCEEDED"
              ? 503
              : 500;
      response.status(status).json({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      });
      return;
    }
    if (
      error instanceof Error &&
      error.message.includes("local browser origins")
    ) {
      response.status(403).json({
        error: { code: "ORIGIN_FORBIDDEN", message: "只允许本机来源访问。" },
      });
      return;
    }
    if (error instanceof Error && error.name === "AbortError") {
      if (!request.aborted) {
        jsonError(
          response,
          409,
          "STALE_REVISION",
          "请求期间局面或控制器状态已改变。",
        );
      }
      return;
    }
    response.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "服务器处理请求时发生错误。" },
    });
  };
  app.use(errorHandler);

  app.locals.shutdown = () => {
    for (const controller of aiDecisions.values()) {
      controller.abort(new DOMException("服务正在关闭。", "AbortError"));
    }
    aiDecisions.clear();
    agentSessionManager.stopAll();
  };

  return app;
}
