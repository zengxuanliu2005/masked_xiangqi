import {
  oppositeColor,
  type Color,
  type LegalMove,
  type Position,
  type PublicCapturedPiece,
  type PublicGameState,
} from "../shared/contracts";
import type { GameState, InternalLastMove, UndoSnapshot } from "./types";
import {
  controllerOf,
  getAllLegalMoves,
  getLegalMovesForPiece,
  isInCheck,
  isInsideBoard,
  pieceAt,
  positionKey,
  samePosition,
} from "./rules";

export type RuleErrorCode =
  | "STALE_REVISION"
  | "GAME_FINISHED"
  | "INVALID_POSITION"
  | "NO_PIECE"
  | "WRONG_SIDE"
  | "ILLEGAL_MOVE"
  | "PIECE_NOT_FOUND"
  | "UNDO_DISABLED"
  | "NO_UNDO_AVAILABLE";

export class GameRuleError extends Error {
  constructor(
    public readonly code: RuleErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "GameRuleError";
  }
}

export interface MoveCommand {
  from: Position;
  to: Position;
  expectedRevision: number;
}

export const MAX_UNDO_PLY = 256;
export const MAX_POSITION_COUNTS = 512;

const markUpdated = (game: GameState, finished = false): void => {
  const timestamp = new Date().toISOString();
  game.updatedAt = timestamp;
  game.lastAccessedAt = timestamp;
  game.finishedAt = finished ? timestamp : null;
};

const assertRevision = (game: GameState, expectedRevision: number): void => {
  if (expectedRevision !== game.revision) {
    throw new GameRuleError(
      "STALE_REVISION",
      "局面已更新，请读取最新版本后重试。",
      {
        expectedRevision,
        actualRevision: game.revision,
      },
    );
  }
};

const assertActiveRevision = (
  game: GameState,
  expectedRevision: number,
): void => {
  if (game.status.phase !== "active") {
    throw new GameRuleError("GAME_FINISHED", "对局已经结束，不能继续操作。", {
      status: game.status,
    });
  }
  assertRevision(game, expectedRevision);
};

const cloneCapturedPiece = (
  piece: PublicCapturedPiece,
): PublicCapturedPiece => ({
  ...piece,
  identity: { ...piece.identity },
  publicIdentity: { ...piece.publicIdentity },
});

const cloneLastMove = (
  lastMove: InternalLastMove | null,
): InternalLastMove | null =>
  lastMove
    ? {
        ...lastMove,
        from: { ...lastMove.from },
        to: { ...lastMove.to },
        ...(lastMove.revealedIdentity
          ? { revealedIdentity: { ...lastMove.revealedIdentity } }
          : {}),
        ...(lastMove.capturedPiece
          ? { capturedPiece: cloneCapturedPiece(lastMove.capturedPiece) }
          : {}),
      }
    : null;

const createUndoSnapshot = (game: GameState): UndoSnapshot => ({
  turn: game.turn,
  moveNumber: game.moveNumber,
  pieces: game.pieces.map((piece) => ({
    ...piece,
    position: piece.position ? { ...piece.position } : null,
    publicIdentity: { ...piece.publicIdentity },
    trueIdentity: { ...piece.trueIdentity },
  })),
  captured: {
    red: game.captured.red.map(cloneCapturedPiece),
    black: game.captured.black.map(cloneCapturedPiece),
  },
  status: { ...game.status },
  lastMove: cloneLastMove(game.lastMove),
  positionCounts: new Map(game.positionCounts),
});

const undoTargetIndex = (game: GameState): number => {
  if (!game.allowUndo || game.status.reason === "resignation") return -1;
  if (game.matchType === "human-human") return game.undoStack.length - 1;

  for (let index = game.undoStack.length - 1; index >= 0; index -= 1) {
    if (game.undoStack[index].turn === game.player1Side) return index;
  }
  return -1;
};

export const canUndo = (game: GameState): boolean => undoTargetIndex(game) >= 0;

const publicCapturedPiece = (
  game: GameState,
  pieceId: string,
  capturedBy: Color,
  moveNumber: number,
): PublicCapturedPiece => {
  const piece = game.pieces.find((candidate) => candidate.id === pieceId)!;
  return {
    id: piece.id,
    identity: { ...piece.trueIdentity },
    publicIdentity: { ...piece.publicIdentity },
    capturedBy,
    moveNumber,
  };
};

export function applyMove(game: GameState, command: MoveCommand): GameState {
  assertActiveRevision(game, command.expectedRevision);
  if (!isInsideBoard(command.from) || !isInsideBoard(command.to)) {
    throw new GameRuleError(
      "INVALID_POSITION",
      "起点和终点必须位于 9×10 棋盘内。",
    );
  }
  const movingPiece = pieceAt(game, command.from);
  if (!movingPiece) {
    throw new GameRuleError("NO_PIECE", "起点没有棋子。", {
      from: command.from,
    });
  }
  if (controllerOf(movingPiece) !== game.turn) {
    throw new GameRuleError("WRONG_SIDE", "该棋子不属于当前行棋方。", {
      turn: game.turn,
    });
  }

  const legalMove = getLegalMovesForPiece(game, movingPiece).find((move) =>
    samePosition(move.to, command.to),
  );
  if (!legalMove) {
    throw new GameRuleError("ILLEGAL_MOVE", "该着法不合法。", {
      from: command.from,
      to: command.to,
    });
  }

  if (game.allowUndo) {
    game.undoStack.push(createUndoSnapshot(game));
    if (game.undoStack.length > MAX_UNDO_PLY) game.undoStack.shift();
  }

  const mover = game.turn;
  const nextMoveNumber = game.moveNumber + 1;
  const wasCovered = !movingPiece.revealed;
  const capturedPiece = pieceAt(game, command.to);
  const capturedRecord = capturedPiece
    ? publicCapturedPiece(game, capturedPiece.id, mover, nextMoveNumber)
    : undefined;

  if (capturedPiece) {
    capturedPiece.position = null;
    capturedPiece.revealed = true;
    game.captured[mover].push(capturedRecord!);
  }
  movingPiece.position = { ...command.to };
  movingPiece.revealed = true;

  game.moveNumber = nextMoveNumber;
  game.revision += 1;
  game.lastMove = {
    pieceId: movingPiece.id,
    from: { ...command.from },
    to: { ...command.to },
    ...(capturedRecord ? { capturedPiece: capturedRecord } : {}),
    ...(wasCovered
      ? { revealedIdentity: { ...movingPiece.trueIdentity } }
      : {}),
  };

  if (capturedPiece?.trueIdentity.type === "general") {
    game.status = {
      phase: "finished",
      winner: mover,
      reason: "general-captured",
    };
    markUpdated(game, true);
    return game;
  }

  game.turn = oppositeColor(mover);

  if (game.mode === "standard") {
    const replies = getAllLegalMoves(game);
    if (replies.length === 0) {
      game.status = {
        phase: "finished",
        winner: mover,
        reason: isInCheck(game, game.turn) ? "checkmate" : "stalemate",
      };
      markUpdated(game, true);
      return game;
    }
  }

  const key = positionKey(game);
  const repetitions = (game.positionCounts.get(key) ?? 0) + 1;
  game.positionCounts.set(key, repetitions);
  while (game.positionCounts.size > MAX_POSITION_COUNTS) {
    const oldest = game.positionCounts.keys().next().value as
      string | undefined;
    if (oldest === undefined) break;
    game.positionCounts.delete(oldest);
  }
  if (game.allowDraw && repetitions >= 3) {
    game.status = {
      phase: "finished",
      winner: null,
      reason: "threefold-repetition",
    };
  }
  markUpdated(game, game.status.phase === "finished");
  return game;
}

export function resign(game: GameState, expectedRevision: number): GameState {
  assertActiveRevision(game, expectedRevision);
  game.status = {
    phase: "finished",
    winner: oppositeColor(game.turn),
    reason: "resignation",
  };
  game.revision += 1;
  markUpdated(game, true);
  return game;
}

export function undo(game: GameState, expectedRevision: number): GameState {
  assertRevision(game, expectedRevision);
  if (!game.allowUndo) {
    throw new GameRuleError("UNDO_DISABLED", "本局开局时已关闭悔棋。", {
      allowUndo: false,
    });
  }

  const targetIndex = undoTargetIndex(game);
  if (targetIndex < 0) {
    throw new GameRuleError("NO_UNDO_AVAILABLE", "当前没有可以撤回的着法。");
  }

  const snapshot = game.undoStack[targetIndex];
  const nextRevision = game.revision + 1;
  game.turn = snapshot.turn;
  game.moveNumber = snapshot.moveNumber;
  game.pieces = snapshot.pieces.map((piece) => ({
    ...piece,
    position: piece.position ? { ...piece.position } : null,
    publicIdentity: { ...piece.publicIdentity },
    trueIdentity: { ...piece.trueIdentity },
  }));
  game.captured = {
    red: snapshot.captured.red.map(cloneCapturedPiece),
    black: snapshot.captured.black.map(cloneCapturedPiece),
  };
  game.status = { ...snapshot.status };
  game.lastMove = cloneLastMove(snapshot.lastMove);
  game.positionCounts = new Map(snapshot.positionCounts);
  game.undoStack = game.undoStack.slice(0, targetIndex);
  game.revision = nextRevision;
  markUpdated(game, game.status.phase === "finished");
  return game;
}

export function legalMoves(game: GameState, pieceId?: string): LegalMove[] {
  if (!pieceId) return getAllLegalMoves(game);
  const piece = game.pieces.find((candidate) => candidate.id === pieceId);
  if (!piece) {
    throw new GameRuleError("PIECE_NOT_FOUND", "没有找到指定棋子。", {
      pieceId,
    });
  }
  return getLegalMovesForPiece(game, piece);
}

export function toPublicGame(game: GameState): PublicGameState {
  const board = game.pieces
    .filter((piece) => piece.position)
    .map((piece) => ({
      id: piece.id,
      position: { ...piece.position! },
      faceUp: piece.revealed,
      publicIdentity: { ...piece.publicIdentity },
      ...(piece.revealed ? { identity: { ...piece.trueIdentity } } : {}),
      controller: controllerOf(piece),
    }))
    .sort(
      (left, right) =>
        left.position.y - right.position.y ||
        left.position.x - right.position.x,
    );

  return {
    id: game.id,
    seed: game.status.phase === "finished" ? game.seed : null,
    mode: game.mode,
    allowDraw: game.allowDraw,
    allowUndo: game.allowUndo,
    canUndo: canUndo(game),
    matchType: game.matchType,
    aiModel: game.aiModel,
    revision: game.revision,
    turn: game.turn,
    moveNumber: game.moveNumber,
    players: {
      player1: game.player1Side,
      player2: oppositeColor(game.player1Side),
    },
    status: { ...game.status },
    check:
      game.mode === "standard" &&
      game.status.phase === "active" &&
      isInCheck(game, game.turn)
        ? game.turn
        : null,
    board,
    captured: {
      red: game.captured.red.map((piece) => ({
        ...piece,
        identity: { ...piece.identity },
        publicIdentity: { ...piece.publicIdentity },
      })),
      black: game.captured.black.map((piece) => ({
        ...piece,
        identity: { ...piece.identity },
        publicIdentity: { ...piece.publicIdentity },
      })),
    },
    lastMove: game.lastMove
      ? {
          ...game.lastMove,
          from: { ...game.lastMove.from },
          to: { ...game.lastMove.to },
          ...(game.lastMove.revealedIdentity
            ? { revealedIdentity: { ...game.lastMove.revealedIdentity } }
            : {}),
          ...(game.lastMove.capturedPiece
            ? {
                capturedPiece: {
                  ...game.lastMove.capturedPiece,
                  identity: { ...game.lastMove.capturedPiece.identity },
                  publicIdentity: {
                    ...game.lastMove.capturedPiece.publicIdentity,
                  },
                },
              }
            : {}),
        }
      : null,
    createdAt: game.createdAt,
  };
}
