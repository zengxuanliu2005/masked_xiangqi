import { describe, expect, it, vi } from "vitest";
import type {
  AgentSessionStatus,
  LegalMove,
  PublicGameState,
} from "../shared/contracts";
import { AgentRunner } from "../server/agent/runner";
import {
  RunnerHttpError,
  type AgentRunnerApi,
} from "../server/agent/http-client";
import { MemoryAgentLogger } from "../server/agent/jsonl";
import { MemoryAgentReporter } from "../server/agent/reporter";
import {
  OllamaServiceError,
  type AiProvider,
  type ChooseMoveOptions,
} from "../server/ollama";

const move: LegalMove = {
  pieceId: "covered",
  from: { x: 0, y: 6 },
  to: { x: 0, y: 5 },
  captures: false,
};

const gameState = (
  overrides: Partial<PublicGameState> = {},
): PublicGameState => ({
  id: "runner-game",
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
  ...overrides,
});

interface FakeApiOptions {
  game?: PublicGameState;
  afterMove?: PublicGameState;
  getControl?: () => Promise<{
    stopRequested: boolean;
    status: AgentSessionStatus;
  }>;
  getGame?: () => Promise<PublicGameState>;
  submitMove?: AgentRunnerApi["submitMove"];
}

const fakeApi = (options: FakeApiOptions = {}) => {
  let currentGame = options.game ?? gameState();
  const statuses: Array<{ status: AgentSessionStatus; error?: string | null }> =
    [];
  const submitted: Array<{ move: LegalMove; revision: number }> = [];
  const api: AgentRunnerApi = {
    getControl:
      options.getControl ??
      vi.fn(async () => ({
        stopRequested: false,
        status: "starting" as const,
      })),
    getGame: options.getGame ?? vi.fn(async () => currentGame),
    getLegalMoves: vi.fn(async () => ({
      gameId: currentGame.id,
      revision: currentGame.revision,
      turn: currentGame.turn,
      moves: [move],
    })),
    submitMove:
      options.submitMove ??
      vi.fn(async (selected, revision) => {
        submitted.push({ move: selected, revision });
        currentGame =
          options.afterMove ??
          gameState({
            revision: revision + 1,
            moveNumber: 1,
            turn: "black",
            status: {
              phase: "finished",
              winner: "red",
              reason: "general-captured",
            },
            lastMove: {
              pieceId: selected.pieceId,
              from: selected.from,
              to: selected.to,
            },
          });
        return currentGame;
      }),
    updateStatus: vi.fn(async (status, error) => {
      statuses.push({ status, error });
    }),
  };
  return { api, statuses, submitted };
};

const provider = (
  chooseMove: AiProvider["chooseMove"] = vi.fn(async () => ({
    moveIndex: 0,
    source: "model" as const,
    note: "测试选择",
    content: '{"moveIndex":0,"reason":"测试选择"}',
  })),
): AiProvider => ({
  listModels: vi.fn(async () => []),
  getModelCapabilities: vi.fn(async () => ({
    capabilities: ["completion"],
    supportsThinking: false,
    isGptOss: false,
  })),
  chooseMove,
});

const run = async (
  api: AgentRunnerApi,
  aiProvider: AiProvider,
  options: {
    maxServerFailures?: number;
    signal?: AbortSignal;
    pollIntervalMs?: number;
    now?: () => Date;
    sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  } = {},
) => {
  const logger = new MemoryAgentLogger();
  const reporter = new MemoryAgentReporter();
  const runner = new AgentRunner({
    api,
    aiProvider,
    logger,
    reporter,
    pollIntervalMs: options.pollIntervalMs ?? 1,
    maxServerFailures: options.maxServerFailures,
    signal: options.signal,
    now: options.now,
    sleep: options.sleep,
  });
  return {
    result: await runner.run(),
    logger,
    reporter,
  };
};

describe("独立 Agent Runner", () => {
  it("AI 分到红方时立即读取合法着法、提交并记录终局", async () => {
    const { api, statuses, submitted } = fakeApi();
    const execution = await run(api, provider());

    expect(execution.result).toBe("finished");
    expect(submitted).toEqual([{ move, revision: 0 }]);
    expect(statuses.map(({ status }) => status)).toEqual(
      expect.arrayContaining(["thinking", "submitting", "finished"]),
    );
    expect(execution.reporter.output).toContain("[候选] 共 1 个合法着法");
    expect(execution.reporter.output).toContain("[提交] 成功");
    expect(
      execution.logger.records.some(({ event }) => event === "game_finished"),
    ).toBe(true);
    expect(JSON.stringify(execution.logger.records)).not.toContain(
      "trueIdentity",
    );
  });

  it("依次原样输出模型 thinking、final 与可读选择摘要", async () => {
    const { api } = fakeApi();
    const aiProvider = provider(
      vi.fn(async (_input, options) => {
        options?.onThinking?.("先看公开局面。");
        options?.onContent?.(
          '{"moveIndex":0,"reason":"稳健推进。"}',
          "content",
        );
        return {
          moveIndex: 0,
          source: "model" as const,
          note: "稳健推进。",
          finalSource: "content" as const,
          thinking: "先看公开局面。",
          content: '{"moveIndex":0,"reason":"稳健推进。"}',
        };
      }),
    );
    aiProvider.getModelCapabilities = vi.fn(async () => ({
      capabilities: ["completion", "thinking"],
      supportsThinking: true,
      isGptOss: false,
    }));

    const execution = await run(api, aiProvider);
    const output = execution.reporter.output;

    expect(output).toContain(
      "[Ollama thinking · 模型原始文本（已移除终端控制字符）]",
    );
    expect(output).toContain(
      "[Ollama final · 模型原始文本（已移除终端控制字符）]",
    );
    expect(output.indexOf("先看公开局面。")).toBeLessThan(
      output.indexOf('{"moveIndex":0,"reason":"稳健推进。"}'),
    );
    expect(
      output.indexOf('{"moveIndex":0,"reason":"稳健推进。"}'),
    ).toBeLessThan(output.indexOf("[选择] #0"));
    expect(output).toContain("[理由] 稳健推进。");
    expect(
      execution.logger.records.find(({ event }) => event === "model_response"),
    ).toMatchObject({ finalSource: "content" });
  });

  it("把 Qwen 放在 thinking 字段的结构化决定标为兼容 final", async () => {
    const { api } = fakeApi();
    const rawDecision = '{"moveIndex":0,"reason":"直接推进。"}';
    const aiProvider = provider(
      vi.fn(async (_input, options) => {
        options?.onContent?.(rawDecision, "thinking-fallback");
        return {
          moveIndex: 0,
          source: "model" as const,
          note: "直接推进。",
          finalSource: "thinking-fallback" as const,
          thinking: rawDecision,
          content: "",
        };
      }),
    );

    const execution = await run(api, aiProvider);

    expect(execution.reporter.output).toContain(
      "[Ollama final · 模型原始文本（已移除终端控制字符，thinking 兼容通道）]",
    );
    expect(execution.reporter.output).toContain(rawDecision);
    expect(execution.reporter.output).not.toContain(
      "[Ollama thinking · 模型原始文本（已移除终端控制字符）]",
    );
    expect(execution.reporter.output).toContain("[理由] 直接推进。");
    expect(
      execution.logger.records.find(({ event }) => event === "model_response"),
    ).toMatchObject({
      finalSource: "thinking-fallback",
      thinking: rawDecision,
      content: "",
    });
  });

  it("人类回合只等待，不调用模型", async () => {
    let controlCalls = 0;
    const humanGame = gameState({
      turn: "red",
      players: { player1: "red", player2: "black" },
    });
    const { api, statuses, submitted } = fakeApi({
      game: humanGame,
      getControl: vi.fn(async () => ({
        stopRequested: ++controlCalls > 1,
        status: "waiting-human" as const,
      })),
    });
    const chooseMove = vi.fn<AiProvider["chooseMove"]>();

    const execution = await run(api, provider(chooseMove));

    expect(execution.result).toBe("stopped");
    expect(chooseMove).not.toHaveBeenCalled();
    expect(submitted).toHaveLength(0);
    expect(statuses.some(({ status }) => status === "waiting-human")).toBe(
      true,
    );
  });

  it("假时钟等待人类超过一小时仍只打印一次未变化的状态", async () => {
    let controlCalls = 0;
    let elapsedMs = 0;
    const baseTime = new Date("2026-08-31T00:00:00.000Z").getTime();
    const humanGame = gameState({
      turn: "red",
      players: { player1: "red", player2: "black" },
    });
    const { api } = fakeApi({
      game: humanGame,
      getControl: vi.fn(async () => ({
        stopRequested: ++controlCalls > 4_801,
        status: "waiting-human" as const,
      })),
    });
    const chooseMove = vi.fn<AiProvider["chooseMove"]>();

    const execution = await run(api, provider(chooseMove), {
      pollIntervalMs: 750,
      now: () => new Date(baseTime + elapsedMs),
      sleep: async (milliseconds) => {
        elapsedMs += milliseconds;
      },
    });

    expect(execution.result).toBe("stopped");
    expect(elapsedMs).toBeGreaterThanOrEqual(60 * 60 * 1_000);
    expect(
      execution.reporter.output.match(/\[等待\] 现在是人类回合。/g),
    ).toHaveLength(1);
    expect(chooseMove).not.toHaveBeenCalled();
  });

  it("模型格式错误时纠错一次，第二次有效才提交", async () => {
    const { api, submitted } = fakeApi();
    const chooseMove = vi
      .fn<AiProvider["chooseMove"]>()
      .mockImplementationOnce(async (_input, options) => {
        options?.onContent?.('{"moveIndex":0}', "content");
        throw new OllamaServiceError("OLLAMA_BAD_RESPONSE", "invalid JSON");
      })
      .mockImplementationOnce(async (_input, options) => {
        options?.onContent?.('{"moveIndex":0,"reason":"修正完成"}', "content");
        return {
          moveIndex: 0,
          source: "model",
          note: "修正完成",
          finalSource: "content",
          content: '{"moveIndex":0,"reason":"修正完成"}',
        };
      });

    const execution = await run(api, provider(chooseMove));

    expect(execution.result).toBe("finished");
    expect(chooseMove).toHaveBeenCalledTimes(2);
    expect(chooseMove.mock.calls[1][1]).toMatchObject({
      correction: "invalid JSON",
    });
    expect(submitted).toHaveLength(1);
    expect(execution.reporter.output).toContain("纠错重试 1/1");
    expect(execution.reporter.output).toContain(
      '{"moveIndex":0}\n[纠错重试 1/1] invalid JSON',
    );
    expect(
      execution.reporter.output.match(
        /\[Ollama final · 模型原始文本（已移除终端控制字符）\]/g,
      ),
    ).toHaveLength(2);
  });

  it("第二次模型失败后暂停，绝不随机落子", async () => {
    const { api, statuses, submitted } = fakeApi();
    const chooseMove = vi.fn<AiProvider["chooseMove"]>(async () => {
      throw new OllamaServiceError("OLLAMA_BAD_RESPONSE", "still invalid");
    });

    const execution = await run(api, provider(chooseMove));

    expect(execution.result).toBe("paused");
    expect(chooseMove).toHaveBeenCalledTimes(2);
    expect(submitted).toHaveLength(0);
    expect(statuses.at(-1)).toMatchObject({
      status: "paused",
      error: "still invalid",
    });
    expect(execution.reporter.output).toContain("不会随机代走");
  });

  it("思考期间 revision 变化会 Abort 旧请求并重新读取", async () => {
    const original = gameState();
    const undone = gameState({
      revision: 2,
      turn: "black",
      players: { player1: "black", player2: "red" },
    });
    let controlCalls = 0;
    let gameCalls = 0;
    const { api, submitted } = fakeApi({
      getControl: vi.fn(async () => ({
        stopRequested: ++controlCalls >= 3,
        status: "thinking" as const,
      })),
      getGame: vi.fn(async () => (++gameCalls === 1 ? original : undone)),
    });
    let receivedSignal: AbortSignal | undefined;
    const chooseMove = vi.fn(
      async (
        _input: Parameters<AiProvider["chooseMove"]>[0],
        options?: ChooseMoveOptions,
      ) => {
        receivedSignal = options?.signal;
        return new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
        });
      },
    );

    const execution = await run(api, provider(chooseMove));

    expect(execution.result).toBe("stopped");
    expect(receivedSignal?.aborted).toBe(true);
    expect(chooseMove).toHaveBeenCalledTimes(1);
    expect(submitted).toHaveLength(0);
    expect(execution.reporter.output).toContain("丢弃旧决定");
  });

  it("提交前收到停止请求时取消决定且不提交旧着法", async () => {
    let controlCalls = 0;
    const submitMove = vi.fn<AgentRunnerApi["submitMove"]>(async () => {
      throw new RunnerHttpError(409, "STALE_REVISION", "stale");
    });
    const { api } = fakeApi({
      getControl: vi.fn(async () => ({
        stopRequested: ++controlCalls >= 2,
        status: "submitting" as const,
      })),
      submitMove,
    });

    const execution = await run(api, provider());

    expect(execution.result).toBe("stopped");
    expect(submitMove).not.toHaveBeenCalled();
  });

  it("连续服务端断开达到阈值后自动退出", async () => {
    const api = {
      getControl: vi.fn(async () => {
        throw new RunnerHttpError(0, "NETWORK_ERROR", "server down");
      }),
      getGame: vi.fn(),
      getLegalMoves: vi.fn(),
      submitMove: vi.fn(),
      updateStatus: vi.fn(async () => {
        throw new RunnerHttpError(0, "NETWORK_ERROR", "server down");
      }),
    } as unknown as AgentRunnerApi;

    const execution = await run(api, provider(), { maxServerFailures: 3 });

    expect(execution.result).toBe("exited");
    expect(api.getControl).toHaveBeenCalledTimes(3);
    expect(execution.reporter.output).toContain("API 断开 3/3");
  });

  it("吃子与终局信息写入公开日志", async () => {
    const capturedPiece = {
      id: "target",
      identity: { color: "black" as const, type: "horse" as const },
      publicIdentity: { color: "black" as const, type: "pawn" as const },
      capturedBy: "red" as const,
      moveNumber: 1,
    };
    const afterMove = gameState({
      revision: 1,
      moveNumber: 1,
      status: {
        phase: "finished",
        winner: "red",
        reason: "general-captured",
      },
      lastMove: {
        pieceId: move.pieceId,
        from: move.from,
        to: move.to,
        capturedPiece,
      },
      captured: { red: [capturedPiece], black: [] },
    });
    const { api } = fakeApi({ afterMove });

    const execution = await run(api, provider());

    expect(execution.reporter.output).toContain("[吃子] black/horse");
    const submitted = execution.logger.records.find(
      ({ event }) => event === "move_submitted",
    );
    expect(submitted?.capturedPiece).toEqual(capturedPiece);
  });

  it("embedding-only 模型会暂停且绝不进入决策或提交", async () => {
    const { api, statuses, submitted } = fakeApi();
    const aiProvider = provider();
    aiProvider.getModelCapabilities = vi.fn(async () => ({
      capabilities: ["embedding"],
      supportsThinking: false,
      supportsCompletion: false,
      isGptOss: false,
    }));

    const execution = await run(api, aiProvider);

    expect(execution.result).toBe("paused");
    expect(aiProvider.chooseMove).not.toHaveBeenCalled();
    expect(submitted).toHaveLength(0);
    expect(statuses.at(-1)).toMatchObject({
      status: "paused",
      error: expect.stringContaining("embedding"),
    });
  });

  it("watcher 断线会取消并等待旧模型请求，再按服务端失败有界退出", async () => {
    let decisionAborted = false;
    let decisionSettled = false;
    const chooseMove = vi.fn<AiProvider["chooseMove"]>(
      async (_input, options) =>
        new Promise((resolve, reject) => {
          const signal = options?.signal;
          const abort = () => {
            decisionAborted = true;
            decisionSettled = true;
            reject(signal?.reason);
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        }),
    );
    const getControl = vi
      .fn()
      .mockResolvedValueOnce({ stopRequested: false, status: "starting" })
      .mockRejectedValueOnce(
        new RunnerHttpError(503, "SERVER_DOWN", "服务端断开"),
      );
    const { api, submitted } = fakeApi({ getControl });

    const execution = await run(api, provider(chooseMove), {
      maxServerFailures: 1,
    });

    expect(execution.result).toBe("exited");
    expect(decisionAborted).toBe(true);
    expect(decisionSettled).toBe(true);
    expect(submitted).toHaveLength(0);
  });

  it("换 token 导致 watcher 401 时取消旧决定并暂停，不提交任何着法", async () => {
    let decisionAborted = false;
    const chooseMove = vi.fn<AiProvider["chooseMove"]>(
      async (_input, options) =>
        new Promise((resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              decisionAborted = true;
              reject(options.signal?.reason);
            },
            { once: true },
          );
        }),
    );
    const getControl = vi
      .fn()
      .mockResolvedValueOnce({ stopRequested: false, status: "starting" })
      .mockRejectedValueOnce(
        new RunnerHttpError(401, "AGENT_TOKEN_INVALID", "令牌已失效"),
      );
    const { api, statuses, submitted } = fakeApi({ getControl });

    const execution = await run(api, provider(chooseMove));

    expect(execution.result).toBe("paused");
    expect(decisionAborted).toBe(true);
    expect(submitted).toHaveLength(0);
    expect(statuses.at(-1)).toMatchObject({
      status: "paused",
      error: "令牌已失效",
    });
  });

  it("终端关闭的全局 Abort 会等待模型取消并报告 exited", async () => {
    const terminal = new AbortController();
    let decisionAborted = false;
    const chooseMove = vi.fn<AiProvider["chooseMove"]>(
      async (_input, options) =>
        new Promise((resolve, reject) => {
          setTimeout(
            () =>
              terminal.abort(new DOMException("terminal closed", "AbortError")),
            0,
          );
          options?.signal?.addEventListener(
            "abort",
            () => {
              decisionAborted = true;
              reject(options.signal?.reason);
            },
            { once: true },
          );
        }),
    );
    const { api, statuses, submitted } = fakeApi();

    const execution = await run(api, provider(chooseMove), {
      signal: terminal.signal,
    });

    expect(execution.result).toBe("exited");
    expect(decisionAborted).toBe(true);
    expect(submitted).toHaveLength(0);
    expect(statuses.at(-1)).toMatchObject({
      status: "exited",
      error: "控制台已关闭。",
    });
  });
});
