import { describe, expect, it } from "vitest";
import {
  PIECE_LABELS,
  type PublicBoardPiece,
  type PublicGameState,
} from "../shared/contracts";
import { deriveBoardMotion } from "../src/motion";

const piece = (
  id: string,
  x: number,
  y: number,
  options: Partial<PublicBoardPiece> = {},
): PublicBoardPiece => ({
  id,
  position: { x, y },
  faceUp: true,
  publicIdentity: { color: "red", type: "pawn" },
  identity: { color: "red", type: "pawn" },
  controller: "red",
  ...options,
});

const game = (
  board: PublicBoardPiece[],
  overrides: Partial<PublicGameState> = {},
): PublicGameState => ({
  id: "motion-game",
  seed: null,
  mode: "standard",
  allowDraw: true,
  allowUndo: true,
  canUndo: false,
  matchType: "human-human",
  aiModel: null,
  revision: 0,
  turn: "red",
  moveNumber: 0,
  players: { player1: "red", player2: "black" },
  status: { phase: "active", winner: null, reason: null },
  check: null,
  board,
  captured: { red: [], black: [] },
  lastMove: null,
  createdAt: "2026-08-30T00:00:00.000Z",
  ...overrides,
});

describe("棋盘动效模型", () => {
  it("使用暗子的公开位置身份选择移动动效", () => {
    const covered = piece("covered", 0, 6, {
      faceUp: false,
      identity: undefined,
      publicIdentity: { color: "red", type: "pawn" },
    });
    const previous = game([covered]);
    const next = game(
      [
        piece("covered", 0, 5, {
          publicIdentity: { color: "red", type: "pawn" },
          identity: { color: "black", type: "rook" },
          controller: "black",
        }),
      ],
      {
        revision: 1,
        moveNumber: 1,
        turn: "black",
        lastMove: {
          pieceId: "covered",
          from: { x: 0, y: 6 },
          to: { x: 0, y: 5 },
          revealedIdentity: { color: "black", type: "rook" },
        },
      },
    );

    expect(deriveBoardMotion(previous, next)).toMatchObject({
      travelType: "pawn",
      captures: false,
      from: { x: 0, y: 6 },
      to: { x: 0, y: 5 },
    });
  });

  it("马按蹩马腿对应的第一段位置跃进", () => {
    const horse = piece("horse", 1, 9, {
      publicIdentity: { color: "red", type: "horse" },
      identity: { color: "red", type: "horse" },
    });
    const previous = game([horse]);
    const next = game([{ ...horse, position: { x: 2, y: 7 } }], {
      revision: 1,
      moveNumber: 1,
      turn: "black",
      lastMove: {
        pieceId: "horse",
        from: { x: 1, y: 9 },
        to: { x: 2, y: 7 },
      },
    });

    expect(deriveBoardMotion(previous, next)).toMatchObject({
      travelType: "horse",
      horseLeg: { x: 1, y: 8 },
      durationMs: 560,
    });
  });

  it("吃子动效立即揭示被吃暗子的真实标准字形", () => {
    const rook = piece("rook", 0, 5, {
      publicIdentity: { color: "red", type: "rook" },
      identity: { color: "red", type: "rook" },
    });
    const target = piece("target", 0, 2, {
      faceUp: false,
      identity: undefined,
      publicIdentity: { color: "black", type: "cannon" },
      controller: "black",
    });
    const previous = game([rook, target]);
    const capturedPiece = {
      id: "target",
      identity: { color: "black" as const, type: "horse" as const },
      publicIdentity: { color: "black" as const, type: "cannon" as const },
      capturedBy: "red" as const,
      moveNumber: 1,
    };
    const next = game([{ ...rook, position: { x: 0, y: 2 } }], {
      revision: 1,
      moveNumber: 1,
      turn: "black",
      captured: { red: [capturedPiece], black: [] },
      lastMove: {
        pieceId: "rook",
        from: { x: 0, y: 5 },
        to: { x: 0, y: 2 },
        capturedPiece,
      },
    });

    const motion = deriveBoardMotion(previous, next);
    expect(motion).toMatchObject({
      travelType: "rook",
      captures: true,
      durationMs: 570,
      capturedPiece: {
        id: "target",
        faceUp: true,
        identity: { color: "black", type: "horse" },
      },
    });
    expect(
      PIECE_LABELS[motion!.capturedPiece!.identity!.color][
        motion!.capturedPiece!.identity!.type
      ],
    ).toBe("馬");
  });

  it("认输等非落子 revision 不重复播放最近一步", () => {
    const board = [piece("pawn", 0, 5)];
    const previous = game(board, { moveNumber: 1, revision: 1 });
    const resigned = game(board, {
      moveNumber: 1,
      revision: 2,
      status: { phase: "finished", winner: "black", reason: "resignation" },
    });
    expect(deriveBoardMotion(previous, resigned)).toBeNull();
  });

  it("红黑双方使用标准象棋字形", () => {
    expect(PIECE_LABELS.red).toEqual({
      general: "帥",
      advisor: "仕",
      elephant: "相",
      horse: "傌",
      rook: "俥",
      cannon: "炮",
      pawn: "兵",
    });
    expect(PIECE_LABELS.black).toEqual({
      general: "將",
      advisor: "士",
      elephant: "象",
      horse: "馬",
      rook: "車",
      cannon: "砲",
      pawn: "卒",
    });
  });
});
