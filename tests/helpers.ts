import type { Color, PieceIdentity, PieceType } from "../shared/contracts";
import type { InternalPiece } from "../engine/types";

export function testPiece(
  id: string,
  color: Color,
  type: PieceType,
  x: number,
  y: number,
  options: {
    revealed?: boolean;
    trueIdentity?: PieceIdentity;
    publicIdentity?: PieceIdentity;
  } = {},
): InternalPiece {
  const publicIdentity = options.publicIdentity ?? { color, type };
  const trueIdentity = options.trueIdentity ?? { color, type };
  return {
    id,
    position: { x, y },
    publicIdentity: { ...publicIdentity },
    trueIdentity: { ...trueIdentity },
    revealed: options.revealed ?? true,
  };
}

export const hasSquare = (
  moves: { x: number; y: number }[],
  x: number,
  y: number,
) => moves.some((move) => move.x === x && move.y === y);
