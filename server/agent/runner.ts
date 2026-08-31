import type {
  AgentSessionStatus,
  LegalMove,
  PublicGameState,
} from "../../shared/contracts";
import {
  chooseMoveWithRetry,
  isGptOssModel,
  sanitizeModelText,
  type AiDecision,
  type AiProvider,
  type ModelCapabilities,
} from "../ollama";
import type { AgentRunnerApi } from "./http-client";
import { RunnerHttpError } from "./http-client";
import type { AgentLogger } from "./jsonl";
import type { AgentReporter } from "./reporter";

export type AgentRunnerResult = "finished" | "paused" | "stopped" | "exited";

export interface AgentRunnerOptions {
  api: AgentRunnerApi;
  aiProvider: AiProvider;
  logger: AgentLogger;
  reporter: AgentReporter;
  pollIntervalMs?: number;
  maxServerFailures?: number;
  now?: () => Date;
  signal?: AbortSignal;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

type FreshDecision =
  | { kind: "decision"; decision: AiDecision }
  | { kind: "stale" }
  | { kind: "stopped" };

const defaultSleep = (
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

const errorMessage = (error: unknown): string =>
  sanitizeModelText(error instanceof Error ? error.message : "未知错误");

const positionText = ({ x, y }: { x: number; y: number }): string =>
  `(${x},${y})`;

const isConnectivityFailure = (error: unknown): boolean =>
  error instanceof RunnerHttpError &&
  (error.status === 0 || error.status >= 500);

export class AgentRunner {
  private readonly api: AgentRunnerApi;
  private readonly aiProvider: AiProvider;
  private readonly logger: AgentLogger;
  private readonly reporter: AgentReporter;
  private readonly pollIntervalMs: number;
  private readonly maxServerFailures: number;
  private readonly now: () => Date;
  private readonly signal?: AbortSignal;
  private readonly sleep: NonNullable<AgentRunnerOptions["sleep"]>;
  private startedAt = 0;
  private lastLoggedRevision: number | null = null;
  private modelCapabilities: ModelCapabilities | null = null;
  private lastWaitingRevision: number | null = null;

  constructor(options: AgentRunnerOptions) {
    this.api = options.api;
    this.aiProvider = options.aiProvider;
    this.logger = options.logger;
    this.reporter = options.reporter;
    this.pollIntervalMs = options.pollIntervalMs ?? 750;
    this.maxServerFailures = options.maxServerFailures ?? 5;
    this.now = options.now ?? (() => new Date());
    this.signal = options.signal;
    this.sleep = options.sleep ?? defaultSleep;
  }

  private async log(event: string, fields: Record<string, unknown> = {}) {
    await this.logger.write({
      timestamp: this.now().toISOString(),
      event,
      ...fields,
    });
  }

  private async setStatus(
    status: AgentSessionStatus,
    error: string | null = null,
  ): Promise<void> {
    await this.api.updateStatus(status, error, this.signal);
  }

  private async pause(error: unknown): Promise<AgentRunnerResult> {
    const message = errorMessage(error);
    this.reporter.line();
    this.reporter.line(`[已暂停] ${message}`);
    this.reporter.line("请在网页中选择“重启控制器”。本次不会随机代走。 ");
    await this.log("paused", { error: message });
    try {
      await this.setStatus("paused", message);
    } catch {
      // The useful failure is already visible and persisted locally.
    }
    return "paused";
  }

  private async finishStopped(): Promise<AgentRunnerResult> {
    this.reporter.line("[已停止] 网页请求停止 Agent Runner。");
    await this.log("stopped");
    try {
      await this.setStatus("stopped");
    } catch {
      // The server may be shutting down at the same time.
    }
    return "stopped";
  }

  private async finishAborted(): Promise<AgentRunnerResult> {
    this.reporter.line("[已退出] 控制台正在关闭。 ");
    await this.log("runner_exited", { reason: "terminal_closed" });
    try {
      // Do not reuse the already-aborted global signal for the final heartbeat.
      await this.api.updateStatus("exited", "控制台已关闭。", undefined);
    } catch {
      // A stale-heartbeat check on the server provides the final fallback.
    }
    return "exited";
  }

  private async capabilitiesFor(model: string): Promise<ModelCapabilities> {
    if (this.modelCapabilities) return this.modelCapabilities;
    if (!this.aiProvider.getModelCapabilities) {
      this.modelCapabilities = {
        capabilities: [],
        supportsThinking: false,
        isGptOss: isGptOssModel(model),
      };
      return this.modelCapabilities;
    }
    try {
      this.modelCapabilities = await this.aiProvider.getModelCapabilities(
        model,
        this.signal,
      );
    } catch (error) {
      if (this.signal?.aborted) throw error;
      this.modelCapabilities = {
        capabilities: [],
        supportsThinking: false,
        isGptOss: isGptOssModel(model),
      };
      this.reporter.line(
        `[能力检测] ${errorMessage(error)}；将不请求或伪造 thinking。`,
      );
      await this.log("model_capability_fallback", {
        model,
        error: errorMessage(error),
      });
    }
    return this.modelCapabilities;
  }

  private async watchRevision(
    game: PublicGameState,
    signal: AbortSignal,
  ): Promise<"stale" | "stopped"> {
    while (!signal.aborted) {
      await this.sleep(this.pollIntervalMs, signal);
      const control = await this.api.getControl(signal);
      if (control.stopRequested) return "stopped";
      const latest = await this.api.getGame(signal);
      if (
        latest.revision !== game.revision ||
        latest.status.phase !== "active" ||
        latest.turn !== game.turn
      ) {
        return "stale";
      }
    }
    throw signal.reason;
  }

  private async chooseWhileFresh(
    game: PublicGameState,
    moves: LegalMove[],
    capabilities: ModelCapabilities,
  ): Promise<FreshDecision> {
    const decisionController = new AbortController();
    const watchController = new AbortController();
    const decisionSignal = this.signal
      ? AbortSignal.any([this.signal, decisionController.signal])
      : decisionController.signal;
    const watchSignal = this.signal
      ? AbortSignal.any([this.signal, watchController.signal])
      : watchController.signal;
    let rawSection: "thinking" | "final" | null = null;
    const beginRawSection = (
      section: "thinking" | "final",
      heading: string,
    ) => {
      if (rawSection === section) return;
      if (rawSection) this.reporter.line();
      this.reporter.line(heading);
      rawSection = section;
    };
    const closeRawSection = () => {
      if (rawSection) this.reporter.line();
      rawSection = null;
    };

    const decisionPromise = chooseMoveWithRetry(
      this.aiProvider,
      { game, legalMoves: moves, model: game.aiModel! },
      {
        signal: decisionSignal,
        capabilities,
        onThinking: (chunk) => {
          beginRawSection(
            "thinking",
            "[Ollama thinking · 模型原始文本（已移除终端控制字符）]",
          );
          this.reporter.raw(sanitizeModelText(chunk));
        },
        onContent: (chunk, source) => {
          beginRawSection(
            "final",
            source === "thinking-fallback"
              ? "[Ollama final · 模型原始文本（已移除终端控制字符，thinking 兼容通道）]"
              : "[Ollama final · 模型原始文本（已移除终端控制字符）]",
          );
          this.reporter.raw(sanitizeModelText(chunk));
        },
        onRetry: (error) => {
          closeRawSection();
          this.reporter.line(`[纠错重试 1/1] ${errorMessage(error)}`);
        },
      },
    );
    const watcherPromise = this.watchRevision(game, watchSignal);

    try {
      const outcome = await Promise.race([
        decisionPromise.then((decision) => ({
          source: "decision" as const,
          decision,
        })),
        watcherPromise.then((reason) => ({
          source: "watcher" as const,
          reason,
        })),
      ]);
      if (outcome.source === "watcher") {
        decisionController.abort(
          new DOMException("局面已变化，取消旧模型请求。", "AbortError"),
        );
        await decisionPromise.catch(() => undefined);
        return { kind: outcome.reason };
      }
      watchController.abort(new DOMException("模型决策已完成。", "AbortError"));
      await watcherPromise.catch(() => undefined);
      const control = await this.api.getControl(this.signal);
      if (control.stopRequested) return { kind: "stopped" };
      const latest = await this.api.getGame(this.signal);
      if (
        latest.revision !== game.revision ||
        latest.status.phase !== "active" ||
        latest.turn !== game.turn
      ) {
        return { kind: "stale" };
      }
      return { kind: "decision", decision: outcome.decision };
    } finally {
      closeRawSection();
      decisionController.abort(
        new DOMException("决策阶段已经结束。", "AbortError"),
      );
      watchController.abort(new DOMException("决策已完成。", "AbortError"));
      await decisionPromise.catch(() => undefined);
      await watcherPromise.catch(() => undefined);
    }
  }

  private displayMoves(moves: LegalMove[]): void {
    for (const [index, move] of moves.entries()) {
      this.reporter.line(
        `  ${index}. ${positionText(move.from)} → ${positionText(move.to)}${
          move.captures ? " ×" : ""
        }`,
      );
    }
  }

  async run(): Promise<AgentRunnerResult> {
    this.startedAt = this.now().getTime();
    let consecutiveServerFailures = 0;
    this.reporter.line("覆子 · 本地 Agent Runner");
    this.reporter.line("模型只会收到公开局面与服务端返回的合法着法。 ");
    await this.log("runner_started");

    while (true) {
      if (this.signal?.aborted) return this.finishAborted();
      try {
        const control = await this.api.getControl(this.signal);
        if (control.stopRequested) return this.finishStopped();

        const game = await this.api.getGame(this.signal);
        consecutiveServerFailures = 0;
        if (game.revision !== this.lastLoggedRevision) {
          this.lastLoggedRevision = game.revision;
          this.reporter.line();
          this.reporter.line(
            `[局面] revision=${game.revision} · ${game.turn} · 第 ${game.moveNumber + 1} 手`,
          );
          await this.log("public_position", { game });
        }

        if (game.status.phase === "finished") {
          const elapsedMs = this.now().getTime() - this.startedAt;
          this.reporter.line(
            `[终局] winner=${game.status.winner ?? "draw"} · reason=${game.status.reason ?? "unknown"}`,
          );
          this.reporter.line(`总耗时：${elapsedMs} ms`);
          await this.log("game_finished", {
            status: game.status,
            revision: game.revision,
            elapsedMs,
          });
          await this.setStatus("finished");
          return "finished";
        }
        if (game.matchType !== "human-ai" || !game.aiModel) {
          return this.pause(new Error("该对局不是有效的人机对战。"));
        }

        const aiColor = game.players.player2;
        if (game.turn !== aiColor) {
          await this.setStatus("waiting-human");
          if (this.lastWaitingRevision !== game.revision) {
            this.reporter.line("[等待] 现在是人类回合。 ");
            this.lastWaitingRevision = game.revision;
          }
          await this.sleep(this.pollIntervalMs, this.signal);
          continue;
        }
        this.lastWaitingRevision = null;

        const legal = await this.api.getLegalMoves(this.signal);
        if (legal.revision !== game.revision || legal.turn !== game.turn) {
          this.reporter.line("[刷新] 合法着法对应的局面已过期。 ");
          continue;
        }
        if (legal.moves.length === 0) {
          return this.pause(
            new Error("当前没有合法着法，但对局尚未标记终局。"),
          );
        }

        this.reporter.line(`[候选] 共 ${legal.moves.length} 个合法着法`);
        this.displayMoves(legal.moves);
        await this.log("legal_moves", {
          revision: legal.revision,
          turn: legal.turn,
          moves: legal.moves,
        });

        const capabilities = await this.capabilitiesFor(game.aiModel);
        if (capabilities.supportsCompletion === false) {
          return this.pause(
            new Error("所选模型仅支持 embedding，不能生成着法。"),
          );
        }
        if (!capabilities.supportsThinking) {
          this.reporter.line(
            "[thinking] 模型未声明 thinking 能力；仅显示候选、结论和 API 日志。",
          );
        } else if (capabilities.isGptOss) {
          this.reporter.line("[thinking] GPT-OSS 使用 medium 级别。 ");
        }
        await this.setStatus("thinking");
        const turnStartedAt = this.now().getTime();
        const modelStartedAt = this.now().getTime();
        const outcome = await this.chooseWhileFresh(
          game,
          legal.moves,
          capabilities,
        );
        if (outcome.kind === "stopped") return this.finishStopped();
        if (outcome.kind === "stale") {
          this.reporter.line("[取消] revision 已变化，丢弃旧决定并重新读取。 ");
          await this.log("decision_discarded", {
            revision: game.revision,
            reason: "stale_revision",
          });
          continue;
        }
        const modelElapsedMs = this.now().getTime() - modelStartedAt;

        const selectedMove = legal.moves[outcome.decision.moveIndex];
        if (!selectedMove) {
          return this.pause(new Error("模型选择的着法编号超出合法范围。"));
        }
        this.reporter.line(
          `[选择] #${outcome.decision.moveIndex} ${positionText(selectedMove.from)} → ${positionText(selectedMove.to)}`,
        );
        if (outcome.decision.note) {
          this.reporter.line(
            `[理由] ${sanitizeModelText(outcome.decision.note)}`,
          );
        }
        await this.log("model_response", {
          revision: game.revision,
          model: game.aiModel,
          moveIndex: outcome.decision.moveIndex,
          reason: outcome.decision.note
            ? sanitizeModelText(outcome.decision.note)
            : null,
          finalSource: outcome.decision.finalSource ?? null,
          thinking:
            typeof outcome.decision.thinking === "string"
              ? sanitizeModelText(outcome.decision.thinking)
              : null,
          content:
            typeof outcome.decision.content === "string"
              ? sanitizeModelText(outcome.decision.content)
              : null,
        });

        const applicationStartedAt = this.now().getTime();
        await this.setStatus("submitting");
        let nextGame: PublicGameState;
        try {
          nextGame = await this.api.submitMove(
            selectedMove,
            game.revision,
            this.signal,
          );
        } catch (error) {
          if (
            error instanceof RunnerHttpError &&
            error.code === "STALE_REVISION"
          ) {
            this.reporter.line("[冲突] STALE_REVISION，旧决定已丢弃。 ");
            await this.log("decision_discarded", {
              revision: game.revision,
              reason: "STALE_REVISION",
            });
            continue;
          }
          throw error;
        }
        const elapsedMs = this.now().getTime() - turnStartedAt;
        const applicationElapsedMs =
          this.now().getTime() - applicationStartedAt;
        this.reporter.line(
          `[提交] 成功 · revision=${nextGame.revision} · ${elapsedMs} ms`,
        );
        this.reporter.line(
          `[耗时] 模型 ${modelElapsedMs} ms · 应用侧提交 ${applicationElapsedMs} ms`,
        );
        if (nextGame.lastMove?.capturedPiece) {
          const captured = nextGame.lastMove.capturedPiece;
          this.reporter.line(
            `[吃子] ${captured.identity.color}/${captured.identity.type}`,
          );
        }
        await this.log("move_submitted", {
          previousRevision: game.revision,
          revision: nextGame.revision,
          move: selectedMove,
          capturedPiece: nextGame.lastMove?.capturedPiece ?? null,
          elapsedMs,
          modelElapsedMs,
          applicationElapsedMs,
        });
      } catch (error) {
        if (this.signal?.aborted) return this.finishAborted();
        if (
          error instanceof RunnerHttpError &&
          error.code === "STALE_REVISION"
        ) {
          continue;
        }
        if (isConnectivityFailure(error)) {
          consecutiveServerFailures += 1;
          this.reporter.line(
            `[API 断开 ${consecutiveServerFailures}/${this.maxServerFailures}] ${errorMessage(error)}`,
          );
          await this.log("api_error", {
            attempt: consecutiveServerFailures,
            error: errorMessage(error),
          });
          if (consecutiveServerFailures >= this.maxServerFailures) {
            this.reporter.line("[退出] 服务端连续不可用，Runner 已自动停止。 ");
            await this.log("runner_exited", { reason: "server_unavailable" });
            try {
              await this.setStatus(
                "exited",
                "服务端连续不可用，Runner 已退出。",
              );
            } catch {
              // Expected when the API process itself is unavailable.
            }
            return "exited";
          }
          await this.sleep(this.pollIntervalMs, this.signal);
          continue;
        }
        return this.pause(error);
      }
    }
  }
}
