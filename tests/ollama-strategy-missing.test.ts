import { describe, expect, it, vi } from "vitest";
import type { PublicGameState } from "../shared/contracts";

// A packaging mistake that removes the bundled strategy files must degrade to
// a prompt without strategy prose, never to a failed move. The loader already
// returns "" in that case; this pins the consumer side of that contract.
vi.mock("../server/ai/strategy", () => ({
  strategyFor: () => "",
  clearStrategyCache: () => undefined,
  MAX_STRATEGY_BYTES: 8 * 1024,
}));

const { buildChatRequest } = await import("../server/ollama");

const game: PublicGameState = {
  id: "no-strategy",
  seed: null,
  mode: "standard",
  allowDraw: true,
  allowUndo: true,
  canUndo: false,
  matchType: "human-ai",
  aiModel: "local-model",
  aiDifficulty: "hard",
  revision: 0,
  turn: "red",
  moveNumber: 0,
  players: { player1: "black", player2: "red" },
  status: { phase: "active", winner: null, reason: null },
  check: null,
  board: [
    {
      id: "covered",
      position: { x: 0, y: 6 },
      faceUp: false,
      publicIdentity: { color: "red", type: "pawn" },
      controller: "red",
    },
  ],
  captured: { red: [], black: [] },
  lastMove: null,
  createdAt: "2026-08-30T00:00:00.000Z",
};

const legalMoves = [
  {
    pieceId: "covered",
    from: { x: 0, y: 6 },
    to: { x: 0, y: 5 },
    captures: false,
  },
];

describe("策略文本缺失", () => {
  it("请求仍然成立，只是少一条 system 消息", () => {
    const request = buildChatRequest(
      { game, legalMoves, model: "local-model" },
      {
        capabilities: ["completion", "thinking"],
        supportsThinking: true,
        isGptOss: false,
      },
    );

    expect(request.messages).toHaveLength(2);
    expect(request.messages[0].role).toBe("system");
    expect(request.messages[1].role).toBe("user");
    // The difficulty still drives the budget even without prose.
    expect(request.options.num_predict).toBe(256);
    expect(request.messages[1].content).toContain("合法着法");
  });
});
