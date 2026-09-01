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
  canUndo,
  GameRuleError,
  legalMoves,
  resign,
  toPublicGame,
  undo,
} from "../engine/game";
import { GameStore, GameStoreCapacityError } from "../engine/store";
import type { GameState } from "../engine/types";
import {
  oppositeColor,
  type Color,
  type LanViewerSeatState,
} from "../shared/contracts";
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
import { LanRoomError, LanRoomManager } from "./lan/room-manager";
import {
  hostnameFromHostHeader,
  isAllowedRequestHost,
  isAllowedOrigin,
  isLoopbackAddress,
  isLoopbackHostname,
  normalizeSocketAddress,
  type NetworkMode,
} from "./net/host-policy";
import type { NetworkStatus } from "./network";

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
const createRoomSchema = z
  .object({
    mode: modeSchema.default("standard"),
    allowDraw: z.boolean().default(true),
    allowUndo: z.boolean().default(true),
    hostSide: colorSchema.optional(),
    // Identical to createGameSchema's rule: a diverging trim or length would
    // make the same seed produce a different opening per endpoint.
    seed: z.string().trim().min(1).max(80).optional(),
  })
  .strict();
const networkModeSchema = z
  .object({ mode: z.enum(["loopback", "lan"]) })
  .strict();
const undoResolveSchema = z
  .object({
    expectedRevision: z.number().int().min(0),
    requestId: z.string().min(1).max(128),
    accept: z.boolean(),
  })
  .strict();
const reinviteSchema = z
  .object({
    expectedRevision: z.number().int().min(0),
    expectedRoomCode: z.string().trim().min(1).max(64),
  })
  .strict();
const legalMovesQuerySchema = z
  .object({ pieceId: z.string().min(1).max(120).optional() })
  .strict();

/** Endpoints that can create local state, reach Ollama, or spawn a process. */
const isLoopbackOnlyEndpoint = (request: Request): boolean => {
  const { method, path: requestPath } = request;
  if (method === "POST" && requestPath === "/api/v1/games") return true;
  if (method === "POST" && requestPath === "/api/v1/rooms") return true;
  if (method === "POST" && requestPath === "/api/v1/network") return true;
  if (requestPath === "/api/v1/ai/models") return true;
  if (/^\/api\/v1\/games\/[^/]+\/ai-move$/.test(requestPath)) return true;
  return /^\/api\/v1\/games\/[^/]+\/agent-session(?:\/|$)/.test(requestPath);
};

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

const bearerToken = (request: Request): string => {
  const authorization = request.get("authorization") ?? "";
  return authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
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
  lanRoomManager?: LanRoomManager;
  apiBaseUrl?: string;
  random?: () => number;
  /**
   * Live getter so the HTTP gate follows a runtime mode switch. Defaults to
   * loopback: every existing caller keeps today's local-only behavior.
   */
  networkMode?: () => NetworkMode;
  /** Test seam; production always reads `request.socket.remoteAddress`. */
  remoteAddress?: (request: Request) => string | null | undefined;
  /** Present only in the real server; tests exercise the gate without a socket. */
  networkController?: {
    status: () => NetworkStatus;
    setMode: (next: NetworkMode) => Promise<unknown>;
  };
}

export function createApp(options: AppOptions = {}) {
  const app = express();
  const store = options.store ?? new GameStore();
  const aiProvider = options.aiProvider ?? new OllamaClient();
  const agentSessionManager =
    options.agentSessionManager ?? new AgentSessionManager();
  const lanRooms =
    options.lanRoomManager ??
    // `has`, not `get`: `get` bumps lastAccessedAt, and the room registry
    // sweeps every room on each poll, which would keep abandoned LAN games
    // alive forever and eventually exhaust the store.
    new LanRoomManager({
      hasGame: (gameId) => store.has(gameId),
      existingGames: (gameIds) => store.existing(gameIds),
    });
  const random = options.random ?? Math.random;
  const networkMode = options.networkMode ?? (() => "loopback" as NetworkMode);
  const remoteAddress = (request: Request) =>
    options.remoteAddress
      ? options.remoteAddress(request)
      : request.socket.remoteAddress;
  const advertisedAddresses = (): string[] =>
    options.networkController?.status().addresses ?? [];
  const aiDecisions = new Map<string, AbortController>();
  app.locals.agentSessionManager = agentSessionManager;
  app.disable("x-powered-by");
  app.use((request, response, next) => {
    const hostname = hostnameFromHostHeader(request.get("host") ?? "");
    const peer = remoteAddress(request);
    if (
      !hostname ||
      !isAllowedRequestHost(
        hostname,
        networkMode(),
        peer,
        advertisedAddresses(),
      )
    ) {
      const loopbackOnly =
        isLoopbackOnlyEndpoint(request) && !isLoopbackAddress(peer);
      jsonError(
        response,
        403,
        loopbackOnly ? "LOOPBACK_ONLY" : "HOST_FORBIDDEN",
        loopbackOnly
          ? "该功能只能在运行服务的本机上使用。"
          : "请求 Host 与实际连接来源不匹配。",
      );
      return;
    }
    next();
  });
  app.use(
    // The request-delegate form, because the Origin must be checked against
    // this request's own Host — see isAllowedOrigin.
    cors((request, callback) => {
      const origin = request.headers.origin;
      if (
        !origin ||
        isAllowedOrigin(origin, networkMode(), request.headers.host ?? null)
      ) {
        callback(null, { origin: true });
        return;
      }
      callback(new Error("Only local browser origins are allowed."));
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

  const requireLoopback = (request: Request, response: Response): boolean => {
    if (isLoopbackAddress(remoteAddress(request))) return true;
    jsonError(
      response,
      403,
      "LOOPBACK_ONLY",
      "该功能只能在运行服务的本机上使用。",
    );
    return false;
  };

  /**
   * Remote peers may mutate only a LAN game through a valid seat. Ordinary
   * same-screen and AI game ids are readable public state, not bearer secrets.
   */
  const requireGameWriteAccess = (
    game: GameState,
    request: Request,
    response: Response,
  ): boolean =>
    game.matchType === "lan-human" || requireLoopback(request, response);

  app.get("/api/v1/health", (_request, response) => {
    response.json({ ok: true, apiVersion: "v1" });
  });

  app.get("/api/v1/ai/models", async (request, response) => {
    if (!requireLoopback(request, response)) return;
    response.json(await describeAiAvailability(aiProvider));
  });

  /**
   * Resolves the caller's LAN seat from its bearer token, or null when the
   * game is not a LAN game / no token was sent. Throws for a token that is
   * present but wrong, so a revoked device learns precisely what happened.
   */
  const seatOf = (game: GameState, request: Request): Color | null => {
    if (game.matchType !== "lan-human") return null;
    const token = bearerToken(request);
    if (!token) return null;
    return lanRooms.authenticate(game.id, token);
  };

  /**
   * The single projection point. A LAN game carries its room state so the
   * existing 1s poll needs no second request; every other match type is
   * projected exactly as before.
   */
  const publicGame = (
    game: GameState,
    viewer: Color | null = null,
    viewerState?: LanViewerSeatState,
  ) => {
    const projected = toPublicGame(game);
    if (game.matchType !== "lan-human") return projected;
    const room = lanRooms.project(game.id, projected, viewer);
    const credential =
      viewerState ??
      (viewer ? ({ status: "valid", color: viewer } as const) : undefined);
    return {
      ...projected,
      lan: room && credential ? { ...room, viewer: credential } : room,
    };
  };

  /** Seat enforcement for writes. Only ever applied to `lan-human` games. */
  const requireSeat = (game: GameState, request: Request): Color => {
    const token = bearerToken(request);
    if (!token) {
      throw new LanRoomError("LAN_SEAT_TOKEN_INVALID", "需要座位令牌。");
    }
    return lanRooms.authenticate(game.id, token);
  };

  const finishGame = (gameId: string) => {
    agentSessionManager.finish(gameId);
    lanRooms.finish(gameId);
  };

  app.post("/api/v1/games", async (request, response) => {
    if (!requireLoopback(request, response)) return;
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
    // Reads stay open, but a supplied credential gets an explicit projected
    // status. Occupancy alone cannot identify an old guest after a replacement
    // has claimed the same colour.
    let viewer: Color | null = null;
    let viewerState: LanViewerSeatState | undefined;
    const token = bearerToken(request);
    try {
      viewer = seatOf(game, request);
      if (viewer) viewerState = { status: "valid", color: viewer };
    } catch (error) {
      viewer = null;
      viewerState = {
        status:
          error instanceof LanRoomError && error.code === "LAN_SEAT_REVOKED"
            ? "revoked"
            : "invalid",
      };
    }
    if (viewer) lanRooms.heartbeat(game.id, viewer);
    response.json(publicGame(game, viewer, token ? viewerState : undefined));
  });

  app.get("/api/v1/network", (request, response) => {
    const status = options.networkController?.status() ?? {
      mode: networkMode(),
      targetMode: networkMode(),
      port: 0,
      addresses: [],
      error: null,
      pending: false,
      listening: true,
    };
    const local = isLoopbackAddress(remoteAddress(request));
    // A LAN guest may see whether LAN is on, never the host's other addresses.
    // `local` tells the client whether the toggle is even actionable here.
    response.json(
      local
        ? { ...status, local }
        : {
            mode: status.mode,
            targetMode: status.targetMode,
            port: 0,
            addresses: [],
            error: null,
            pending: status.pending,
            listening: status.listening,
            local,
          },
    );
  });

  app.post("/api/v1/network", (request, response) => {
    if (!requireLoopback(request, response)) return;
    const body = validate(networkModeSchema, request.body, response);
    if (!body) return;
    const controller = options.networkController;
    if (!controller) {
      jsonError(
        response,
        503,
        "NETWORK_CONTROL_UNAVAILABLE",
        "当前进程不支持切换监听地址。",
      );
      return;
    }
    // Register before writing the response so even an immediately flushed
    // response cannot miss the enqueue. The client then polls truthful state.
    response.once("finish", () => {
      controller.setMode(body.mode).catch((error: unknown) => {
        console.error("切换监听地址失败：", error);
      });
    });
    response.json({
      ...controller.status(),
      targetMode: body.mode,
      pending: true,
      local: true,
    });
  });

  app.post("/api/v1/rooms", (request, response) => {
    if (!requireLoopback(request, response)) return;
    const body = validate(createRoomSchema, request.body ?? {}, response);
    if (!body) return;
    const hostSide: Color = body.hostSide ?? (random() < 0.5 ? "red" : "black");
    // Check room capacity first: `store.create` has no counterpart to undo it,
    // so a room failure after it would strand the game until its 24h TTL.
    lanRooms.assertCapacity();
    const game = store.create({
      mode: body.mode,
      allowDraw: body.allowDraw,
      allowUndo: body.allowUndo,
      matchType: "lan-human",
      // The host is always player1; the guest takes the other colour.
      player1Side: hostSide,
      aiModel: null,
      seed: body.seed,
    });
    const seat = lanRooms.create(game.id, hostSide);
    response.status(201).json({
      game: publicGame(game, seat.color),
      roomCode: seat.roomCode,
      seat: { color: seat.color, token: seat.token },
    });
  });

  app.post("/api/v1/rooms/:code/join", (request, response) => {
    if (!validate(emptyBodySchema, request.body ?? {}, response)) return;
    const rawCode = request.params.code;
    // Join throttling keys the real socket peer. Forwarded headers are ignored.
    const seat = lanRooms.join(
      Array.isArray(rawCode) ? rawCode[0] : rawCode,
      normalizeSocketAddress(remoteAddress(request)) ?? "unknown",
    );
    const game = store.get(seat.gameId);
    if (!game) {
      throw new LanRoomError("LAN_ROOM_NOT_FOUND", "该对局已经不存在。");
    }
    response.json({
      game: publicGame(game, seat.color),
      seat: { color: seat.color, token: seat.token },
    });
  });

  app.post("/api/v1/games/:id/invite", (request, response) => {
    const game = getGameOr404(store, request, response);
    if (!game) return;
    const body = validate(reinviteSchema, request.body, response);
    if (!body) return;
    if (game.matchType !== "lan-human") {
      jsonError(response, 422, "NOT_LAN_GAME", "该对局不是局域网对战。");
      return;
    }
    const viewer = requireSeat(game, request);
    if (body.expectedRevision !== game.revision) {
      jsonError(response, 409, "STALE_REVISION", "局面已更新，请重新读取。", {
        expectedRevision: body.expectedRevision,
        actualRevision: game.revision,
      });
      return;
    }
    const roomCode = lanRooms.reinvite(game.id, viewer, body.expectedRoomCode);
    response.json({ game: publicGame(game, viewer), roomCode });
  });

  app.post("/api/v1/games/:id/undo-request", (request, response) => {
    const game = getGameOr404(store, request, response);
    if (!game) return;
    const body = validate(resignSchema, request.body, response);
    if (!body) return;
    if (game.matchType !== "lan-human") {
      jsonError(response, 422, "NOT_LAN_GAME", "该对局不是局域网对战。");
      return;
    }
    const viewer = requireSeat(game, request);
    if (body.expectedRevision !== game.revision) {
      jsonError(response, 409, "STALE_REVISION", "局面已更新，请重新读取。", {
        expectedRevision: body.expectedRevision,
        actualRevision: game.revision,
      });
      return;
    }
    // Reuse the engine's own preconditions so the button never lies.
    if (!game.allowUndo) {
      throw new GameRuleError("UNDO_DISABLED", "本局开局时已关闭悔棋。");
    }
    if (!canUndo(game)) {
      throw new GameRuleError("NO_UNDO_AVAILABLE", "当前没有可以撤回的着法。");
    }
    lanRooms.requestUndo(game.id, viewer, toPublicGame(game));
    response.status(201).json(publicGame(game, viewer));
  });

  app.post("/api/v1/games/:id/undo-request/resolve", (request, response) => {
    const game = getGameOr404(store, request, response);
    if (!game) return;
    const body = validate(undoResolveSchema, request.body, response);
    if (!body) return;
    if (game.matchType !== "lan-human") {
      jsonError(response, 422, "NOT_LAN_GAME", "该对局不是局域网对战。");
      return;
    }
    const viewer = requireSeat(game, request);
    if (body.expectedRevision !== game.revision) {
      jsonError(response, 409, "STALE_REVISION", "局面已更新，请重新读取。", {
        expectedRevision: body.expectedRevision,
        actualRevision: game.revision,
      });
      return;
    }
    // Approve-and-execute is one synchronous step, so there is never an
    // approved-but-unapplied state for a concurrent write to race against.
    const shouldUndo = lanRooms.resolveUndo(
      game.id,
      viewer,
      body.requestId,
      body.accept,
      toPublicGame(game),
    );
    const nextGame = shouldUndo ? undo(game, body.expectedRevision) : game;
    response.json(publicGame(nextGame, viewer));
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
    if (!requireGameWriteAccess(game, request, response)) return;
    const body = validate(moveSchema, request.body, response);
    if (!body) return;
    let viewer: Color | null = null;
    if (game.matchType === "lan-human") {
      viewer = requireSeat(game, request);
      // Authenticate first, then honor the revision boundary before room/turn
      // guards. Otherwise a duplicate write can become LAN_NOT_YOUR_SEAT after
      // the first request flips the turn instead of reporting STALE_REVISION.
      if (body.expectedRevision !== game.revision) {
        jsonError(response, 409, "STALE_REVISION", "局面已更新，请重新读取。", {
          expectedRevision: body.expectedRevision,
          actualRevision: game.revision,
        });
        return;
      }
      lanRooms.assertReady(game.id);
      if (viewer !== game.turn) {
        throw new LanRoomError("LAN_NOT_YOUR_SEAT", "现在不是你的回合。");
      }
    }
    const nextGame = applyMove(game, body);
    aiDecisions
      .get(game.id)
      ?.abort(new DOMException("局面已被其他写请求更新。", "AbortError"));
    if (nextGame.status.phase === "finished") {
      finishGame(game.id);
    }
    response.json(publicGame(nextGame, viewer));
  });

  app.post("/api/v1/games/:id/resign", (request, response) => {
    const game = getGameOr404(store, request, response);
    if (!game) return;
    if (!requireGameWriteAccess(game, request, response)) return;
    const body = validate(resignSchema, request.body, response);
    if (!body) return;
    const viewer =
      game.matchType === "lan-human" ? requireSeat(game, request) : null;
    const nextGame = resign(game, body.expectedRevision, viewer ?? game.turn);
    aiDecisions
      .get(game.id)
      ?.abort(new DOMException("对局已经结束。", "AbortError"));
    finishGame(game.id);
    response.json(publicGame(nextGame, viewer));
  });

  app.post("/api/v1/games/:id/undo", (request, response) => {
    const game = getGameOr404(store, request, response);
    if (!game) return;
    if (!requireGameWriteAccess(game, request, response)) return;
    const body = validate(resignSchema, request.body, response);
    if (!body) return;
    if (game.matchType === "lan-human") {
      jsonError(
        response,
        403,
        "LAN_UNDO_REQUIRES_CONSENT",
        "局域网对局的悔棋需要对手同意。",
      );
      return;
    }
    const nextGame = undo(game, body.expectedRevision);
    aiDecisions
      .get(game.id)
      ?.abort(new DOMException("局面已悔棋。", "AbortError"));
    response.json(publicGame(nextGame));
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
    // Defence in depth only: every caller already passed requireLoopback. The
    // original error code is kept because it is part of the published API.
    if (
      !isLoopbackAddress(remoteAddress(request)) ||
      !isLoopbackHostname(candidate.hostname)
    ) {
      throw new AgentSessionError(
        "AGENT_SESSION_IO_ERROR",
        "无法从非本机 Host 创建 Agent 会话。",
      );
    }
    return candidate.origin;
  };

  app.post("/api/v1/games/:id/agent-session", async (request, response) => {
    if (!requireLoopback(request, response)) return;
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
    if (!requireLoopback(request, response)) return;
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
      if (!requireLoopback(request, response)) return;
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
    if (!requireLoopback(request, response)) return;
    const game = getGameOr404(store, request, response);
    if (!game) return;
    response.json(agentSessionManager.stop(game.id));
  });

  app.get("/api/v1/games/:id/agent-session/runner", (request, response) => {
    if (!requireLoopback(request, response)) return;
    const game = getGameOr404(store, request, response);
    if (!game) return;
    response.json(
      agentSessionManager.runnerControl(game.id, bearerToken(request)),
    );
  });

  app.patch("/api/v1/games/:id/agent-session/runner", (request, response) => {
    if (!requireLoopback(request, response)) return;
    const game = getGameOr404(store, request, response);
    if (!game) return;
    const body = validate(runnerStatusSchema, request.body, response);
    if (!body) return;
    response.json(
      agentSessionManager.updateFromRunner(game.id, bearerToken(request), body),
    );
  });

  app.post("/api/v1/games/:id/ai-move", async (request, response) => {
    if (!requireLoopback(request, response)) return;
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
    if (error instanceof LanRoomError) {
      const status =
        error.code === "LAN_ROOM_NOT_FOUND"
          ? 404
          : error.code === "LAN_CODE_REVOKED"
            ? 410
            : error.code === "LAN_JOIN_THROTTLED"
              ? 429
              : error.code === "LAN_SEAT_TOKEN_INVALID" ||
                  error.code === "LAN_SEAT_REVOKED"
                ? 401
                : error.code === "LAN_NOT_YOUR_SEAT" ||
                    error.code === "LAN_CANNOT_SELF_APPROVE"
                  ? 403
                  : error.code === "CAPACITY_EXCEEDED"
                    ? 503
                    : 409;
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
    lanRooms.stopAll();
  };

  return app;
}
