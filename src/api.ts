import type {
  AgentSessionState,
  Color,
  LanRoomState,
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

const request = async <T>(
  path: string,
  init?: RequestInit,
  seatToken?: string,
): Promise<T> => {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      // Seat credentials ride the Authorization header, never the URL.
      ...(seatToken ? { authorization: `Bearer ${seatToken}` } : {}),
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

export interface CreateRoomRequest {
  mode?: "standard" | "capture-general";
  allowDraw?: boolean;
  allowUndo?: boolean;
  hostSide?: Color;
  seed?: string;
}

export interface LanSeatResponse {
  game: PublicGameState & { lan?: LanRoomState | null };
  /** Returned exactly once, at claim time. Never present in a later read. */
  roomCode?: string;
  seat: { color: Color; token: string };
}

export interface LanInviteResponse {
  game: PublicGameState;
  roomCode: string;
}

export interface NetworkStatusResponse {
  mode: "loopback" | "lan";
  targetMode: "loopback" | "lan";
  port: number;
  addresses: string[];
  error: string | null;
  pending: boolean;
  listening: boolean;
  /** False when read from another device: the toggle is loopback-only. */
  local: boolean;
}

export interface GameApi {
  createGame(request: CreateGameRequest): Promise<PublicGameState>;
  getAiModels(): Promise<AiModelsResponse>;
  getGame(
    id: string,
    signal?: AbortSignal,
    seatToken?: string,
  ): Promise<PublicGameState>;
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
    seatToken?: string,
  ): Promise<PublicGameState>;
  undo(id: string, expectedRevision: number): Promise<PublicGameState>;
  resign(
    id: string,
    expectedRevision: number,
    seatToken?: string,
  ): Promise<PublicGameState>;
  createRoom(request: CreateRoomRequest): Promise<LanSeatResponse>;
  joinRoom(roomCode: string): Promise<LanSeatResponse>;
  reinvite(
    id: string,
    expectedRevision: number,
    expectedRoomCode: string,
    seatToken: string,
  ): Promise<LanInviteResponse>;
  requestUndo(
    id: string,
    expectedRevision: number,
    seatToken: string,
  ): Promise<PublicGameState>;
  resolveUndo(
    id: string,
    expectedRevision: number,
    requestId: string,
    accept: boolean,
    seatToken: string,
  ): Promise<PublicGameState>;
  getNetwork(signal?: AbortSignal): Promise<NetworkStatusResponse>;
  setNetworkMode(mode: "loopback" | "lan"): Promise<NetworkStatusResponse>;
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
  getGame(id, signal, seatToken) {
    return request<PublicGameState>(
      `/api/v1/games/${id}`,
      { signal },
      seatToken,
    );
  },
  getLegalMoves(id, pieceId, signal) {
    const suffix = pieceId ? `?pieceId=${encodeURIComponent(pieceId)}` : "";
    return request<LegalMovesResponse>(
      `/api/v1/games/${id}/legal-moves${suffix}`,
      { signal },
    );
  },
  move(id, from, to, expectedRevision, seatToken) {
    return request<PublicGameState>(
      `/api/v1/games/${id}/moves`,
      { method: "POST", body: JSON.stringify({ from, to, expectedRevision }) },
      seatToken,
    );
  },
  undo(id, expectedRevision) {
    return request<PublicGameState>(`/api/v1/games/${id}/undo`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision }),
    });
  },
  resign(id, expectedRevision, seatToken) {
    return request<PublicGameState>(
      `/api/v1/games/${id}/resign`,
      { method: "POST", body: JSON.stringify({ expectedRevision }) },
      seatToken,
    );
  },
  createRoom(payload) {
    return request<LanSeatResponse>("/api/v1/rooms", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  joinRoom(roomCode) {
    return request<LanSeatResponse>(
      `/api/v1/rooms/${encodeURIComponent(roomCode)}/join`,
      { method: "POST", body: JSON.stringify({}) },
    );
  },
  reinvite(id, expectedRevision, expectedRoomCode, seatToken) {
    return request<LanInviteResponse>(
      `/api/v1/games/${id}/invite`,
      {
        method: "POST",
        body: JSON.stringify({ expectedRevision, expectedRoomCode }),
      },
      seatToken,
    );
  },
  requestUndo(id, expectedRevision, seatToken) {
    return request<PublicGameState>(
      `/api/v1/games/${id}/undo-request`,
      { method: "POST", body: JSON.stringify({ expectedRevision }) },
      seatToken,
    );
  },
  resolveUndo(id, expectedRevision, requestId, accept, seatToken) {
    return request<PublicGameState>(
      `/api/v1/games/${id}/undo-request/resolve`,
      {
        method: "POST",
        body: JSON.stringify({ expectedRevision, requestId, accept }),
      },
      seatToken,
    );
  },
  getNetwork(signal) {
    return request<NetworkStatusResponse>("/api/v1/network", { signal });
  },
  setNetworkMode(mode) {
    return request<NetworkStatusResponse>("/api/v1/network", {
      method: "POST",
      body: JSON.stringify({ mode }),
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
