export const BOARD_WIDTH = 9;
export const BOARD_HEIGHT = 10;

export type Color = "red" | "black";
export type GameMode = "standard" | "capture-general";
export type MatchType = "human-human" | "human-ai";
export type PieceType =
  "general" | "advisor" | "elephant" | "horse" | "rook" | "cannon" | "pawn";

export interface Position {
  x: number;
  y: number;
}

export interface PieceIdentity {
  color: Color;
  type: PieceType;
}

export type FinishReason =
  | "checkmate"
  | "stalemate"
  | "general-captured"
  | "resignation"
  | "threefold-repetition";

export interface GameStatus {
  phase: "active" | "finished";
  winner: Color | null;
  reason: FinishReason | null;
}

export interface PublicBoardPiece {
  id: string;
  position: Position;
  faceUp: boolean;
  /** The identity printed on the original square. It governs a covered piece. */
  publicIdentity: PieceIdentity;
  /** Present only after the piece has been revealed. */
  identity?: PieceIdentity;
  controller: Color;
}

export interface PublicCapturedPiece {
  id: string;
  identity: PieceIdentity;
  publicIdentity: PieceIdentity;
  capturedBy: Color;
  moveNumber: number;
}

export interface PublicLastMove {
  pieceId: string;
  from: Position;
  to: Position;
  capturedPiece?: PublicCapturedPiece;
  revealedIdentity?: PieceIdentity;
}

export interface PublicGameState {
  id: string;
  /** Hidden while active and disclosed only after the game has finished. */
  seed: string | null;
  mode: GameMode;
  /** When false, threefold repetition does not automatically end the game. */
  allowDraw: boolean;
  /** When false, completed moves cannot be taken back. */
  allowUndo: boolean;
  /** Whether the current public position has an available takeback target. */
  canUndo: boolean;
  matchType: MatchType;
  aiModel: string | null;
  revision: number;
  turn: Color;
  moveNumber: number;
  players: {
    player1: Color;
    player2: Color;
  };
  status: GameStatus;
  check: Color | null;
  board: PublicBoardPiece[];
  captured: Record<Color, PublicCapturedPiece[]>;
  lastMove: PublicLastMove | null;
  createdAt: string;
}

export interface LegalMove {
  pieceId: string;
  from: Position;
  to: Position;
  captures: boolean;
}

export interface LegalMovesResponse {
  gameId: string;
  revision: number;
  turn: Color;
  moves: LegalMove[];
}

export interface CreateGameRequest {
  /** Defaults to standard mode. */
  mode?: GameMode;
  /** Defaults to true. Currently controls automatic threefold-repetition draws. */
  allowDraw?: boolean;
  /** Defaults to true. Controls whether a player may take back moves. */
  allowUndo?: boolean;
  matchType: MatchType;
  /** Omit to let the server assign Player 1 / the human side at random. */
  player1Side?: Color;
  aiModel?: string;
  /** Omit for an automatically generated opening; otherwise replay this seed. */
  seed?: string;
}

export interface LocalAiModel {
  name: string;
  family?: string;
  parameterSize?: string;
  size?: number;
  /** Capabilities reported by Ollama's /api/show endpoint. */
  capabilities?: string[];
  /** True only when Ollama explicitly reports the `thinking` capability. */
  supportsThinking?: boolean;
  /** False means the model is known to be embedding-only and cannot play. */
  supportsCompletion?: boolean;
}

export interface AiModelsResponse {
  provider: "ollama";
  available: boolean;
  models: LocalAiModel[];
  message: string;
}

export interface AiMoveResponse {
  game: PublicGameState;
  decision: {
    model: string;
    /** `fallback` is retained for wire compatibility; new decisions never use it. */
    source: "model" | "fallback";
    note?: string;
  };
}

export type AgentSessionStatus =
  | "starting"
  | "waiting-human"
  | "thinking"
  | "submitting"
  | "paused"
  | "finished"
  | "stopped"
  | "exited";

export type AgentTerminalKind =
  | "iterm2"
  | "terminal"
  | "powershell7"
  | "windows-powershell"
  | "cmd"
  | "x-terminal-emulator"
  | "gnome-terminal"
  | "konsole"
  | "xfce4-terminal";

/** Browser-safe Agent Runner state. It intentionally excludes credentials. */
export interface AgentSessionState {
  sessionId: string;
  gameId: string;
  status: AgentSessionStatus;
  terminal: AgentTerminalKind | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string | null;
  error: string | null;
  manualCommand?: string;
  logPath: string;
}

export interface SubmitMoveRequest {
  from: Position;
  to: Position;
  expectedRevision: number;
}

export interface ResignRequest {
  expectedRevision: number;
}

export interface UndoRequest {
  expectedRevision: number;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export const oppositeColor = (color: Color): Color =>
  color === "red" ? "black" : "red";

export const PIECE_LABELS: Record<Color, Record<PieceType, string>> = {
  red: {
    general: "帥",
    advisor: "仕",
    elephant: "相",
    horse: "傌",
    rook: "俥",
    cannon: "炮",
    pawn: "兵",
  },
  black: {
    general: "將",
    advisor: "士",
    elephant: "象",
    horse: "馬",
    rook: "車",
    cannon: "砲",
    pawn: "卒",
  },
};

export const COLOR_LABELS: Record<Color, string> = {
  red: "红方",
  black: "黑方",
};

export const MODE_LABELS: Record<GameMode, string> = {
  standard: "标准模式",
  "capture-general": "吃主帅模式",
};

export const MATCH_LABELS: Record<MatchType, string> = {
  "human-human": "双人对战",
  "human-ai": "人机对战",
};
