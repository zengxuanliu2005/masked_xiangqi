import { describe, expect, it } from "vitest";
import {
  applyMove,
  legalMoves,
  resign,
  toPublicGame,
  undo,
} from "../engine/game";
import { controllerOf, getAllLegalMoves, isInCheck } from "../engine/rules";
import { createScenario } from "../engine/setup";
import { hasSquare, testPiece } from "./helpers";

describe("暗子揭晓与控制权", () => {
  it("暗子第一步按位置身份行动，落子后翻面并转换控制方", () => {
    const hidden = testPiece("hidden", "red", "pawn", 4, 6, {
      revealed: false,
      trueIdentity: { color: "black", type: "rook" },
    });
    const game = createScenario({
      mode: "capture-general",
      turn: "red",
      pieces: [hidden],
    });

    expect(legalMoves(game, hidden.id).map((move) => move.to)).toEqual([
      { x: 4, y: 5 },
    ]);
    applyMove(game, {
      from: { x: 4, y: 6 },
      to: { x: 4, y: 5 },
      expectedRevision: 0,
    });

    const revealed = game.pieces.find((piece) => piece.id === hidden.id)!;
    expect(revealed.revealed).toBe(true);
    expect(revealed.position).toEqual({ x: 4, y: 5 });
    expect(controllerOf(revealed)).toBe("black");
    expect(game.turn).toBe("black");
    expect(game.lastMove?.revealedIdentity).toEqual({
      color: "black",
      type: "rook",
    });
    expect(
      getAllLegalMoves(game).some((move) => move.pieceId === hidden.id),
    ).toBe(true);
  });

  it("暗子被吃时立即公开真实身份，即使真实颜色与吃子方相同", () => {
    const rook = testPiece("rook", "red", "rook", 0, 0);
    const hiddenTarget = testPiece("target", "black", "pawn", 0, 3, {
      revealed: false,
      trueIdentity: { color: "red", type: "horse" },
    });
    const game = createScenario({
      mode: "capture-general",
      turn: "red",
      pieces: [rook, hiddenTarget],
    });

    applyMove(game, {
      from: { x: 0, y: 0 },
      to: { x: 0, y: 3 },
      expectedRevision: 0,
    });

    const captured = game.pieces.find((piece) => piece.id === hiddenTarget.id)!;
    expect(captured.position).toBeNull();
    expect(captured.revealed).toBe(true);
    expect(game.captured.red).toHaveLength(1);
    expect(game.captured.red[0].identity).toEqual({
      color: "red",
      type: "horse",
    });
    expect(toPublicGame(game).lastMove?.capturedPiece?.identity).toEqual({
      color: "red",
      type: "horse",
    });
  });

  it("未翻暗子按公开位置身份参与将军判断", () => {
    const game = createScenario({
      mode: "standard",
      turn: "black",
      pieces: [
        testPiece("black-general", "black", "general", 4, 0),
        testPiece("red-general", "red", "general", 4, 9),
        testPiece("hidden-rook", "red", "rook", 4, 2, {
          revealed: false,
          trueIdentity: { color: "black", type: "pawn" },
        }),
      ],
    });

    expect(isInCheck(game, "black")).toBe(true);
    expect(toPublicGame(game).check).toBe("black");
  });

  it("揭晓产生的新自将不会撤销已经按位置身份合法完成的着法", () => {
    const hidden = testPiece("hidden", "red", "pawn", 4, 6, {
      revealed: false,
      trueIdentity: { color: "black", type: "rook" },
    });
    const game = createScenario({
      mode: "standard",
      turn: "red",
      pieces: [
        testPiece("black-general", "black", "general", 4, 0),
        testPiece("red-general", "red", "general", 4, 9),
        hidden,
      ],
    });

    expect(
      hasSquare(
        legalMoves(game, hidden.id).map((move) => move.to),
        4,
        5,
      ),
    ).toBe(true);
    expect(() =>
      applyMove(game, {
        from: { x: 4, y: 6 },
        to: { x: 4, y: 5 },
        expectedRevision: 0,
      }),
    ).not.toThrow();
    expect(isInCheck(game, "red")).toBe(true);
    expect(game.turn).toBe("black");
  });
});

describe("标准模式约束与终局", () => {
  it("过河兵可向前或横走，并可直接吃将结束标准模式", () => {
    const pawn = testPiece("red-pawn", "red", "pawn", 4, 1);
    const game = createScenario({
      mode: "standard",
      turn: "red",
      pieces: [
        testPiece("black-general", "black", "general", 4, 0),
        testPiece("red-general", "red", "general", 3, 9),
        pawn,
      ],
    });

    const destinations = legalMoves(game, pawn.id).map((move) => move.to);
    expect(hasSquare(destinations, 4, 0)).toBe(true);
    expect(hasSquare(destinations, 3, 1)).toBe(true);
    expect(hasSquare(destinations, 5, 1)).toBe(true);

    applyMove(game, {
      from: { x: 4, y: 1 },
      to: { x: 4, y: 0 },
      expectedRevision: 0,
    });
    expect(game.status).toEqual({
      phase: "finished",
      winner: "red",
      reason: "general-captured",
    });
  });

  it("禁止移动遮挡子后暴露己方主帅", () => {
    const shield = testPiece("shield", "red", "rook", 4, 5);
    const game = createScenario({
      mode: "standard",
      turn: "red",
      pieces: [
        testPiece("red-general", "red", "general", 4, 9),
        testPiece("black-general", "black", "general", 3, 0),
        testPiece("black-rook", "black", "rook", 4, 0),
        shield,
      ],
    });

    expect(
      hasSquare(
        legalMoves(game, shield.id).map((move) => move.to),
        5,
        5,
      ),
    ).toBe(false);
  });

  it("禁止移开将帅之间的最后一个阻挡", () => {
    const shield = testPiece("shield", "red", "rook", 4, 5);
    const game = createScenario({
      mode: "standard",
      turn: "red",
      pieces: [
        testPiece("red-general", "red", "general", 4, 9),
        testPiece("black-general", "black", "general", 4, 0),
        shield,
      ],
    });
    expect(
      hasSquare(
        legalMoves(game, shield.id).map((move) => move.to),
        5,
        5,
      ),
    ).toBe(false);
  });

  it("完成将死后立即判当前行棋方获胜", () => {
    const matingRook = testPiece("mating-rook", "red", "rook", 4, 2);
    const game = createScenario({
      mode: "standard",
      turn: "red",
      pieces: [
        testPiece("black-general", "black", "general", 4, 0),
        testPiece("red-general", "red", "general", 4, 9),
        testPiece("left-rook", "red", "rook", 3, 1),
        testPiece("right-rook", "red", "rook", 5, 1),
        matingRook,
      ],
    });

    applyMove(game, {
      from: { x: 4, y: 2 },
      to: { x: 4, y: 1 },
      expectedRevision: 0,
    });
    expect(game.status).toEqual({
      phase: "finished",
      winner: "red",
      reason: "checkmate",
    });
  });

  it("无合法着但未被将军时按困毙判负", () => {
    const mover = testPiece("mover", "red", "rook", 0, 9);
    const game = createScenario({
      mode: "standard",
      turn: "red",
      pieces: [
        testPiece("black-general", "black", "general", 4, 0),
        testPiece("red-general", "red", "general", 4, 9),
        testPiece("left-rook", "red", "rook", 3, 1),
        testPiece("right-rook", "red", "rook", 5, 1),
        testPiece("file-blocker", "red", "pawn", 4, 5),
        mover,
      ],
    });

    applyMove(game, {
      from: { x: 0, y: 9 },
      to: { x: 0, y: 8 },
      expectedRevision: 0,
    });
    expect(game.status).toEqual({
      phase: "finished",
      winner: "red",
      reason: "stalemate",
    });
  });

  it("同一完整局面第三次出现时自动和棋", () => {
    const game = createScenario({
      mode: "capture-general",
      turn: "red",
      pieces: [
        testPiece("red-rook", "red", "rook", 0, 9),
        testPiece("black-rook", "black", "rook", 8, 0),
      ],
    });
    const cycle = [
      [
        { x: 0, y: 9 },
        { x: 0, y: 8 },
      ],
      [
        { x: 8, y: 0 },
        { x: 8, y: 1 },
      ],
      [
        { x: 0, y: 8 },
        { x: 0, y: 9 },
      ],
      [
        { x: 8, y: 1 },
        { x: 8, y: 0 },
      ],
    ] as const;

    for (let repetition = 0; repetition < 2; repetition += 1) {
      for (const [from, to] of cycle) {
        applyMove(game, { from, to, expectedRevision: game.revision });
      }
    }
    expect(game.status).toEqual({
      phase: "finished",
      winner: null,
      reason: "threefold-repetition",
    });
  });

  it("关闭和棋后第三次重复仍继续对局", () => {
    const game = createScenario({
      mode: "capture-general",
      allowDraw: false,
      turn: "red",
      pieces: [
        testPiece("red-rook", "red", "rook", 0, 9),
        testPiece("black-rook", "black", "rook", 8, 0),
      ],
    });
    const cycle = [
      [
        { x: 0, y: 9 },
        { x: 0, y: 8 },
      ],
      [
        { x: 8, y: 0 },
        { x: 8, y: 1 },
      ],
      [
        { x: 0, y: 8 },
        { x: 0, y: 9 },
      ],
      [
        { x: 8, y: 1 },
        { x: 8, y: 0 },
      ],
    ] as const;

    for (let repetition = 0; repetition < 2; repetition += 1) {
      for (const [from, to] of cycle) {
        applyMove(game, { from, to, expectedRevision: game.revision });
      }
    }
    expect(game.status).toEqual({
      phase: "active",
      winner: null,
      reason: null,
    });
  });
});

describe("吃主帅模式与认输", () => {
  it("忽略送将和将帅照面约束", () => {
    const shield = testPiece("shield", "red", "rook", 4, 5);
    const game = createScenario({
      mode: "capture-general",
      turn: "red",
      pieces: [
        testPiece("red-general", "red", "general", 4, 9),
        testPiece("black-general", "black", "general", 4, 0),
        shield,
      ],
    });
    expect(
      hasSquare(
        legalMoves(game, shield.id).map((move) => move.to),
        5,
        5,
      ),
    ).toBe(true);
  });

  it("实际吃掉对方主帅后结束", () => {
    const game = createScenario({
      mode: "capture-general",
      turn: "red",
      pieces: [
        testPiece("red-rook", "red", "rook", 4, 1),
        testPiece("black-general", "black", "general", 4, 0),
      ],
    });
    applyMove(game, {
      from: { x: 4, y: 1 },
      to: { x: 4, y: 0 },
      expectedRevision: 0,
    });
    expect(game.status).toEqual({
      phase: "finished",
      winner: "red",
      reason: "general-captured",
    });
    expect(() =>
      applyMove(game, {
        from: { x: 4, y: 0 },
        to: { x: 4, y: 1 },
        expectedRevision: 1,
      }),
    ).toThrowError(/已经结束/);
  });

  it("当前方认输后另一方获胜且版本递增", () => {
    const game = createScenario({
      mode: "standard",
      turn: "black",
      pieces: [
        testPiece("red-general", "red", "general", 4, 9),
        testPiece("black-general", "black", "general", 4, 0),
        testPiece("blocker", "red", "pawn", 4, 5),
      ],
    });
    resign(game, 0);
    expect(game.revision).toBe(1);
    expect(game.status).toEqual({
      phase: "finished",
      winner: "red",
      reason: "resignation",
    });
  });

  it("可以指定认输方，让局域网座位在对手回合也能认输", () => {
    const game = createScenario({
      mode: "standard",
      matchType: "lan-human",
      turn: "black",
      pieces: [
        testPiece("red-general", "red", "general", 4, 9),
        testPiece("black-general", "black", "general", 4, 0),
        testPiece("blocker", "red", "pawn", 4, 5),
      ],
    });

    // 轮到黑方，但认输的是红方座位。
    resign(game, 0, "red");
    expect(game.status).toEqual({
      phase: "finished",
      winner: "black",
      reason: "resignation",
    });
  });
});

describe("悔棋", () => {
  it("人人对战撤回最近一步，并恢复暗子、吃子区与回合", () => {
    const mover = testPiece("hidden-mover", "red", "pawn", 4, 6, {
      revealed: false,
      trueIdentity: { color: "black", type: "rook" },
    });
    const target = testPiece("hidden-target", "black", "pawn", 4, 5, {
      revealed: false,
      trueIdentity: { color: "red", type: "horse" },
    });
    const game = createScenario({
      mode: "capture-general",
      turn: "red",
      pieces: [mover, target],
    });

    applyMove(game, {
      from: { x: 4, y: 6 },
      to: { x: 4, y: 5 },
      expectedRevision: 0,
    });
    expect(toPublicGame(game).canUndo).toBe(true);
    expect(game.captured.red).toHaveLength(1);

    undo(game, 1);
    expect(game.revision).toBe(2);
    expect(game.moveNumber).toBe(0);
    expect(game.turn).toBe("red");
    expect(game.lastMove).toBeNull();
    expect(game.status.phase).toBe("active");
    expect(game.captured.red).toHaveLength(0);
    expect(game.pieces.find((piece) => piece.id === mover.id)).toMatchObject({
      position: { x: 4, y: 6 },
      revealed: false,
    });
    expect(game.pieces.find((piece) => piece.id === target.id)).toMatchObject({
      position: { x: 4, y: 5 },
      revealed: false,
    });
    expect(toPublicGame(game).canUndo).toBe(false);
  });

  it("局域网对战与同屏一样只撤回一步，不套用人机的整轮规则", () => {
    const game = createScenario({
      mode: "capture-general",
      matchType: "lan-human",
      player1Side: "red",
      turn: "red",
      pieces: [
        testPiece("red-rook", "red", "rook", 0, 9),
        testPiece("black-rook", "black", "rook", 8, 0),
      ],
    });
    applyMove(game, {
      from: { x: 0, y: 9 },
      to: { x: 0, y: 8 },
      expectedRevision: 0,
    });
    applyMove(game, {
      from: { x: 8, y: 0 },
      to: { x: 8, y: 1 },
      expectedRevision: 1,
    });

    undo(game, 2);
    // 只回退黑方那一步：轮次回到黑方，红车留在已走过的位置。
    expect(game.moveNumber).toBe(1);
    expect(game.turn).toBe("black");
    expect(
      game.pieces.find((piece) => piece.id === "red-rook")?.position,
    ).toEqual({ x: 0, y: 8 });
    expect(
      game.pieces.find((piece) => piece.id === "black-rook")?.position,
    ).toEqual({ x: 8, y: 0 });
  });

  it("人机对战一次悔棋回到玩家上一轮落子前", () => {
    const game = createScenario({
      mode: "capture-general",
      matchType: "human-ai",
      player1Side: "red",
      turn: "red",
      pieces: [
        testPiece("red-rook", "red", "rook", 0, 9),
        testPiece("black-rook", "black", "rook", 8, 0),
      ],
    });
    applyMove(game, {
      from: { x: 0, y: 9 },
      to: { x: 0, y: 8 },
      expectedRevision: 0,
    });
    applyMove(game, {
      from: { x: 8, y: 0 },
      to: { x: 8, y: 1 },
      expectedRevision: 1,
    });

    undo(game, 2);
    expect(game.revision).toBe(3);
    expect(game.moveNumber).toBe(0);
    expect(game.turn).toBe("red");
    expect(
      game.pieces.find((piece) => piece.id === "red-rook")?.position,
    ).toEqual({
      x: 0,
      y: 9,
    });
    expect(
      game.pieces.find((piece) => piece.id === "black-rook")?.position,
    ).toEqual({
      x: 8,
      y: 0,
    });
  });

  it("人类执黑时不能撤销模型开局，但可撤销之后的一整轮", () => {
    const game = createScenario({
      mode: "capture-general",
      matchType: "human-ai",
      player1Side: "black",
      turn: "red",
      pieces: [
        testPiece("red-rook", "red", "rook", 0, 9),
        testPiece("black-rook", "black", "rook", 8, 0),
      ],
    });
    applyMove(game, {
      from: { x: 0, y: 9 },
      to: { x: 0, y: 8 },
      expectedRevision: 0,
    });
    expect(toPublicGame(game).canUndo).toBe(false);

    applyMove(game, {
      from: { x: 8, y: 0 },
      to: { x: 8, y: 1 },
      expectedRevision: 1,
    });
    applyMove(game, {
      from: { x: 0, y: 8 },
      to: { x: 0, y: 7 },
      expectedRevision: 2,
    });
    undo(game, 3);

    expect(game.revision).toBe(4);
    expect(game.moveNumber).toBe(1);
    expect(game.turn).toBe("black");
    expect(
      game.pieces.find((piece) => piece.id === "red-rook")?.position,
    ).toEqual({
      x: 0,
      y: 8,
    });
    expect(
      game.pieces.find((piece) => piece.id === "black-rook")?.position,
    ).toEqual({
      x: 8,
      y: 0,
    });
  });

  it("关闭悔棋后拒绝回退，且仍保持递增版本保护", () => {
    const game = createScenario({
      mode: "capture-general",
      allowUndo: false,
      pieces: [testPiece("red-rook", "red", "rook", 0, 9)],
    });
    applyMove(game, {
      from: { x: 0, y: 9 },
      to: { x: 0, y: 8 },
      expectedRevision: 0,
    });

    expect(toPublicGame(game).canUndo).toBe(false);
    expect(() => undo(game, 0)).toThrowError(/局面已更新/);
    expect(() => undo(game, 1)).toThrowError(/关闭悔棋/);
    expect(game.revision).toBe(1);
  });
});
