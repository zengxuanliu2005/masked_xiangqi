import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  oppositeColor,
  type Color,
  type LegalMove,
  type PieceIdentity,
  type Position,
} from "../shared/contracts";
import type { GameState, InternalPiece } from "./types";

const ORTHOGONAL_DIRECTIONS: readonly Position[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

const DIAGONAL_DIRECTIONS: readonly Position[] = [
  { x: 1, y: 1 },
  { x: 1, y: -1 },
  { x: -1, y: 1 },
  { x: -1, y: -1 },
];

const HORSE_STEPS: readonly { destination: Position; leg: Position }[] = [
  { destination: { x: 2, y: 1 }, leg: { x: 1, y: 0 } },
  { destination: { x: 2, y: -1 }, leg: { x: 1, y: 0 } },
  { destination: { x: -2, y: 1 }, leg: { x: -1, y: 0 } },
  { destination: { x: -2, y: -1 }, leg: { x: -1, y: 0 } },
  { destination: { x: 1, y: 2 }, leg: { x: 0, y: 1 } },
  { destination: { x: -1, y: 2 }, leg: { x: 0, y: 1 } },
  { destination: { x: 1, y: -2 }, leg: { x: 0, y: -1 } },
  { destination: { x: -1, y: -2 }, leg: { x: 0, y: -1 } },
];

export const samePosition = (left: Position, right: Position): boolean =>
  left.x === right.x && left.y === right.y;

export const isInsideBoard = ({ x, y }: Position): boolean =>
  x >= 0 && x < BOARD_WIDTH && y >= 0 && y < BOARD_HEIGHT;

export const activeIdentity = (piece: InternalPiece): PieceIdentity =>
  piece.revealed ? piece.trueIdentity : piece.publicIdentity;

export const controllerOf = (piece: InternalPiece): Color =>
  activeIdentity(piece).color;

export const pieceAt = (
  game: Pick<GameState, "pieces">,
  position: Position,
): InternalPiece | undefined =>
  game.pieces.find(
    (piece) => piece.position && samePosition(piece.position, position),
  );

const canOccupy = (
  game: Pick<GameState, "pieces">,
  piece: InternalPiece,
  destination: Position,
): boolean => {
  const occupant = pieceAt(game, destination);
  return !occupant || controllerOf(occupant) !== controllerOf(piece);
};

const inPalace = (color: Color, position: Position): boolean => {
  if (position.x < 3 || position.x > 5) return false;
  return color === "red"
    ? position.y >= 7 && position.y <= 9
    : position.y >= 0 && position.y <= 2;
};

const rayMoves = (
  game: Pick<GameState, "pieces">,
  piece: InternalPiece,
): Position[] => {
  if (!piece.position) return [];
  const result: Position[] = [];
  for (const direction of ORTHOGONAL_DIRECTIONS) {
    let distance = 1;
    while (true) {
      const destination = {
        x: piece.position.x + direction.x * distance,
        y: piece.position.y + direction.y * distance,
      };
      if (!isInsideBoard(destination)) break;
      const occupant = pieceAt(game, destination);
      if (!occupant) {
        result.push(destination);
      } else {
        if (controllerOf(occupant) !== controllerOf(piece)) {
          result.push(destination);
        }
        break;
      }
      distance += 1;
    }
  }
  return result;
};

const cannonMoves = (
  game: Pick<GameState, "pieces">,
  piece: InternalPiece,
): Position[] => {
  if (!piece.position) return [];
  const result: Position[] = [];
  for (const direction of ORTHOGONAL_DIRECTIONS) {
    let distance = 1;
    let foundScreen = false;
    while (true) {
      const destination = {
        x: piece.position.x + direction.x * distance,
        y: piece.position.y + direction.y * distance,
      };
      if (!isInsideBoard(destination)) break;
      const occupant = pieceAt(game, destination);
      if (!foundScreen) {
        if (occupant) {
          foundScreen = true;
        } else {
          result.push(destination);
        }
      } else if (occupant) {
        if (controllerOf(occupant) !== controllerOf(piece)) {
          result.push(destination);
        }
        break;
      }
      distance += 1;
    }
  }
  return result;
};

const generalMoves = (
  game: Pick<GameState, "pieces">,
  piece: InternalPiece,
): Position[] => {
  if (!piece.position) return [];
  const color = controllerOf(piece);
  const result = ORTHOGONAL_DIRECTIONS.map((direction) => ({
    x: piece.position!.x + direction.x,
    y: piece.position!.y + direction.y,
  })).filter(
    (destination) =>
      isInsideBoard(destination) &&
      inPalace(color, destination) &&
      canOccupy(game, piece, destination),
  );

  const opposingGeneral = game.pieces.find(
    (candidate) =>
      candidate.position &&
      activeIdentity(candidate).type === "general" &&
      controllerOf(candidate) !== color,
  );
  if (
    opposingGeneral?.position &&
    opposingGeneral.position.x === piece.position.x
  ) {
    const low = Math.min(piece.position.y, opposingGeneral.position.y) + 1;
    const high = Math.max(piece.position.y, opposingGeneral.position.y);
    let blocked = false;
    for (let y = low; y < high; y += 1) {
      if (pieceAt(game, { x: piece.position.x, y })) {
        blocked = true;
        break;
      }
    }
    if (!blocked) result.push({ ...opposingGeneral.position });
  }

  return result;
};

export function getPseudoMovesForPiece(
  game: Pick<GameState, "pieces">,
  piece: InternalPiece,
): Position[] {
  if (!piece.position) return [];
  const identity = activeIdentity(piece);
  const { x, y } = piece.position;

  switch (identity.type) {
    case "general":
      return generalMoves(game, piece);
    case "advisor":
      return DIAGONAL_DIRECTIONS.map((direction) => ({
        x: x + direction.x,
        y: y + direction.y,
      })).filter(
        (destination) =>
          isInsideBoard(destination) &&
          (piece.revealed || inPalace(identity.color, destination)) &&
          canOccupy(game, piece, destination),
      );
    case "elephant":
      return DIAGONAL_DIRECTIONS.map((direction) => ({
        destination: { x: x + direction.x * 2, y: y + direction.y * 2 },
        eye: { x: x + direction.x, y: y + direction.y },
      }))
        .filter(
          ({ destination, eye }) =>
            isInsideBoard(destination) &&
            !pieceAt(game, eye) &&
            canOccupy(game, piece, destination),
        )
        .map(({ destination }) => destination);
    case "horse":
      return HORSE_STEPS.map(({ destination, leg }) => ({
        destination: { x: x + destination.x, y: y + destination.y },
        leg: { x: x + leg.x, y: y + leg.y },
      }))
        .filter(
          ({ destination, leg }) =>
            isInsideBoard(destination) &&
            !pieceAt(game, leg) &&
            canOccupy(game, piece, destination),
        )
        .map(({ destination }) => destination);
    case "rook":
      return rayMoves(game, piece);
    case "cannon":
      return cannonMoves(game, piece);
    case "pawn": {
      const forward = identity.color === "red" ? -1 : 1;
      const crossedRiver = identity.color === "red" ? y <= 4 : y >= 5;
      const candidates = [{ x, y: y + forward }];
      if (crossedRiver) {
        candidates.push({ x: x - 1, y }, { x: x + 1, y });
      }
      return candidates.filter(
        (destination) =>
          isInsideBoard(destination) && canOccupy(game, piece, destination),
      );
    }
  }
}

export function isSquareAttacked(
  game: Pick<GameState, "pieces">,
  position: Position,
  byColor: Color,
): boolean {
  return game.pieces.some(
    (piece) =>
      piece.position &&
      controllerOf(piece) === byColor &&
      getPseudoMovesForPiece(game, piece).some((move) =>
        samePosition(move, position),
      ),
  );
}

export function isInCheck(
  game: Pick<GameState, "pieces">,
  color: Color,
): boolean {
  const general = game.pieces.find(
    (piece) =>
      piece.position &&
      controllerOf(piece) === color &&
      activeIdentity(piece).type === "general",
  );
  if (!general?.position) return true;
  return isSquareAttacked(game, general.position, oppositeColor(color));
}

const simulatedBeforeReveal = (
  game: GameState,
  movingPiece: InternalPiece,
  destination: Position,
): GameState => ({
  ...game,
  pieces: game.pieces.map((piece) => {
    if (piece.id === movingPiece.id) {
      return { ...piece, position: { ...destination } };
    }
    if (piece.position && samePosition(piece.position, destination)) {
      return { ...piece, position: null };
    }
    return piece;
  }),
});

export function getLegalMovesForPiece(
  game: GameState,
  piece: InternalPiece,
): LegalMove[] {
  if (
    game.status.phase !== "active" ||
    !piece.position ||
    controllerOf(piece) !== game.turn
  ) {
    return [];
  }

  const from = { ...piece.position };
  return getPseudoMovesForPiece(game, piece)
    .filter((destination) => {
      if (game.mode === "capture-general") return true;

      // A covered mover is still evaluated as its public square identity. The
      // reveal happens only after this already-legal position is accepted.
      const simulated = simulatedBeforeReveal(game, piece, destination);
      return !isInCheck(simulated, game.turn);
    })
    .map((to) => ({
      pieceId: piece.id,
      from,
      to,
      captures: Boolean(pieceAt(game, to)),
    }))
    .sort((left, right) => left.to.y - right.to.y || left.to.x - right.to.x);
}

export function getAllLegalMoves(game: GameState): LegalMove[] {
  if (game.status.phase !== "active") return [];
  return game.pieces
    .filter((piece) => piece.position && controllerOf(piece) === game.turn)
    .flatMap((piece) => getLegalMovesForPiece(game, piece));
}

export function positionKey(game: GameState): string {
  const pieces = game.pieces
    .filter((piece) => piece.position)
    .map((piece) => {
      const visibleIdentity = piece.revealed
        ? `${piece.trueIdentity.color}-${piece.trueIdentity.type}`
        : "covered";
      return [
        `${piece.position!.x},${piece.position!.y}`,
        piece.revealed ? "up" : "down",
        `${piece.publicIdentity.color}-${piece.publicIdentity.type}`,
        visibleIdentity,
      ].join(":");
    })
    .sort()
    .join("|");
  return `${game.turn}#${pieces}`;
}
