import { describe, expect, it } from "vitest";
import { getPseudoMovesForPiece } from "../engine/rules";
import { createScenario } from "../engine/setup";
import { hasSquare, testPiece } from "./helpers";

const movesFor = (
  main: ReturnType<typeof testPiece>,
  blockers: ReturnType<typeof testPiece>[] = [],
) =>
  getPseudoMovesForPiece(
    createScenario({
      mode: "capture-general",
      pieces: [main, ...blockers],
    }),
    main,
  );

describe("棋子走法", () => {
  it("车直行并在第一枚棋子处停止", () => {
    const rook = testPiece("rook", "red", "rook", 4, 4);
    const friendly = testPiece("friend", "red", "pawn", 4, 2);
    const enemy = testPiece("enemy", "black", "pawn", 7, 4);
    const moves = movesFor(rook, [friendly, enemy]);

    expect(hasSquare(moves, 4, 3)).toBe(true);
    expect(hasSquare(moves, 4, 2)).toBe(false);
    expect(hasSquare(moves, 7, 4)).toBe(true);
    expect(hasSquare(moves, 8, 4)).toBe(false);
  });

  it("炮平移不越子，吃子时恰好隔一个炮架", () => {
    const cannon = testPiece("cannon", "red", "cannon", 1, 7);
    const screen = testPiece("screen", "red", "pawn", 1, 5);
    const enemy = testPiece("enemy", "black", "rook", 1, 2);
    const behind = testPiece("behind", "black", "pawn", 1, 0);
    const moves = movesFor(cannon, [screen, enemy, behind]);

    expect(hasSquare(moves, 1, 6)).toBe(true);
    expect(hasSquare(moves, 1, 5)).toBe(false);
    expect(hasSquare(moves, 1, 4)).toBe(false);
    expect(hasSquare(moves, 1, 2)).toBe(true);
    expect(hasSquare(moves, 1, 0)).toBe(false);
  });

  it("马受蹩马腿限制", () => {
    const horse = testPiece("horse", "red", "horse", 4, 4);
    const leg = testPiece("leg", "red", "pawn", 5, 4);
    const moves = movesFor(horse, [leg]);

    expect(hasSquare(moves, 6, 5)).toBe(false);
    expect(hasSquare(moves, 6, 3)).toBe(false);
    expect(hasSquare(moves, 3, 6)).toBe(true);
  });

  it("象走田字、受象眼阻挡且允许过河", () => {
    const elephant = testPiece("elephant", "red", "elephant", 4, 5);
    const eye = testPiece("eye", "red", "pawn", 5, 4);
    const moves = movesFor(elephant, [eye]);

    expect(hasSquare(moves, 6, 3)).toBe(false);
    expect(hasSquare(moves, 2, 3)).toBe(true);
    expect(hasSquare(moves, 2, 7)).toBe(true);
  });

  it("翻面后的士可按变体规则在全盘斜走一格", () => {
    const advisor = testPiece("advisor", "red", "advisor", 0, 4);
    const moves = movesFor(advisor);
    expect(moves).toEqual(
      expect.arrayContaining([
        { x: 1, y: 3 },
        { x: 1, y: 5 },
      ]),
    );
  });

  it("未翻开的红仕与黑士只能沿各自九宫米字格斜走一格", () => {
    const blackAdvisor = testPiece("black-advisor", "black", "advisor", 3, 0, {
      revealed: false,
      trueIdentity: { color: "red", type: "rook" },
    });
    const redAdvisor = testPiece("red-advisor", "red", "advisor", 5, 9, {
      revealed: false,
      trueIdentity: { color: "black", type: "cannon" },
    });

    expect(movesFor(blackAdvisor)).toEqual([{ x: 4, y: 1 }]);
    expect(hasSquare(movesFor(blackAdvisor), 2, 1)).toBe(false);
    expect(movesFor(redAdvisor)).toEqual([{ x: 4, y: 8 }]);
    expect(hasSquare(movesFor(redAdvisor), 6, 8)).toBe(false);
  });

  it("兵卒过河前只前进，过河后可以横走但不能后退", () => {
    const redBefore = testPiece("red-before", "red", "pawn", 4, 6);
    const redAfter = testPiece("red-after", "red", "pawn", 4, 4);
    const blackAfter = testPiece("black-after", "black", "pawn", 4, 5);

    expect(movesFor(redBefore)).toEqual([{ x: 4, y: 5 }]);
    expect(movesFor(redAfter)).toEqual(
      expect.arrayContaining([
        { x: 4, y: 3 },
        { x: 3, y: 4 },
        { x: 5, y: 4 },
      ]),
    );
    expect(hasSquare(movesFor(redAfter), 4, 5)).toBe(false);
    expect(movesFor(blackAfter)).toEqual(
      expect.arrayContaining([
        { x: 4, y: 6 },
        { x: 3, y: 5 },
        { x: 5, y: 5 },
      ]),
    );
  });

  it("帅将在九宫内正交移动，并可沿无阻挡纵线飞将", () => {
    const redGeneral = testPiece("red-general", "red", "general", 4, 9);
    const blackGeneral = testPiece("black-general", "black", "general", 4, 0);
    const game = createScenario({
      mode: "capture-general",
      pieces: [redGeneral, blackGeneral],
    });
    const moves = getPseudoMovesForPiece(game, redGeneral);

    expect(hasSquare(moves, 4, 8)).toBe(true);
    expect(hasSquare(moves, 3, 9)).toBe(true);
    expect(hasSquare(moves, 4, 0)).toBe(true);
    expect(hasSquare(moves, 2, 9)).toBe(false);
  });
});
