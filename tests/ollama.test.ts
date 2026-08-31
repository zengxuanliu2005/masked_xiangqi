import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicGameState } from "../shared/contracts";
import {
  buildChatRequest,
  chooseMoveWithRetry,
  describeAiAvailability,
  MAX_MODEL_OUTPUT_BYTES,
  OllamaClient,
  OllamaServiceError,
  parseOllamaChatStream,
  prefersDirectDecision,
  thinkingOptionForModel,
  type AiProvider,
} from "../server/ollama";

const publicGame: PublicGameState = {
  id: "ai-game",
  seed: null,
  mode: "standard",
  allowDraw: true,
  allowUndo: true,
  canUndo: false,
  matchType: "human-ai",
  aiModel: "local-model",
  revision: 0,
  turn: "red",
  moveNumber: 0,
  players: { player1: "black", player2: "red" },
  status: { phase: "active", winner: null, reason: null },
  check: null,
  board: [
    {
      id: "covered",
      position: { x: 0, y: 6 },
      faceUp: false,
      publicIdentity: { color: "red", type: "pawn" },
      controller: "red",
    },
  ],
  captured: { red: [], black: [] },
  lastMove: null,
  createdAt: "2026-08-30T00:00:00.000Z",
};

const legalMoves = [
  {
    pieceId: "covered",
    from: { x: 0, y: 6 },
    to: { x: 0, y: 5 },
    captures: false,
  },
];

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });

const streamResponse = (...payloads: unknown[]) =>
  new Response(
    `${payloads.map((payload) => JSON.stringify(payload)).join("\n")}\n`,
    {
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
    },
  );

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Ollama 适配器", () => {
  it("读取模型列表并通过 /api/show 归一化 thinking 能力", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/tags")) {
          return jsonResponse({
            models: [
              {
                name: "qwen-local:latest",
                size: 1234,
                details: { family: "qwen", parameter_size: "7B" },
              },
            ],
          });
        }
        return jsonResponse({ capabilities: ["completion", "thinking"] });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const models = await new OllamaClient(
      "http://127.0.0.1:11434/",
    ).listModels();
    expect(models).toEqual([
      {
        name: "qwen-local:latest",
        size: 1234,
        family: "qwen",
        parameterSize: "7B",
        capabilities: ["completion", "thinking"],
        supportsThinking: true,
        supportsCompletion: true,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/show",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ model: "qwen-local:latest" }),
      }),
    );
  });

  it("模型目录 30 秒内复用 single-flight 缓存且能力查询并发不超过 4", async () => {
    let tagCalls = 0;
    let showCalls = 0;
    let activeShows = 0;
    let maxActiveShows = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/tags")) {
        tagCalls += 1;
        return jsonResponse({
          models: Array.from({ length: 9 }, (_, index) => ({
            name: `model-${index}`,
          })),
        });
      }
      showCalls += 1;
      activeShows += 1;
      maxActiveShows = Math.max(maxActiveShows, activeShows);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeShows -= 1;
      return jsonResponse({ capabilities: ["completion"] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new OllamaClient();

    const [first, concurrent] = await Promise.all([
      client.listModels(),
      client.listModels(),
    ]);
    first[0].name = "mutated-by-caller";
    const cached = await client.listModels();

    expect(tagCalls).toBe(1);
    expect(showCalls).toBe(9);
    expect(maxActiveShows).toBeLessThanOrEqual(4);
    expect(concurrent).toHaveLength(9);
    expect(cached[0].name).toBe("model-0");
  });

  it("能力字段为空时保持生成能力未知，不伪装为 embedding 或 thinking", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith("/api/tags")
          ? jsonResponse({ models: [{ name: "legacy-model" }] })
          : jsonResponse({}),
      ),
    );

    const [model] = await new OllamaClient().listModels();

    expect(model).toMatchObject({
      name: "legacy-model",
      capabilities: [],
      supportsThinking: false,
    });
    expect(model).not.toHaveProperty("supportsCompletion");
  });

  it("Ollama 未启动时把检测结果降级为可读的 unavailable 状态", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );
    const client = new OllamaClient();

    await expect(client.listModels()).rejects.toBeInstanceOf(
      OllamaServiceError,
    );
    await expect(describeAiAvailability(client)).resolves.toMatchObject({
      provider: "ollama",
      available: false,
      models: [],
    });
  });

  it("拒绝把模型请求发送到非本机地址", () => {
    expect(() => new OllamaClient("https://models.example.com")).toThrow(
      "Ollama 只能使用本机 HTTP 地址",
    );
  });

  it("逐块分流原始 thinking 与最终 JSON，并只发送公开局面", async () => {
    const thinkingChunks: string[] = [];
    const finalChunks: Array<[string, string]> = [];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/show")) {
          return jsonResponse({ capabilities: ["completion", "thinking"] });
        }
        return streamResponse(
          { message: { thinking: "先看" }, done: false },
          { message: { thinking: "局面。" }, done: false },
          {
            message: {
              content: JSON.stringify({ moveIndex: 0, reason: "稳健推进。" }),
            },
            done: false,
          },
          { message: {}, done: true },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const decision = await new OllamaClient().chooseMove(
      { game: publicGame, legalMoves, model: "local-model" },
      {
        onThinking: (chunk) => thinkingChunks.push(chunk),
        onContent: (chunk, source) => finalChunks.push([chunk, source]),
      },
    );
    expect(decision).toMatchObject({
      moveIndex: 0,
      source: "model",
      note: "稳健推进。",
      thinking: "先看局面。",
      finalSource: "content",
    });
    expect(thinkingChunks).toEqual(["先看", "局面。"]); // actual streamed chunks
    expect(finalChunks).toEqual([
      ['{"moveIndex":0,"reason":"稳健推进。"}', "content"],
    ]);

    const chatCall = fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith("/api/chat"),
    )!;
    const body = JSON.parse(String(chatCall[1]?.body)) as {
      stream: boolean;
      format: unknown;
      think?: unknown;
      keep_alive?: unknown;
      options: {
        temperature: number;
        num_predict: number;
        repeat_penalty: number;
      };
      messages: Array<{ content: string }>;
    };
    expect(body).toMatchObject({ stream: true, think: true });
    expect(body).not.toHaveProperty("tools");
    expect(body.options.temperature).toBe(0);
    expect(body.options.num_predict).toBe(128);
    expect(body.options.repeat_penalty).toBe(1.15);
    expect(body.keep_alive).toBe("15m");
    expect(body.format).toMatchObject({
      required: ["moveIndex", "reason"],
    });
    expect(JSON.stringify(body.messages)).not.toContain("trueIdentity");
    expect(JSON.stringify(body.messages)).not.toContain('"identity"');
    expect(JSON.stringify(body.messages)).toContain("movesAs");
  });

  it("不支持 thinking 时省略 think 参数，不伪造输出", async () => {
    const request = buildChatRequest(
      { game: publicGame, legalMoves, model: "plain-model" },
      {
        capabilities: ["completion"],
        supportsThinking: false,
        isGptOss: false,
      },
    );
    expect(request).not.toHaveProperty("think");

    const parsed = await parseOllamaChatStream(
      streamResponse({ message: { content: '{"moveIndex":0}' }, done: true }),
    );
    expect(parsed).toEqual({ thinking: "", content: '{"moveIndex":0}' });
  });

  it("流式模型输出超过 256 KiB 时取消读取并返回模型异常", async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_MODEL_OUTPUT_BYTES + 1));
      },
      cancel() {
        canceled = true;
      },
    });

    await expect(parseOllamaChatStream(new Response(stream))).rejects.toEqual(
      expect.objectContaining({
        code: "OLLAMA_BAD_RESPONSE",
        message: "本机模型输出超过 256 KiB 限制。",
      }),
    );
    expect(canceled).toBe(true);
  });

  it("GPT-OSS 使用 medium，而其他 thinking 模型使用 true", () => {
    expect(
      thinkingOptionForModel({
        capabilities: ["thinking"],
        supportsThinking: true,
        isGptOss: true,
      }),
    ).toBe("medium");
    expect(
      thinkingOptionForModel({
        capabilities: ["thinking"],
        supportsThinking: true,
        isGptOss: false,
      }),
    ).toBe(true);
  });

  it("纠错重试关闭普通 thinking、压缩生成预算，GPT-OSS 则降到 low", () => {
    const input = { game: publicGame, legalMoves, model: "local-model" };
    const direct = buildChatRequest(
      input,
      { capabilities: ["thinking"], supportsThinking: true, isGptOss: false },
      "上次输出无效",
    );
    expect(direct.think).toBe(false);
    expect(direct.options.num_predict).toBe(64);
    expect(direct.messages.at(-1)?.content).toContain("跳过分析");

    expect(
      thinkingOptionForModel(
        {
          capabilities: ["thinking"],
          supportsThinking: true,
          isGptOss: true,
        },
        true,
      ),
    ).toBe("low");
  });

  it("Qwen3-VL 首轮直接决策，避免无效的长 thinking", () => {
    expect(prefersDirectDecision("qwen3-vl:4b")).toBe(true);
    expect(prefersDirectDecision("QWEN3VL:8B")).toBe(true);
    expect(prefersDirectDecision("qwen3:8b")).toBe(false);

    const request = buildChatRequest(
      { game: publicGame, legalMoves, model: "qwen3-vl:4b" },
      { capabilities: ["thinking"], supportsThinking: true, isGptOss: false },
    );
    expect(request.think).toBe(false);
    expect(request.options.num_predict).toBe(64);
    expect(request.messages[0].content).toContain("立即返回");
  });

  it("content 为空时兼容 Qwen-VL 放在 thinking 中的严格 JSON 决定", async () => {
    const thinkingChunks: string[] = [];
    const finalChunks: Array<[string, string]> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/show")) {
        return jsonResponse({ capabilities: ["completion", "thinking"] });
      }
      return streamResponse({
        message: {
          thinking: JSON.stringify({ moveIndex: 0, reason: "直接推进。" }),
          content: "",
        },
        done: true,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new OllamaClient().chooseMove(
        { game: publicGame, legalMoves, model: "qwen3-vl:4b" },
        {
          onThinking: (chunk) => thinkingChunks.push(chunk),
          onContent: (chunk, source) => finalChunks.push([chunk, source]),
        },
      ),
    ).resolves.toMatchObject({
      moveIndex: 0,
      note: "直接推进。",
      finalSource: "thinking-fallback",
      thinking: '{"moveIndex":0,"reason":"直接推进。"}',
      content: "",
    });
    expect(thinkingChunks).toEqual([]);
    expect(finalChunks).toEqual([
      ['{"moveIndex":0,"reason":"直接推进。"}', "thinking-fallback"],
    ]);
  });

  it("缺少理由时按无效结构处理，并通过唯一一次纠错补全", async () => {
    let chatCalls = 0;
    const fetchMock = vi.fn(async () => {
      chatCalls += 1;
      return streamResponse({
        message: {
          content:
            chatCalls === 1
              ? '{"moveIndex":0}'
              : '{"moveIndex":0,"reason":"补全简短理由。"}',
        },
        done: true,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      chooseMoveWithRetry(
        new OllamaClient(),
        { game: publicGame, legalMoves, model: "plain-model" },
        {
          capabilities: {
            capabilities: ["completion"],
            supportsThinking: false,
            isGptOss: false,
          },
        },
      ),
    ).resolves.toMatchObject({
      moveIndex: 0,
      note: "补全简短理由。",
      finalSource: "content",
    });
    expect(chatCalls).toBe(2);
  });

  it("无效 JSON 或越界编号不会随机落子，只纠错重试一次", async () => {
    const chooseMove = vi
      .fn<AiProvider["chooseMove"]>()
      .mockRejectedValueOnce(
        new OllamaServiceError("OLLAMA_BAD_RESPONSE", "编号越界"),
      )
      .mockRejectedValueOnce(
        new OllamaServiceError("OLLAMA_BAD_RESPONSE", "仍然越界"),
      );
    const provider: AiProvider = {
      listModels: vi.fn(async () => []),
      chooseMove,
    };

    await expect(
      chooseMoveWithRetry(provider, {
        game: publicGame,
        legalMoves,
        model: "local-model",
      }),
    ).rejects.toMatchObject({ code: "OLLAMA_BAD_RESPONSE" });
    expect(chooseMove).toHaveBeenCalledTimes(2);
    expect(chooseMove.mock.calls[1][1]).toMatchObject({
      correction: "编号越界",
    });
  });
});
