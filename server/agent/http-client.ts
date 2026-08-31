import type {
  AgentSessionStatus,
  LegalMove,
  LegalMovesResponse,
  PublicGameState,
} from "../../shared/contracts";
import type { AgentSessionFile } from "./session-file";

interface ApiErrorPayload {
  error?: { code?: string; message?: string; details?: unknown };
}

export class RunnerHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "RunnerHttpError";
  }
}

export interface AgentRunnerApi {
  getGame(signal?: AbortSignal): Promise<PublicGameState>;
  getLegalMoves(signal?: AbortSignal): Promise<LegalMovesResponse>;
  submitMove(
    move: LegalMove,
    expectedRevision: number,
    signal?: AbortSignal,
  ): Promise<PublicGameState>;
  getControl(signal?: AbortSignal): Promise<{
    stopRequested: boolean;
    status: AgentSessionStatus;
  }>;
  updateStatus(
    status: AgentSessionStatus,
    error?: string | null,
    signal?: AbortSignal,
  ): Promise<void>;
}

const combineSignal = (signal: AbortSignal | undefined): AbortSignal => {
  const timeout = AbortSignal.timeout(8_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
};

export class AgentHttpClient implements AgentRunnerApi {
  private readonly baseUrl: string;
  private readonly gamePath: string;

  constructor(private readonly session: AgentSessionFile) {
    this.baseUrl = session.apiBaseUrl.replace(/\/+$/, "");
    this.gamePath = `/api/v1/games/${encodeURIComponent(session.gameId)}`;
  }

  private async request<T>(
    requestPath: string,
    init: RequestInit = {},
    authenticated = false,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${requestPath}`, {
        ...init,
        headers: {
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(authenticated
            ? { authorization: `Bearer ${this.session.token}` }
            : {}),
          ...init.headers,
        },
        signal: combineSignal(init.signal ?? undefined),
      });
    } catch (error) {
      if (init.signal?.aborted) throw init.signal.reason;
      throw new RunnerHttpError(
        0,
        "NETWORK_ERROR",
        "无法连接棋局 API。",
        error instanceof Error ? error.message : undefined,
      );
    }
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) {
      const apiError = (payload as ApiErrorPayload | undefined)?.error;
      throw new RunnerHttpError(
        response.status,
        apiError?.code ?? "REQUEST_FAILED",
        apiError?.message ?? "棋局 API 请求失败。",
        apiError?.details,
      );
    }
    return payload as T;
  }

  getGame(signal?: AbortSignal): Promise<PublicGameState> {
    return this.request<PublicGameState>(this.gamePath, { signal });
  }

  getLegalMoves(signal?: AbortSignal): Promise<LegalMovesResponse> {
    return this.request<LegalMovesResponse>(`${this.gamePath}/legal-moves`, {
      signal,
    });
  }

  submitMove(
    move: LegalMove,
    expectedRevision: number,
    signal?: AbortSignal,
  ): Promise<PublicGameState> {
    return this.request<PublicGameState>(`${this.gamePath}/moves`, {
      method: "POST",
      body: JSON.stringify({
        from: move.from,
        to: move.to,
        expectedRevision,
      }),
      signal,
    });
  }

  getControl(signal?: AbortSignal) {
    return this.request<{
      stopRequested: boolean;
      status: AgentSessionStatus;
    }>(`${this.gamePath}/agent-session/runner`, { signal }, true);
  }

  async updateStatus(
    status: AgentSessionStatus,
    error: string | null = null,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request(
      `${this.gamePath}/agent-session/runner`,
      {
        method: "PATCH",
        body: JSON.stringify({ status, error }),
        signal,
      },
      true,
    );
  }
}
