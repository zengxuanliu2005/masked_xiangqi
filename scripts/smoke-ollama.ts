import { legalMoves, toPublicGame } from "../engine/game";
import { createScenario } from "../engine/setup";
import type { InternalPiece } from "../engine/types";
import type { Color, PieceType } from "../shared/contracts";
import {
  buildChatRequest,
  chooseMoveWithRetry,
  OllamaClient,
  sanitizeModelText,
} from "../server/ollama";

const thinkingModel =
  process.env.OLLAMA_THINKING_MODEL ?? "qwen3.6-uncensored:q3kp";
const directModel = process.env.OLLAMA_DIRECT_MODEL ?? "qwen3-vl:4b";

const piece = (
  id: string,
  color: Color,
  type: PieceType,
  x: number,
  y: number,
): InternalPiece => ({
  id,
  position: { x, y },
  publicIdentity: { color, type },
  trueIdentity: { color, type },
  revealed: true,
});

const game = createScenario({
  id: "real-ollama-smoke",
  seed: "REAL-OLLAMA-SMOKE",
  mode: "capture-general",
  matchType: "human-ai",
  aiModel: thinkingModel,
  player1Side: "black",
  turn: "red",
  pieces: [
    piece("black-general", "black", "general", 4, 0),
    piece("black-rook", "black", "rook", 8, 0),
    piece("red-rook", "red", "rook", 0, 9),
    piece("red-general", "red", "general", 4, 9),
  ],
});
const publicGame = toPublicGame(game);
const moves = legalMoves(game);
const client = new OllamaClient();

if (publicGame.seed !== null || moves.length === 0) {
  throw new Error("真实 Ollama 烟测局面未满足公开投影或合法着法前置条件。");
}

const installed = await client.listModels();
for (const model of [thinkingModel, directModel]) {
  const metadata = installed.find((candidate) => candidate.name === model);
  if (!metadata) throw new Error(`本机未安装烟测模型：${model}`);
  if (metadata.supportsCompletion === false) {
    throw new Error(`烟测模型不能生成文本：${model}`);
  }
}

const smoke = async (model: string, expectedRoute: "thinking" | "direct") => {
  const capabilities = await client.getModelCapabilities(model);
  if (capabilities.supportsCompletion === false) {
    throw new Error(`模型仅支持 embedding：${model}`);
  }
  if (expectedRoute === "thinking" && !capabilities.supportsThinking) {
    throw new Error(`模型未声明 thinking 能力：${model}`);
  }
  const input = { game: publicGame, legalMoves: moves, model };
  const request = buildChatRequest(input, capabilities);
  if (expectedRoute === "thinking" && request.think !== true) {
    throw new Error(`模型没有进入 thinking 请求路径：${model}`);
  }
  if (expectedRoute === "direct" && request.think !== false) {
    throw new Error(`模型没有进入 direct 请求路径：${model}`);
  }

  let thinkingBytes = 0;
  let finalBytes = 0;
  const startedAt = performance.now();
  const decision = await chooseMoveWithRetry(client, input, {
    capabilities,
    onThinking: (chunk) => {
      thinkingBytes += Buffer.byteLength(chunk);
    },
    onContent: (chunk) => {
      finalBytes += Buffer.byteLength(chunk);
    },
  });
  if (expectedRoute === "thinking" && thinkingBytes === 0) {
    throw new Error(`thinking 模型没有返回实际 thinking 文本：${model}`);
  }
  if (!moves[decision.moveIndex]) {
    throw new Error(`模型返回了越界着法：${model}`);
  }
  return {
    model,
    route: expectedRoute,
    moveIndex: decision.moveIndex,
    reason: sanitizeModelText(decision.note ?? ""),
    thinkingBytes,
    finalBytes,
    elapsedMs: Math.round(performance.now() - startedAt),
  };
};

const results = [
  await smoke(thinkingModel, "thinking"),
  await smoke(directModel, "direct"),
];
process.stdout.write(`${JSON.stringify({ ok: true, results }, null, 2)}\n`);
