import { describe, expect, it } from "vitest";
import { resign, toPublicGame } from "../engine/game";
import { activeIdentity, controllerOf } from "../engine/rules";
import { createGame, INITIAL_SLOTS } from "../engine/setup";

describe("随机布子与公开局面", () => {
  it("保留 32 枚标准棋子且只明置帅、将", () => {
    const game = createGame({
      mode: "standard",
      player1Side: "red",
      rng: () => 0.314159,
      id: "setup-test",
    });

    expect(game.pieces).toHaveLength(32);
    expect(game.pieces.filter((piece) => piece.revealed)).toHaveLength(2);
    expect(
      game.pieces
        .filter((piece) => piece.revealed)
        .map(
          (piece) => `${piece.trueIdentity.color}-${piece.trueIdentity.type}`,
        )
        .sort(),
    ).toEqual(["black-general", "red-general"]);

    const inventory = game.pieces.reduce<Record<string, number>>(
      (counts, piece) => {
        const key = `${piece.trueIdentity.color}-${piece.trueIdentity.type}`;
        counts[key] = (counts[key] ?? 0) + 1;
        return counts;
      },
      {},
    );
    expect(inventory).toEqual({
      "black-rook": 2,
      "black-horse": 2,
      "black-elephant": 2,
      "black-advisor": 2,
      "black-general": 1,
      "black-cannon": 2,
      "black-pawn": 5,
      "red-pawn": 5,
      "red-cannon": 2,
      "red-rook": 2,
      "red-horse": 2,
      "red-elephant": 2,
      "red-advisor": 2,
      "red-general": 1,
    });
  });

  it("位置身份始终对应原始点位并决定盖子控制方", () => {
    const game = createGame({
      mode: "standard",
      player1Side: "black",
      rng: () => 0,
      id: "identity-test",
    });

    INITIAL_SLOTS.forEach((initialSlot, index) => {
      const piece = game.pieces[index];
      expect(piece.position).toEqual(initialSlot.position);
      expect(piece.publicIdentity).toEqual(initialSlot.identity);
      expect(controllerOf(piece)).toBe(initialSlot.identity.color);
      expect(activeIdentity(piece)).toEqual(
        piece.revealed ? piece.trueIdentity : piece.publicIdentity,
      );
    });
    expect(
      game.pieces.some(
        (piece) =>
          !piece.revealed &&
          (piece.trueIdentity.color !== piece.publicIdentity.color ||
            piece.trueIdentity.type !== piece.publicIdentity.type),
      ),
    ).toBe(true);
  });

  it("公开序列化从不包含未翻暗子的真实身份字段", () => {
    const game = createGame({
      mode: "standard",
      player1Side: "red",
      rng: () => 0,
      id: "privacy-test",
    });
    const publicGame = toPublicGame(game);

    expect(JSON.stringify(publicGame)).not.toContain("trueIdentity");
    for (const piece of publicGame.board) {
      if (!piece.faceUp) expect(piece).not.toHaveProperty("identity");
      if (piece.faceUp) expect(piece).toHaveProperty("identity");
    }
  });

  it("相同 Seed 在不同对战类型和执方下得到完全相同的暗子排列", () => {
    const humanGame = createGame({
      mode: "standard",
      matchType: "human-human",
      player1Side: "red",
      seed: "跨平台-Opening-01",
      id: "seed-human",
    });
    const aiGame = createGame({
      mode: "capture-general",
      matchType: "human-ai",
      aiModel: "local-model",
      player1Side: "black",
      seed: "跨平台-Opening-01",
      id: "seed-ai",
    });
    const fingerprint = (game: typeof humanGame) =>
      game.pieces.map(
        (piece) => `${piece.trueIdentity.color}-${piece.trueIdentity.type}`,
      );

    expect(fingerprint(aiGame)).toEqual(fingerprint(humanGame));
    expect(toPublicGame(humanGame).seed).toBeNull();
    resign(humanGame, 0);
    expect(toPublicGame(humanGame).seed).toBe("跨平台-Opening-01");
  });

  it("Seed 先做 Unicode NFC 归一化，并用固定指纹锁定跨平台算法", () => {
    const composed = createGame({
      mode: "standard",
      player1Side: "red",
      seed: "棋局-é",
      id: "seed-composed",
    });
    const decomposed = createGame({
      mode: "standard",
      player1Side: "red",
      seed: "  棋局-e\u0301  ",
      id: "seed-decomposed",
    });
    const fingerprint = (game: typeof composed) =>
      game.pieces
        .filter((piece) => piece.trueIdentity.type !== "general")
        .map(
          (piece) =>
            `${piece.trueIdentity.color[0]}-${piece.trueIdentity.type[0]}`,
        )
        .join("|");

    expect(decomposed.seed).toBe("棋局-é");
    expect(fingerprint(decomposed)).toBe(fingerprint(composed));
    expect(fingerprint(composed)).toBe(
      "r-p|b-p|r-e|r-p|r-r|r-p|b-r|b-e|b-r|r-e|b-p|r-c|b-p|b-p|r-p|b-c|r-c|b-h|b-e|r-p|r-a|r-h|r-h|r-a|b-h|b-a|b-p|b-c|r-r|b-a",
    );
  });
});
