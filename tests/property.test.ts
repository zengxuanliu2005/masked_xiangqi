import { describe, it } from "vitest";
import {
  applyMove,
  GameRuleError,
  legalMoves,
  resign,
  toPublicGame,
  undo,
} from "../engine/game";
import { createGame } from "../engine/setup";

const assertPublicInvariants = (game: ReturnType<typeof createGame>) => {
  const publicGame = toPublicGame(game);
  const positions = publicGame.board.map(
    (piece) => `${piece.position.x},${piece.position.y}`,
  );
  if (new Set(positions).size !== positions.length) {
    throw new Error(`${game.id}: 棋子位置发生重叠。`);
  }
  if (publicGame.board.length > 32) {
    throw new Error(`${game.id}: 公开棋子数量超过 32。`);
  }
  for (const piece of publicGame.board) {
    if (
      piece.position.x < 0 ||
      piece.position.x > 8 ||
      piece.position.y < 0 ||
      piece.position.y > 9
    ) {
      throw new Error(`${game.id}: 棋子坐标越界。`);
    }
    if (!piece.faceUp && "identity" in piece) {
      throw new Error(`${game.id}: 未翻暗子泄漏真实身份。`);
    }
  }
  if (publicGame.status.phase === "active" && publicGame.seed !== null) {
    throw new Error(`${game.id}: 活动局泄漏 Seed。`);
  }
};

describe("1,000 Seed 随机棋规性质", () => {
  it("合法走子、公开投影、版本、悔棋与终局始终满足不变量", () => {
    for (let seedIndex = 0; seedIndex < 1_000; seedIndex += 1) {
      const game = createGame({
        id: `property-${seedIndex}`,
        seed: `PROPERTY-${seedIndex.toString().padStart(4, "0")}`,
        mode: seedIndex % 2 === 0 ? "standard" : "capture-general",
        player1Side: seedIndex % 3 === 0 ? "black" : "red",
      });
      let lastLegalMove: ReturnType<typeof legalMoves>[number] | undefined;

      assertPublicInvariants(game);
      for (let ply = 0; ply < 12 && game.status.phase === "active"; ply += 1) {
        const moves = legalMoves(game);
        if (moves.length === 0) break;
        const coordinatesAreValid = moves.every((move) =>
          [move.from, move.to].every(
            (position) =>
              position.x >= 0 &&
              position.x <= 8 &&
              position.y >= 0 &&
              position.y <= 9,
          ),
        );
        if (!coordinatesAreValid) {
          throw new Error(`${game.id}: 合法着法包含越界坐标。`);
        }
        const selected =
          moves[(seedIndex * 1_664_525 + ply * 1_013_904_223) % moves.length];
        const previousRevision = game.revision;
        const previousMoveNumber = game.moveNumber;
        applyMove(game, { ...selected, expectedRevision: previousRevision });
        if (
          game.revision !== previousRevision + 1 ||
          game.moveNumber !== previousMoveNumber + 1
        ) {
          throw new Error(`${game.id}: 落子后的版本或步数不单调。`);
        }
        lastLegalMove = selected;
        assertPublicInvariants(game);

        if (seedIndex % 100 === 0 && ply === 0) {
          const revisionAfterMove = game.revision;
          undo(game, revisionAfterMove);
          if (
            game.revision !== revisionAfterMove + 1 ||
            game.moveNumber !== previousMoveNumber
          ) {
            throw new Error(`${game.id}: 悔棋没有正确恢复步数或推进版本。`);
          }
          assertPublicInvariants(game);
        }
      }

      if (game.status.phase === "active") resign(game, game.revision);
      if (
        toPublicGame(game).seed !== game.seed ||
        legalMoves(game).length > 0
      ) {
        throw new Error(`${game.id}: 终局投影或合法着法不正确。`);
      }
      if (lastLegalMove) {
        try {
          applyMove(game, {
            ...lastLegalMove,
            expectedRevision: game.revision,
          });
          throw new Error("终局后意外接受了落子。");
        } catch (error) {
          if (
            !(error instanceof GameRuleError) ||
            error.code !== "GAME_FINISHED"
          ) {
            throw error;
          }
        }
      }
    }
  }, 30_000);
});
