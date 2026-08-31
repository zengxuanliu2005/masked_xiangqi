import { randomUUID } from "node:crypto";
import type {
  Color,
  PieceIdentity,
  PieceType,
  Position,
} from "../shared/contracts";
import type {
  GameState,
  InternalPiece,
  NewGameOptions,
  ScenarioOptions,
} from "./types";
import { positionKey } from "./rules";
import { createSeededRng, generateGameSeed, normalizeGameSeed } from "./seed";

interface InitialSlot {
  position: Position;
  identity: PieceIdentity;
}

const slot = (
  color: Color,
  type: PieceType,
  x: number,
  y: number,
): InitialSlot => ({ position: { x, y }, identity: { color, type } });

export const INITIAL_SLOTS: readonly InitialSlot[] = [
  slot("black", "rook", 0, 0),
  slot("black", "horse", 1, 0),
  slot("black", "elephant", 2, 0),
  slot("black", "advisor", 3, 0),
  slot("black", "general", 4, 0),
  slot("black", "advisor", 5, 0),
  slot("black", "elephant", 6, 0),
  slot("black", "horse", 7, 0),
  slot("black", "rook", 8, 0),
  slot("black", "cannon", 1, 2),
  slot("black", "cannon", 7, 2),
  slot("black", "pawn", 0, 3),
  slot("black", "pawn", 2, 3),
  slot("black", "pawn", 4, 3),
  slot("black", "pawn", 6, 3),
  slot("black", "pawn", 8, 3),
  slot("red", "pawn", 0, 6),
  slot("red", "pawn", 2, 6),
  slot("red", "pawn", 4, 6),
  slot("red", "pawn", 6, 6),
  slot("red", "pawn", 8, 6),
  slot("red", "cannon", 1, 7),
  slot("red", "cannon", 7, 7),
  slot("red", "rook", 0, 9),
  slot("red", "horse", 1, 9),
  slot("red", "elephant", 2, 9),
  slot("red", "advisor", 3, 9),
  slot("red", "general", 4, 9),
  slot("red", "advisor", 5, 9),
  slot("red", "elephant", 6, 9),
  slot("red", "horse", 7, 9),
  slot("red", "rook", 8, 9),
];

const cloneIdentity = (identity: PieceIdentity): PieceIdentity => ({
  ...identity,
});

const shuffle = <T>(values: T[], rng: () => number): T[] => {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
  }
  return values;
};

export function createGame(options: NewGameOptions): GameState {
  const id = options.id ?? randomUUID();
  const seed = normalizeGameSeed(options.seed ?? generateGameSeed());
  const rng = options.rng ?? createSeededRng(seed);
  const coveredSlots = INITIAL_SLOTS.filter(
    ({ identity }) => identity.type !== "general",
  );
  const shuffledIdentities = shuffle(
    coveredSlots.map(({ identity }) => cloneIdentity(identity)),
    rng,
  );
  let coveredIndex = 0;

  const pieces: InternalPiece[] = INITIAL_SLOTS.map((initialSlot, index) => {
    const isGeneral = initialSlot.identity.type === "general";
    const trueIdentity = isGeneral
      ? cloneIdentity(initialSlot.identity)
      : shuffledIdentities[coveredIndex++];

    return {
      id: `piece-${index + 1}`,
      position: { ...initialSlot.position },
      publicIdentity: cloneIdentity(initialSlot.identity),
      trueIdentity,
      revealed: isGeneral,
    };
  });

  const createdAt = new Date().toISOString();
  const game: GameState = {
    id,
    seed,
    mode: options.mode,
    allowDraw: options.allowDraw ?? true,
    allowUndo: options.allowUndo ?? true,
    matchType: options.matchType ?? "human-human",
    aiModel: options.aiModel ?? null,
    player1Side: options.player1Side,
    turn: "red",
    revision: 0,
    moveNumber: 0,
    pieces,
    captured: { red: [], black: [] },
    status: { phase: "active", winner: null, reason: null },
    lastMove: null,
    positionCounts: new Map(),
    undoStack: [],
    createdAt,
    updatedAt: createdAt,
    lastAccessedAt: createdAt,
    finishedAt: null,
  };
  game.positionCounts.set(positionKey(game), 1);
  return game;
}

/** A deterministic constructor used by rule tests and embedders. */
export function createScenario(options: ScenarioOptions): GameState {
  const createdAt = new Date(0).toISOString();
  const game: GameState = {
    id: options.id ?? "scenario",
    seed: normalizeGameSeed(options.seed ?? "scenario"),
    mode: options.mode ?? "standard",
    allowDraw: options.allowDraw ?? true,
    allowUndo: options.allowUndo ?? true,
    matchType: options.matchType ?? "human-human",
    aiModel: options.aiModel ?? null,
    player1Side: options.player1Side ?? "red",
    turn: options.turn ?? "red",
    revision: 0,
    moveNumber: 0,
    pieces: options.pieces.map((piece) => ({
      ...piece,
      position: piece.position ? { ...piece.position } : null,
      publicIdentity: { ...piece.publicIdentity },
      trueIdentity: { ...piece.trueIdentity },
    })),
    captured: { red: [], black: [] },
    status: { phase: "active", winner: null, reason: null },
    lastMove: null,
    positionCounts: new Map(),
    undoStack: [],
    createdAt,
    updatedAt: createdAt,
    lastAccessedAt: createdAt,
    finishedAt: null,
  };
  game.positionCounts.set(positionKey(game), 1);
  return game;
}
