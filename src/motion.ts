import type {
  PieceType,
  Position,
  PublicBoardPiece,
  PublicGameState,
} from "../shared/contracts";

export interface BoardMotion {
  key: string;
  piece: PublicBoardPiece;
  capturedPiece?: PublicBoardPiece;
  from: Position;
  to: Position;
  midpoint: Position;
  horseLeg: Position;
  travelType: PieceType;
  captures: boolean;
  durationMs: number;
}

const samePosition = (left: Position, right: Position) =>
  left.x === right.x && left.y === right.y;

const midpoint = (from: Position, to: Position): Position => ({
  x: (from.x + to.x) / 2,
  y: (from.y + to.y) / 2,
});

const horseLeg = (from: Position, to: Position): Position => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return Math.abs(dx) === 2
    ? { x: from.x + Math.sign(dx), y: from.y }
    : { x: from.x, y: from.y + Math.sign(dy) };
};

const motionDuration = (type: PieceType, captures: boolean): number => {
  if (captures) {
    if (type === "cannon") return 680;
    if (type === "horse") return 640;
    return 570;
  }
  if (type === "horse") return 560;
  if (type === "elephant") return 520;
  if (type === "rook") return 430;
  return 470;
};

/**
 * Builds a visual transition from two already-sanitized public positions.
 * Animation code never needs access to a covered piece's true identity.
 */
export function deriveBoardMotion(
  previous: PublicGameState,
  next: PublicGameState,
): BoardMotion | null {
  if (
    next.id !== previous.id ||
    next.revision !== previous.revision + 1 ||
    next.moveNumber !== previous.moveNumber + 1 ||
    !next.lastMove
  ) {
    return null;
  }

  const mover = previous.board.find(
    (piece) => piece.id === next.lastMove?.pieceId,
  );
  if (!mover || !samePosition(mover.position, next.lastMove.from)) return null;

  const travelIdentity = mover.faceUp
    ? (mover.identity ?? mover.publicIdentity)
    : mover.publicIdentity;
  const capturedBefore = previous.board.find(
    (piece) =>
      piece.id !== mover.id && samePosition(piece.position, next.lastMove!.to),
  );
  const capturedPublic = next.lastMove.capturedPiece;
  const capturedPiece = capturedPublic
    ? {
        ...(capturedBefore ?? {
          id: capturedPublic.id,
          position: { ...next.lastMove.to },
          publicIdentity: { ...capturedPublic.publicIdentity },
        }),
        position: { ...next.lastMove.to },
        faceUp: true,
        identity: { ...capturedPublic.identity },
        controller: capturedPublic.identity.color,
      }
    : undefined;
  const captures = Boolean(capturedPiece);

  return {
    key: `${next.id}:${next.revision}:${mover.id}`,
    piece: {
      ...mover,
      position: { ...mover.position },
      publicIdentity: { ...mover.publicIdentity },
      ...(mover.identity ? { identity: { ...mover.identity } } : {}),
    },
    ...(capturedPiece ? { capturedPiece } : {}),
    from: { ...next.lastMove.from },
    to: { ...next.lastMove.to },
    midpoint: midpoint(next.lastMove.from, next.lastMove.to),
    horseLeg: horseLeg(next.lastMove.from, next.lastMove.to),
    travelType: travelIdentity.type,
    captures,
    durationMs: motionDuration(travelIdentity.type, captures),
  };
}

export function prefersReducedBoardMotion(): boolean {
  if (typeof window === "undefined") return true;
  if (window.navigator.userAgent.toLowerCase().includes("jsdom")) return true;
  return Boolean(
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );
}
