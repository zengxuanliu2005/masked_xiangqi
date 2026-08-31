import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { GameState } from "../../engine/types";
import type {
  AgentSessionState,
  AgentSessionStatus,
} from "../../shared/contracts";
import { SystemTerminalLauncher, type TerminalLauncher } from "./terminal";
import { writeAgentSessionFile } from "./session-file";

const activeStatuses = new Set<AgentSessionStatus>([
  "starting",
  "waiting-human",
  "thinking",
  "submitting",
]);

const runnerStatuses = new Set<AgentSessionStatus>([
  ...activeStatuses,
  "paused",
  "finished",
  "stopped",
  "exited",
]);

export type AgentSessionErrorCode =
  | "AGENT_SESSION_NOT_FOUND"
  | "AGENT_TOKEN_INVALID"
  | "AGENT_SESSION_IO_ERROR"
  | "CAPACITY_EXCEEDED";

export class AgentSessionError extends Error {
  constructor(
    public readonly code: AgentSessionErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AgentSessionError";
  }
}

interface InternalAgentSession {
  publicState: AgentSessionState;
  tokenHash: Buffer;
  sessionFilePath: string;
  stopRequested: boolean;
}

export interface AgentSessionManagerOptions {
  repositoryRoot?: string;
  sessionDirectory?: string;
  logDirectory?: string;
  launcher?: TerminalLauncher;
  now?: () => Date;
  tokenFactory?: () => string;
  sessionIdFactory?: () => string;
  staleAfterMs?: number;
  retentionMs?: number;
  maxActiveSessions?: number;
  maxRetainedSessions?: number;
}

export interface CreateAgentSessionResult {
  state: AgentSessionState;
  created: boolean;
}

const clonePublicState = (state: AgentSessionState): AgentSessionState => ({
  ...state,
});

const safeFileStem = (value: string): string =>
  value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "game";

const hashToken = (token: string): Buffer =>
  createHash("sha256").update(token).digest();

const assertLocalApiBaseUrl = (raw: string): string => {
  const url = new URL(raw);
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname) ||
    url.username ||
    url.password
  ) {
    throw new AgentSessionError(
      "AGENT_SESSION_IO_ERROR",
      "Agent Runner 只能连接本机 HTTP API。",
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
};

export class AgentSessionManager {
  private readonly repositoryRoot: string;
  private readonly sessionDirectory: string;
  private readonly logDirectory: string;
  private readonly launcher: TerminalLauncher;
  private readonly now: () => Date;
  private readonly tokenFactory: () => string;
  private readonly sessionIdFactory: () => string;
  private readonly staleAfterMs: number;
  private readonly retentionMs: number;
  private readonly maxActiveSessions: number;
  private readonly maxRetainedSessions: number;
  private readonly sessions = new Map<string, InternalAgentSession>();

  constructor(options: AgentSessionManagerOptions = {}) {
    this.repositoryRoot = path.resolve(options.repositoryRoot ?? process.cwd());
    this.sessionDirectory = path.resolve(
      options.sessionDirectory ??
        path.join(this.repositoryRoot, ".local", "agent-sessions"),
    );
    this.logDirectory = path.resolve(
      options.logDirectory ??
        path.join(this.repositoryRoot, ".local", "agent-logs"),
    );
    this.launcher =
      options.launcher ??
      new SystemTerminalLauncher({ repositoryRoot: this.repositoryRoot });
    this.now = options.now ?? (() => new Date());
    this.tokenFactory =
      options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
    this.sessionIdFactory = options.sessionIdFactory ?? randomUUID;
    this.staleAfterMs = options.staleAfterMs ?? 15_000;
    this.retentionMs = options.retentionMs ?? 60 * 60 * 1_000;
    this.maxActiveSessions = options.maxActiveSessions ?? 32;
    this.maxRetainedSessions = options.maxRetainedSessions ?? 512;
    this.removeOrphanedCredentials();
  }

  /**
   * Session tokens only authenticate against this in-memory manager. After a
   * service restart every pre-existing credential is therefore both useless
   * and sensitive, so remove it before accepting new sessions. Never follow a
   * directory entry: rmSync on a symlink removes the link itself.
   */
  private removeOrphanedCredentials(): void {
    try {
      for (const entry of readdirSync(this.sessionDirectory, {
        withFileTypes: true,
      })) {
        if (!entry.name.endsWith(".json")) continue;
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        rmSync(path.join(this.sessionDirectory, entry.name), { force: true });
      }
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )) {
        // A read-only or unavailable session directory is surfaced when the
        // first new credential is written; startup should remain inspectable.
      }
    }
  }

  get(gameId: string): AgentSessionState | undefined {
    this.cleanupExpired();
    const session = this.sessions.get(gameId);
    if (session) this.expireStaleSession(session);
    return session ? clonePublicState(session.publicState) : undefined;
  }

  private expireStaleSession(session: InternalAgentSession): void {
    if (!activeStatuses.has(session.publicState.status)) return;
    const reference =
      session.publicState.lastActivityAt ?? session.publicState.createdAt;
    if (
      this.now().getTime() - new Date(reference).getTime() <=
      this.staleAfterMs
    ) {
      return;
    }
    session.publicState.status = "exited";
    session.publicState.updatedAt = this.now().toISOString();
    session.publicState.error = "控制器心跳超时，终端可能已关闭。";
    this.deleteCredential(session);
  }

  private deleteCredential(session: InternalAgentSession): void {
    try {
      rmSync(session.sessionFilePath, { force: true });
    } catch {
      // A missing or concurrently removed one-time credential is harmless.
    }
  }

  private cleanupExpired(): void {
    const now = this.now().getTime();
    for (const [gameId, session] of this.sessions) {
      this.expireStaleSession(session);
      const status = session.publicState.status;
      const retained =
        status === "paused" ||
        status === "finished" ||
        status === "stopped" ||
        status === "exited";
      if (
        retained &&
        now - new Date(session.publicState.updatedAt).getTime() >
          this.retentionMs
      ) {
        this.deleteCredential(session);
        this.sessions.delete(gameId);
      }
    }
  }

  private trimRetainedSessions(): void {
    if (this.sessions.size < this.maxRetainedSessions) return;
    const removable = [...this.sessions.entries()]
      .filter(([, session]) =>
        ["finished", "stopped", "exited"].includes(session.publicState.status),
      )
      .sort(
        (left, right) =>
          new Date(left[1].publicState.updatedAt).getTime() -
          new Date(right[1].publicState.updatedAt).getTime(),
      );
    while (
      this.sessions.size >= this.maxRetainedSessions &&
      removable.length > 0
    ) {
      const [gameId, session] = removable.shift()!;
      this.deleteCredential(session);
      this.sessions.delete(gameId);
    }
  }

  private assertCapacity(): void {
    this.cleanupExpired();
    this.trimRetainedSessions();
    const activeCount = [...this.sessions.values()].filter((session) =>
      [...activeStatuses, "paused"].includes(session.publicState.status),
    ).length;
    if (
      activeCount >= this.maxActiveSessions ||
      this.sessions.size >= this.maxRetainedSessions
    ) {
      throw new AgentSessionError(
        "CAPACITY_EXCEEDED",
        "活动 Agent 会话已达到容量上限。",
      );
    }
  }

  private async startNew(
    game: GameState,
    apiBaseUrl: string,
  ): Promise<AgentSessionState> {
    const normalizedApiBaseUrl = assertLocalApiBaseUrl(apiBaseUrl);
    const sessionId = this.sessionIdFactory();
    const token = this.tokenFactory();
    const timestamp = this.now().toISOString();
    const fileStem = safeFileStem(game.id);
    const sessionFilePath = path.join(
      this.sessionDirectory,
      `${fileStem}-${sessionId}.json`,
    );
    const absoluteLogPath = path.join(this.logDirectory, `${fileStem}.jsonl`);
    const relativeLogPath = path.relative(this.repositoryRoot, absoluteLogPath);
    const publicState: AgentSessionState = {
      sessionId,
      gameId: game.id,
      status: "starting",
      terminal: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastActivityAt: null,
      error: null,
      logPath: relativeLogPath.startsWith("..")
        ? absoluteLogPath
        : relativeLogPath,
    };
    const internal: InternalAgentSession = {
      publicState,
      tokenHash: hashToken(token),
      sessionFilePath,
      stopRequested: false,
    };
    this.sessions.set(game.id, internal);

    try {
      await writeAgentSessionFile(sessionFilePath, {
        version: 1,
        sessionId,
        gameId: game.id,
        apiBaseUrl: normalizedApiBaseUrl,
        token,
        logPath: absoluteLogPath,
      });
      const result = await this.launcher.launch(sessionFilePath);
      const updatedAt = this.now().toISOString();
      publicState.updatedAt = updatedAt;
      publicState.terminal = result.terminal;
      if (result.launched) {
        publicState.error = null;
      } else {
        publicState.status = "paused";
        publicState.error = result.error ?? "无法启动本机终端。";
        publicState.manualCommand = result.manualCommand;
      }
    } catch (error) {
      publicState.status = "paused";
      publicState.updatedAt = this.now().toISOString();
      publicState.error =
        error instanceof Error
          ? `无法创建 Agent 会话：${error.message}`
          : "无法创建 Agent 会话。";
      try {
        publicState.manualCommand =
          this.launcher.manualCommand(sessionFilePath);
      } catch {
        // No safe manual command is available when the path itself is invalid.
      }
    }
    return clonePublicState(publicState);
  }

  async create(
    game: GameState,
    apiBaseUrl: string,
  ): Promise<CreateAgentSessionResult> {
    this.cleanupExpired();
    const existing = this.sessions.get(game.id);
    if (existing) this.expireStaleSession(existing);
    if (existing) {
      return { state: clonePublicState(existing.publicState), created: false };
    }
    this.assertCapacity();
    return { state: await this.startNew(game, apiBaseUrl), created: true };
  }

  async restart(
    game: GameState,
    apiBaseUrl: string,
  ): Promise<CreateAgentSessionResult> {
    this.cleanupExpired();
    const existing = this.sessions.get(game.id);
    if (existing) this.expireStaleSession(existing);
    if (existing && activeStatuses.has(existing.publicState.status)) {
      return { state: clonePublicState(existing.publicState), created: false };
    }
    if (existing) {
      existing.stopRequested = true;
      this.deleteCredential(existing);
      this.sessions.delete(game.id);
    }
    this.assertCapacity();
    return { state: await this.startNew(game, apiBaseUrl), created: true };
  }

  stop(gameId: string): AgentSessionState {
    const session = this.requireSession(gameId);
    session.stopRequested = true;
    session.publicState.status = "stopped";
    session.publicState.updatedAt = this.now().toISOString();
    session.publicState.error = null;
    this.deleteCredential(session);
    return clonePublicState(session.publicState);
  }

  finish(gameId: string): AgentSessionState | undefined {
    const session = this.sessions.get(gameId);
    if (!session) return undefined;
    session.publicState.status = "finished";
    session.publicState.updatedAt = this.now().toISOString();
    session.publicState.error = null;
    this.deleteCredential(session);
    return clonePublicState(session.publicState);
  }

  runnerControl(
    gameId: string,
    token: string,
  ): {
    stopRequested: boolean;
    status: AgentSessionStatus;
  } {
    const session = this.authenticate(gameId, token);
    session.publicState.lastActivityAt = this.now().toISOString();
    session.publicState.updatedAt = session.publicState.lastActivityAt;
    return {
      stopRequested: session.stopRequested,
      status: session.publicState.status,
    };
  }

  updateFromRunner(
    gameId: string,
    token: string,
    update: { status: AgentSessionStatus; error?: string | null },
  ): AgentSessionState {
    if (!runnerStatuses.has(update.status)) {
      throw new AgentSessionError(
        "AGENT_SESSION_IO_ERROR",
        "Runner 提交了不受支持的状态。",
      );
    }
    const session = this.authenticate(gameId, token);
    const timestamp = this.now().toISOString();
    session.publicState.status = update.status;
    session.publicState.updatedAt = timestamp;
    session.publicState.lastActivityAt = timestamp;
    session.publicState.error = update.error?.slice(0, 1_000) ?? null;
    if (update.status === "stopped") session.stopRequested = true;
    if (["finished", "stopped", "exited"].includes(update.status)) {
      this.deleteCredential(session);
    }
    return clonePublicState(session.publicState);
  }

  stopAll(): void {
    for (const session of this.sessions.values()) {
      session.stopRequested = true;
      session.publicState.status = "stopped";
      session.publicState.updatedAt = this.now().toISOString();
      session.publicState.error = null;
      this.deleteCredential(session);
    }
  }

  get size(): number {
    this.cleanupExpired();
    return this.sessions.size;
  }

  /** Exposed for tests and orderly shutdown; never serialize this object. */
  sessionFilePath(gameId: string): string | undefined {
    return this.sessions.get(gameId)?.sessionFilePath;
  }

  private requireSession(gameId: string): InternalAgentSession {
    const session = this.sessions.get(gameId);
    if (!session) {
      throw new AgentSessionError(
        "AGENT_SESSION_NOT_FOUND",
        "该对局尚未创建 Agent 控制会话。",
      );
    }
    return session;
  }

  private authenticate(gameId: string, token: string): InternalAgentSession {
    const session = this.requireSession(gameId);
    const receivedHash = hashToken(token);
    if (!timingSafeEqual(receivedHash, session.tokenHash)) {
      throw new AgentSessionError(
        "AGENT_TOKEN_INVALID",
        "Agent 会话令牌无效。",
      );
    }
    return session;
  }
}

export const isActiveAgentStatus = (status: AgentSessionStatus): boolean =>
  activeStatuses.has(status);
