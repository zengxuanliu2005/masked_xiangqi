import { z } from "zod";
import {
  DEFAULT_AI_DIFFICULTY,
  type AiDifficulty,
  type AiModelsResponse,
  type LegalMove,
  type LocalAiModel,
  type PieceIdentity,
  type PublicBoardPiece,
  type PublicGameState,
} from "../shared/contracts";
import { strategyFor } from "./ai/strategy";

export interface AiDecision {
  moveIndex: number;
  source: "model";
  note?: string;
  /** Where Ollama placed the schema-valid final decision. */
  finalSource?: OllamaContentSource;
  /** Raw fields returned by Ollama. They are useful for the local console log. */
  thinking?: string;
  content?: string;
}

export type OllamaContentSource = "content" | "thinking-fallback";

export interface ChooseMoveInput {
  game: PublicGameState;
  legalMoves: LegalMove[];
  model: string;
}

export interface ModelCapabilities {
  capabilities: string[];
  supportsThinking: boolean;
  supportsCompletion?: boolean;
  isGptOss: boolean;
}

export interface ChooseMoveOptions {
  signal?: AbortSignal;
  capabilities?: ModelCapabilities;
  correction?: string;
  onThinking?: (chunk: string) => void;
  onContent?: (chunk: string, source: OllamaContentSource) => void;
}

export interface RetryMoveOptions extends Omit<
  ChooseMoveOptions,
  "correction"
> {
  onRetry?: (error: unknown) => void;
}

export interface AiProvider {
  listModels(): Promise<LocalAiModel[]>;
  getModelCapabilities?(
    model: string,
    signal?: AbortSignal,
  ): Promise<ModelCapabilities>;
  chooseMove(
    input: ChooseMoveInput,
    options?: ChooseMoveOptions,
  ): Promise<AiDecision>;
}

export class OllamaServiceError extends Error {
  constructor(
    public readonly code:
      | "OLLAMA_UNAVAILABLE"
      | "OLLAMA_MODEL_ERROR"
      | "OLLAMA_BAD_RESPONSE"
      | "MODEL_NOT_FOUND"
      | "MODEL_NOT_GENERATIVE",
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "OllamaServiceError";
  }
}

const tagsResponseSchema = z.object({
  models: z.array(
    z.object({
      name: z.string(),
      size: z.number().optional(),
      details: z
        .object({
          family: z.string().optional(),
          parameter_size: z.string().optional(),
        })
        .optional(),
    }),
  ),
});

const showResponseSchema = z.object({
  capabilities: z.array(z.string()).optional().default([]),
  details: z
    .object({
      family: z.string().optional(),
      families: z.array(z.string()).optional(),
    })
    .optional(),
});

const streamChunkSchema = z.object({
  message: z
    .object({
      content: z.string().optional(),
      thinking: z.string().optional(),
    })
    .optional(),
  done: z.boolean().optional(),
  error: z.string().optional(),
});

const modelDecisionSchema = z
  .object({
    moveIndex: z.number().int(),
    reason: z.string().trim().min(1).max(160),
  })
  .strict();

export const decisionJsonSchema = {
  type: "object",
  properties: {
    moveIndex: { type: "integer", description: "所选合法着法的编号" },
    reason: {
      type: "string",
      maxLength: 160,
      description: "不超过一句话的选择理由",
    },
  },
  required: ["moveIndex", "reason"],
  additionalProperties: false,
} as const;

/**
 * What a difficulty tier changes. Strength comes mostly from `annotate` —
 * candidate annotations improve the model's *input* and therefore cost input
 * tokens only — rather than from a bigger generation budget, because
 * generation is what actually costs wall-clock time. Every tier's
 * `decisionTimeoutMs + correctionTimeoutMs` stays at or under 60 s so one
 * move never outruns a human's patience, retry included.
 */
export interface DifficultyProfile {
  numPredict: number;
  decisionTimeoutMs: number;
  correctionTimeoutMs: number;
  /** Skip the reasoning pass whatever the model supports. */
  suppressThinking: boolean;
  /** Annotate candidates with public-only material information. */
  annotate: boolean;
}

export const DIFFICULTY_PROFILES: Record<AiDifficulty, DifficultyProfile> = {
  easy: {
    numPredict: 64,
    decisionTimeoutMs: 20_000,
    correctionTimeoutMs: 10_000,
    suppressThinking: true,
    annotate: false,
  },
  medium: {
    numPredict: 128,
    // Unchanged from the pre-difficulty default so slow local models that
    // only just fit keep fitting; only the retry was shortened, to stay
    // inside the 60 s budget.
    decisionTimeoutMs: 45_000,
    correctionTimeoutMs: 15_000,
    suppressThinking: false,
    annotate: false,
  },
  hard: {
    numPredict: 256,
    decisionTimeoutMs: 45_000,
    correctionTimeoutMs: 15_000,
    suppressThinking: false,
    annotate: true,
  },
};

export const profileFor = (
  difficulty: AiDifficulty | null | undefined,
): DifficultyProfile =>
  DIFFICULTY_PROFILES[difficulty ?? DEFAULT_AI_DIFFICULTY];

/**
 * Public material values, keyed by the piece designation a caller is allowed
 * to see. Never call this with a covered piece's server-only true type.
 */
const PIECE_VALUES: Record<PieceIdentity["type"], number> = {
  // Capturing a general ends the game in both modes, so it has to outrank
  // every other capture. Zero would tell the model the winning move is the
  // least valuable one on the list.
  general: 1000,
  advisor: 2,
  elephant: 2,
  horse: 4,
  cannon: 4.5,
  rook: 9,
  pawn: 1,
};

const PIECE_NAMES: Record<PieceIdentity["type"], string> = {
  general: "帅将",
  advisor: "士",
  elephant: "相象",
  horse: "马",
  cannon: "炮",
  rook: "车",
  pawn: "兵卒",
};

const formatPosition = (x: number, y: number) => `(${x},${y})`;

export const buildPrompt = ({ game, legalMoves }: ChooseMoveInput): string => {
  // This projection is deliberately built from the public game contract. It
  // cannot contain an unrevealed piece's server-only true identity.
  const publicPieces = game.board.map((piece) => ({
    at: formatPosition(piece.position.x, piece.position.y),
    controller: piece.controller,
    state: piece.faceUp ? "revealed" : "covered",
    identity: piece.faceUp ? piece.identity : undefined,
    movesAs: piece.faceUp ? undefined : piece.publicIdentity,
  }));
  const annotate = profileFor(game.aiDifficulty).annotate;
  // Every annotation below is derived from the same public projection the
  // browser gets: a covered piece contributes its publicIdentity, never the
  // server-only true type. `at` is unique per square, so it keys the lookup.
  const pieceAt = new Map(
    game.board.map((piece) => [
      formatPosition(piece.position.x, piece.position.y),
      piece,
    ]),
  );
  // `identity` is optional on the wire, so fall back to the public one. That
  // direction is the safe one: it can under-describe a revealed piece, never
  // over-describe a covered one.
  const publicType = (piece: PublicBoardPiece) =>
    ((piece.faceUp ? piece.identity : undefined) ?? piece.publicIdentity).type;
  const choices = legalMoves.map((move, moveIndex) => {
    const from = formatPosition(move.from.x, move.from.y);
    const to = formatPosition(move.to.x, move.to.y);
    const base = { moveIndex, from, to, captures: move.captures };
    if (!annotate) return base;
    const target = move.captures ? pieceAt.get(to) : undefined;
    const mover = pieceAt.get(from);
    return {
      ...base,
      ...(target
        ? {
            capturesPiece: PIECE_NAMES[publicType(target)],
            capturesValue: PIECE_VALUES[publicType(target)],
          }
        : {}),
      reveals: Boolean(mover && !mover.faceUp),
    };
  });
  const modeGuidance =
    game.mode === "standard"
      ? "标准模式：服务端已排除未应将、自陷己方将帅被攻击和将帅照面的着法；列表中每一项均合法。允许并鼓励在有利时将军对方。"
      : "吃主帅模式：列表中每一项均合法，以实际吃掉对方帅或将为目标。";

  // The reasoning budget scales with the tier. `hard` gets a wider comparison
  // because the annotations give it something concrete to weigh; `easy` is
  // told to stop thinking almost immediately.
  const effortGuidance =
    game.aiDifficulty === "hard"
      ? "不要重新验证着法是否合法，不要复述规则或全部候选。挑出最多 4 个较好候选，算清它们的直接子力得失后决定。如果启用了 thinking，请把分析控制在 160 个汉字以内。"
      : game.aiDifficulty === "easy"
        ? "不要分析，不要复述规则或候选。扫一眼列表就选一个，立即决定。"
        : "不要重新验证着法是否合法，不要复述规则、棋盘或全部候选。只比较最多 3 个较好候选，然后立即决定。如果启用了 thinking，请把分析控制在 80 个汉字以内。";

  return [
    "你正在下中国象棋盲棋。请从给出的合法着法中选择一个编号。",
    "盖住的棋子只能看到位置身份（movesAs），真实身份未知；不要猜测或声称知道暗子身份。",
    modeGuidance,
    effortGuidance,
    ...(annotate
      ? [
          "候选标注只来自公开局面：capturesPiece / capturesValue 是被吃子的公开称谓与子力价值，reveals 表示这一步会翻开你自己的暗子。",
        ]
      : []),
    "红方先行，目标是在当前模式下提高胜率。",
    `当前行棋方：${game.turn}；是否被将军：${game.check === game.turn ? "是" : "否"}。`,
    `公开棋盘：${JSON.stringify(publicPieces)}`,
    `合法着法：${JSON.stringify(choices)}`,
    "返回符合 JSON Schema 的对象：moveIndex 必须是合法着法列表中的编号，reason 必须是一句简短理由。",
  ].join("\n");
};

const normalizeModelName = (value: string): string =>
  value.toLowerCase().replaceAll("_", "-").replaceAll(" ", "-");

/**
 * Current Qwen3-VL Ollama templates may place a schema-valid direct answer in
 * `message.thinking` even when think=false. Asking them for a reasoning pass
 * first only adds latency and commonly exhausts the output budget.
 */
export const prefersDirectDecision = (model: string): boolean => {
  const normalized = normalizeModelName(model);
  return normalized.includes("qwen3-vl") || normalized.includes("qwen3vl");
};

export const isGptOssModel = (
  model: string,
  families: string[] = [],
): boolean =>
  [model, ...families]
    .map(normalizeModelName)
    .some((value) => value.includes("gpt-oss") || value.includes("gptoss"));

export const thinkingOptionForModel = (
  capabilities: ModelCapabilities,
  direct = false,
  /** Turn the reasoning pass off outright, whatever the family supports. */
  suppress = false,
): true | false | "low" | "medium" | undefined => {
  if (!capabilities.supportsThinking) return undefined;
  // gpt-oss has no boolean form, so "direct" only lowers its effort. A tier
  // that promises no thinking at all has to say so explicitly.
  if (suppress) return capabilities.isGptOss ? "low" : false;
  if (capabilities.isGptOss) return direct ? "low" : "medium";
  return direct ? false : true;
};

/** The exact thinking option used for one initial or correction request. */
export const thinkingOptionForRequest = (
  input: Pick<ChooseMoveInput, "game" | "model">,
  capabilities: ModelCapabilities,
  recovering = false,
): true | false | "low" | "medium" | undefined =>
  thinkingOptionForModel(
    capabilities,
    recovering || prefersDirectDecision(input.model),
    profileFor(input.game.aiDifficulty).suppressThinking,
  );

export interface OllamaStreamResult {
  thinking: string;
  content: string;
}

export const MAX_MODEL_OUTPUT_BYTES = 256 * 1024;

/** Remove terminal escape/control sequences without changing ordinary model text. */
export const sanitizeModelText = (value: string): string =>
  value
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B[@-_]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "");

/** Parse Ollama's newline-delimited streaming chat response without buffering it first. */
export async function parseOllamaChatStream(
  response: Response,
  hooks: Pick<ChooseMoveOptions, "onThinking" | "onContent"> = {},
): Promise<OllamaStreamResult> {
  if (!response.body) {
    throw new OllamaServiceError(
      "OLLAMA_BAD_RESPONSE",
      "Ollama 没有返回可读取的流式响应。",
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let thinking = "";
  let content = "";
  let receivedBytes = 0;

  const consumeLine = (line: string) => {
    if (!line.trim()) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch {
      throw new OllamaServiceError(
        "OLLAMA_BAD_RESPONSE",
        "Ollama 返回了无法解析的流式数据。",
        { line: line.slice(0, 240) },
      );
    }
    const parsed = streamChunkSchema.safeParse(raw);
    if (!parsed.success) {
      throw new OllamaServiceError(
        "OLLAMA_BAD_RESPONSE",
        "Ollama 返回了无法识别的流式数据。",
      );
    }
    if (parsed.data.error) {
      throw new OllamaServiceError(
        "OLLAMA_MODEL_ERROR",
        "本机模型未能完成这一步。",
        { response: parsed.data.error.slice(0, 300) },
      );
    }
    const thinkingChunk = sanitizeModelText(
      parsed.data.message?.thinking ?? "",
    );
    const contentChunk = sanitizeModelText(parsed.data.message?.content ?? "");
    if (thinkingChunk) {
      thinking += thinkingChunk;
      hooks.onThinking?.(thinkingChunk);
    }
    if (contentChunk) {
      content += contentChunk;
      hooks.onContent?.(contentChunk, "content");
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    receivedBytes += value?.byteLength ?? 0;
    if (receivedBytes > MAX_MODEL_OUTPUT_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new OllamaServiceError(
        "OLLAMA_BAD_RESPONSE",
        "本机模型输出超过 256 KiB 限制。",
      );
    }
    buffer += decoder.decode(value, { stream: !done });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      consumeLine(line);
      newline = buffer.indexOf("\n");
    }
    if (done) break;
  }
  consumeLine(buffer);
  return { thinking, content };
}

export interface OllamaChatRequest {
  model: string;
  messages: Array<{ role: "system" | "user"; content: string }>;
  stream: true;
  format: typeof decisionJsonSchema;
  keep_alive: "15m";
  options: {
    temperature: 0;
    num_predict: number;
    repeat_penalty: number;
  };
  think?: true | false | "low" | "medium";
}

export const buildChatRequest = (
  input: ChooseMoveInput,
  capabilities: ModelCapabilities,
  correction?: string,
): OllamaChatRequest => {
  // `direct` is the terse schema-recovery mode. A correction retry is about
  // producing valid JSON, so it drops the strategy text and the budget. The
  // qwen3-vl quirk is different in kind — it only changes where the model puts
  // its answer — so those models keep their tier's strategy and budget and
  // merely skip the reasoning pass.
  const recovering = Boolean(correction);
  const profile = profileFor(input.game.aiDifficulty);
  const strategy = strategyFor(input.game.aiDifficulty);
  const think = thinkingOptionForRequest(input, capabilities, recovering);
  return {
    model: input.model,
    messages: [
      {
        // Only a recovery attempt gets the terse persona. Pinning it to
        // `direct` would hand qwen3-vl a "do not analyse" instruction that
        // directly contradicts the strategy text it is also being given.
        role: "system",
        content: recovering
          ? "你是快速的中国象棋盲棋选着器。不要分析或复述，立即返回一个用户提供的合法 moveIndex 和一句简短理由。"
          : "你是快速、谨慎的中国象棋盲棋对手。只选择用户提供的合法着法，不得请求或推断未公开身份。",
      },
      // The strategy file is a second system message rather than part of the
      // user turn: it is identical on every move of a game, so keeping it in
      // the stable prefix helps Ollama reuse its cache. A correction retry
      // skips it — that attempt is about producing schema-valid output, not
      // about playing better.
      ...(recovering || !strategy
        ? []
        : [{ role: "system" as const, content: strategy }]),
      { role: "user", content: buildPrompt(input) },
      ...(correction
        ? [
            {
              role: "user" as const,
              content: `上一次尝试失败：${correction}。这是最后一次快速重试；跳过分析，仅返回符合 Schema 的合法 moveIndex 和一句简短理由。`,
            },
          ]
        : []),
    ],
    stream: true,
    format: decisionJsonSchema,
    keep_alive: "15m",
    options: {
      temperature: 0,
      num_predict: recovering ? 64 : profile.numPredict,
      repeat_penalty: 1.15,
    },
    ...(think === undefined ? {} : { think }),
  };
};

const abortedError = (signal: AbortSignal): Error =>
  signal.reason instanceof Error
    ? signal.reason
    : new DOMException("请求已取消。", "AbortError");

export class OllamaClient implements AiProvider {
  private readonly baseUrl: string;
  private modelCache: { expiresAt: number; models: LocalAiModel[] } | null =
    null;
  private modelRequest: Promise<LocalAiModel[]> | null = null;

  constructor(
    baseUrl = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
  ) {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new OllamaServiceError(
        "OLLAMA_UNAVAILABLE",
        "Ollama 地址格式无效。",
      );
    }
    if (
      parsed.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "::1", "[::1]"].includes(
        parsed.hostname.toLowerCase(),
      )
    ) {
      throw new OllamaServiceError(
        "OLLAMA_UNAVAILABLE",
        "为保护本地对局，Ollama 只能使用本机 HTTP 地址。",
      );
    }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async listModels(): Promise<LocalAiModel[]> {
    if (this.modelCache && this.modelCache.expiresAt > Date.now()) {
      return structuredClone(this.modelCache.models);
    }
    if (this.modelRequest) return structuredClone(await this.modelRequest);
    this.modelRequest = this.fetchModels();
    try {
      const models = await this.modelRequest;
      this.modelCache = { expiresAt: Date.now() + 30_000, models };
      return structuredClone(models);
    } finally {
      this.modelRequest = null;
    }
  }

  private async fetchModels(): Promise<LocalAiModel[]> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(2_000),
      });
    } catch (error) {
      throw new OllamaServiceError(
        "OLLAMA_UNAVAILABLE",
        "未检测到本机 Ollama 服务。启动 Ollama 后即可使用人机对战。",
        error instanceof Error ? error.message : undefined,
      );
    }
    if (!response.ok) {
      throw new OllamaServiceError(
        "OLLAMA_UNAVAILABLE",
        "本机 Ollama 暂时无法读取模型列表。",
        { status: response.status },
      );
    }
    const payload = await response.json().catch(() => undefined);
    const parsed = tagsResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new OllamaServiceError(
        "OLLAMA_BAD_RESPONSE",
        "Ollama 返回了无法识别的模型列表。",
      );
    }

    const source = parsed.data.models;
    const results: LocalAiModel[] = new Array(source.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < source.length) {
        const index = cursor;
        cursor += 1;
        const model = source[index];
        let capabilities: ModelCapabilities | undefined;
        try {
          capabilities = await this.getModelCapabilities(model.name);
        } catch {
          // Older Ollama versions may not expose capabilities. Listing models
          // still succeeds and the runner conservatively disables thinking.
        }
        results[index] = {
          name: model.name,
          ...(model.size === undefined ? {} : { size: model.size }),
          ...(model.details?.family ? { family: model.details.family } : {}),
          ...(model.details?.parameter_size
            ? { parameterSize: model.details.parameter_size }
            : {}),
          ...(capabilities
            ? {
                capabilities: capabilities.capabilities,
                supportsThinking: capabilities.supportsThinking,
                ...(capabilities.supportsCompletion === undefined
                  ? {}
                  : {
                      supportsCompletion: capabilities.supportsCompletion,
                    }),
              }
            : {}),
        };
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(4, source.length) }, () => worker()),
    );
    return results;
  }

  async getModelCapabilities(
    model: string,
    signal?: AbortSignal,
  ): Promise<ModelCapabilities> {
    let response: Response;
    const timeout = AbortSignal.timeout(5_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      response = await fetch(`${this.baseUrl}/api/show`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model }),
        signal: requestSignal,
      });
    } catch (error) {
      if (signal?.aborted) throw abortedError(signal);
      throw new OllamaServiceError(
        "OLLAMA_UNAVAILABLE",
        "无法读取本机模型能力。",
        error instanceof Error ? error.message : undefined,
      );
    }
    if (!response.ok) {
      throw new OllamaServiceError(
        "OLLAMA_MODEL_ERROR",
        "Ollama 未能返回模型能力。",
        { status: response.status },
      );
    }
    const parsed = showResponseSchema.safeParse(
      await response.json().catch(() => undefined),
    );
    if (!parsed.success) {
      throw new OllamaServiceError(
        "OLLAMA_BAD_RESPONSE",
        "Ollama 返回了无法识别的模型能力。",
      );
    }
    const families = [
      ...(parsed.data.details?.family ? [parsed.data.details.family] : []),
      ...(parsed.data.details?.families ?? []),
    ];
    const capabilities = parsed.data.capabilities;
    return {
      capabilities,
      supportsThinking: capabilities.includes("thinking"),
      supportsCompletion:
        capabilities.length === 0
          ? undefined
          : capabilities.includes("completion"),
      isGptOss: isGptOssModel(model, families),
    };
  }

  async chooseMove(
    input: ChooseMoveInput,
    options: ChooseMoveOptions = {},
  ): Promise<AiDecision> {
    if (input.legalMoves.length === 0) {
      throw new OllamaServiceError(
        "OLLAMA_MODEL_ERROR",
        "当前没有可供模型选择的着法。",
      );
    }
    if (options.signal?.aborted) throw abortedError(options.signal);

    let capabilities = options.capabilities;
    if (!capabilities) {
      try {
        capabilities = await this.getModelCapabilities(
          input.model,
          options.signal,
        );
      } catch (_error) {
        if (options.signal?.aborted) throw abortedError(options.signal);
        capabilities = {
          capabilities: [],
          supportsThinking: false,
          isGptOss: isGptOssModel(input.model),
        };
      }
    }

    let response: Response;
    const profile = profileFor(input.game.aiDifficulty);
    const decisionTimeoutMs = options.correction
      ? profile.correctionTimeoutMs
      : profile.decisionTimeoutMs;
    const timeout = AbortSignal.timeout(decisionTimeoutMs);
    const requestSignal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;
    const chatRequest = buildChatRequest(
      input,
      capabilities,
      options.correction,
    );
    const streamsThinking =
      chatRequest.think === true ||
      chatRequest.think === "low" ||
      chatRequest.think === "medium";
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(chatRequest),
        signal: requestSignal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw abortedError(options.signal);
      if (timeout.aborted) {
        throw new OllamaServiceError(
          "OLLAMA_MODEL_ERROR",
          `本机模型未在 ${decisionTimeoutMs / 1_000} 秒的快速决策时限内完成。`,
        );
      }
      throw new OllamaServiceError(
        "OLLAMA_UNAVAILABLE",
        "无法连接本机模型，请确认 Ollama 正在运行。",
        error instanceof Error ? error.message : undefined,
      );
    }

    if (!response.ok) {
      const responseText = await response.text().catch(() => "");
      throw new OllamaServiceError(
        "OLLAMA_MODEL_ERROR",
        "本机模型未能完成这一步，请检查所选模型。",
        { status: response.status, response: responseText.slice(0, 300) },
      );
    }

    let streamed: OllamaStreamResult;
    try {
      streamed = await parseOllamaChatStream(response, {
        onThinking: streamsThinking ? options.onThinking : undefined,
        onContent: options.onContent,
      });
    } catch (error) {
      if (options.signal?.aborted) throw abortedError(options.signal);
      if (timeout.aborted) {
        throw new OllamaServiceError(
          "OLLAMA_MODEL_ERROR",
          `本机模型未在 ${decisionTimeoutMs / 1_000} 秒的快速决策时限内完成。`,
        );
      }
      throw error;
    }
    let decision: z.infer<typeof modelDecisionSchema>;
    // Some Qwen-VL templates return a direct, schema-valid answer in
    // `message.thinking` even when think=false, leaving content empty. Accept
    // only the entire thinking field in that narrow case; never extract or
    // infer a move from free-form reasoning.
    const contentPayload = streamed.content.trim();
    const decisionPayload = contentPayload || streamed.thinking.trim();
    const finalSource: OllamaContentSource = contentPayload
      ? "content"
      : "thinking-fallback";
    try {
      decision = modelDecisionSchema.parse(
        JSON.parse(decisionPayload) as unknown,
      );
    } catch (error) {
      throw new OllamaServiceError(
        "OLLAMA_BAD_RESPONSE",
        "本机模型没有返回有效的结构化着法。",
        {
          response: decisionPayload.slice(0, 300),
          validation: error instanceof Error ? error.message : undefined,
        },
      );
    }
    if (
      decision.moveIndex < 0 ||
      decision.moveIndex >= input.legalMoves.length
    ) {
      throw new OllamaServiceError(
        "OLLAMA_BAD_RESPONSE",
        "本机模型选择了不存在的着法。",
        {
          moveIndex: decision.moveIndex,
          legalMoveCount: input.legalMoves.length,
        },
      );
    }
    if (finalSource === "thinking-fallback") {
      options.onContent?.(streamed.thinking, finalSource);
    }
    return {
      moveIndex: decision.moveIndex,
      source: "model",
      note: decision.reason,
      finalSource,
      ...(streamed.thinking ? { thinking: streamed.thinking } : {}),
      content: streamed.content,
    };
  }
}

const errorSummary = (error: unknown): string =>
  error instanceof Error ? error.message.slice(0, 220) : "请求失败";

/** Execute one correction retry. Failure after the second attempt is final. */
export async function chooseMoveWithRetry(
  provider: AiProvider,
  input: ChooseMoveInput,
  options: RetryMoveOptions = {},
): Promise<AiDecision> {
  const { onRetry, ...requestOptions } = options;
  let firstError: unknown;
  try {
    return await provider.chooseMove(input, requestOptions);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    firstError = error;
    onRetry?.(error);
  }
  return provider.chooseMove(input, {
    ...requestOptions,
    correction: errorSummary(firstError),
  });
}

export async function describeAiAvailability(
  provider: AiProvider,
): Promise<AiModelsResponse> {
  try {
    const models = await provider.listModels();
    const generativeCount = models.filter(
      (model) => model.supportsCompletion !== false,
    ).length;
    return {
      provider: "ollama",
      available: generativeCount > 0,
      models,
      message:
        generativeCount > 0
          ? `已发现 ${generativeCount} 个可用于对弈的本机模型。`
          : models.length > 0
            ? "已连接 Ollama，但现有模型仅支持 embedding，不能用于对弈。"
            : "Ollama 已连接，但尚未安装本地模型。",
    };
  } catch (error) {
    return {
      provider: "ollama",
      available: false,
      models: [],
      message:
        error instanceof OllamaServiceError
          ? error.message
          : "未检测到本机 Ollama 服务。",
    };
  }
}
