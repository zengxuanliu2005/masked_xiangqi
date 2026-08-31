import type {
  Color,
  GameMode,
  GameStatus,
  MatchType,
  PieceIdentity,
  Position,
  PublicCapturedPiece,
} from "../shared/contracts";

export interface InternalPiece {
  id: string;
  position: Position | null;
  publicIdentity: PieceIdentity;
  trueIdentity: PieceIdentity;
  revealed: boolean;
}

export interface InternalLastMove {
  pieceId: string;
  from: Position;
  to: Position;
  capturedPiece?: PublicCapturedPiece;
  revealedIdentity?: PieceIdentity;
}

export interface UndoSnapshot {
  turn: Color;
  moveNumber: number;
  pieces: InternalPiece[];
  captured: Record<Color, PublicCapturedPiece[]>;
  status: GameStatus;
  lastMove: InternalLastMove | null;
  positionCounts: Map<string, number>;
}

export interface GameState {
  id: string;
  seed: string;
  mode: GameMode;
  allowDraw: boolean;
  allowUndo: boolean;
  matchType: MatchType;
  aiModel: string | null;
  player1Side: Color;
  turn: Color;
  revision: number;
  moveNumber: number;
  pieces: InternalPiece[];
  captured: Record<Color, PublicCapturedPiece[]>;
  status: GameStatus;
  lastMove: InternalLastMove | null;
  positionCounts: Map<string, number>;
  undoStack: UndoSnapshot[];
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
  finishedAt: string | null;
}

export interface NewGameOptions {
  mode: GameMode;
  player1Side: Color;
  seed?: string;
  allowDraw?: boolean;
  allowUndo?: boolean;
  matchType?: MatchType;
  aiModel?: string | null;
  rng?: () => number;
  id?: string;
}

export interface ScenarioOptions {
  pieces: InternalPiece[];
  seed?: string;
  mode?: GameMode;
  allowDraw?: boolean;
  allowUndo?: boolean;
  matchType?: MatchType;
  aiModel?: string | null;
  turn?: Color;
  player1Side?: Color;
  id?: string;
}
