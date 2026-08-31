import type {
  AgentSessionState,
  AiModelsResponse,
  AiMoveResponse,
  ApiErrorBody,
  CreateGameRequest,
  LegalMovesResponse,
  Position,
  PublicGameState,
} from "../shared/contracts";

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const body = (await response.json()) as T | ApiErrorBody;
  if (!response.ok) {
    const error = (body as ApiErrorBody).error;
    throw new ApiClientError(
      response.status,
      error?.code ?? "REQUEST_FAILED",
      error?.message ?? "请求失败，请稍后重试。",
      error?.details,
    );
  }
  return body as T;
};

export interface GameApi {
  createGame(request: CreateGameRequest): Promise<PublicGameState>;
  getAiModels(): Promise<AiModelsResponse>;
  getGame(id: string, signal?: AbortSignal): Promise<PublicGameState>;
  getLegalMoves(
    id: string,
    pieceId?: string,
    signal?: AbortSignal,
  ): Promise<LegalMovesResponse>;
  move(
    id: string,
    from: Position,
    to: Position,
    expectedRevision: number,
  ): Promise<PublicGameState>;
  undo(id: string, expectedRevision: number): Promise<PublicGameState>;
  resign(id: string, expectedRevision: number): Promise<PublicGameState>;
  aiMove(id: string, expectedRevision: number): Promise<AiMoveResponse>;
  createAgentSession(id: string): Promise<AgentSessionState>;
  getAgentSession(id: string, signal?: AbortSignal): Promise<AgentSessionState>;
  restartAgentSession(id: string): Promise<AgentSessionState>;
  stopAgentSession(id: string): Promise<AgentSessionState>;
}

export const gameApi: GameApi = {
  createGame(payload) {
    return request<PublicGameState>("/api/v1/games", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  getAiModels() {
    return request<AiModelsResponse>("/api/v1/ai/models");
  },
  getGame(id, signal) {
    return request<PublicGameState>(`/api/v1/games/${id}`, { signal });
  },
  getLegalMoves(id, pieceId, signal) {
    const suffix = pieceId ? `?pieceId=${encodeURIComponent(pieceId)}` : "";
    return request<LegalMovesResponse>(
      `/api/v1/games/${id}/legal-moves${suffix}`,
      { signal },
    );
  },
  move(id, from, to, expectedRevision) {
    return request<PublicGameState>(`/api/v1/games/${id}/moves`, {
      method: "POST",
      body: JSON.stringify({ from, to, expectedRevision }),
    });
  },
  undo(id, expectedRevision) {
    return request<PublicGameState>(`/api/v1/games/${id}/undo`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision }),
    });
  },
  resign(id, expectedRevision) {
    return request<PublicGameState>(`/api/v1/games/${id}/resign`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision }),
    });
  },
  aiMove(id, expectedRevision) {
    return request<AiMoveResponse>(`/api/v1/games/${id}/ai-move`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision }),
    });
  },
  createAgentSession(id) {
    return request<AgentSessionState>(`/api/v1/games/${id}/agent-session`, {
      method: "POST",
    });
  },
  getAgentSession(id, signal) {
    return request<AgentSessionState>(`/api/v1/games/${id}/agent-session`, {
      signal,
    });
  },
  restartAgentSession(id) {
    return request<AgentSessionState>(
      `/api/v1/games/${id}/agent-session/restart`,
      { method: "POST" },
    );
  },
  stopAgentSession(id) {
    return request<AgentSessionState>(`/api/v1/games/${id}/agent-session`, {
      method: "DELETE",
    });
  },
};
