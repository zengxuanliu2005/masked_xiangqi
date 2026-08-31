import { createServer, type Server } from "node:http";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app";
import { GameStore } from "../engine/store";
import {
  OllamaServiceError,
  type AiProvider,
  type ChooseMoveInput,
} from "../server/ollama";

describe("REST API", () => {
  let store: GameStore;
  let app: ReturnType<typeof createApp>;
  let server: Server;
  let aiProvider: AiProvider;
  let chooseMove: ReturnType<
    typeof vi.fn<
      (input: ChooseMoveInput) => Promise<{
        moveIndex: number;
        source: "model";
        note: string;
      }>
    >
  >;

  beforeEach(async () => {
    store = new GameStore();
    chooseMove = vi.fn(async () => ({
      moveIndex: 0,
      source: "model" as const,
      note: "测试模型选择。",
    }));
    aiProvider = {
      listModels: vi.fn(async () => [
        { name: "test-model:latest", family: "test", parameterSize: "1B" },
      ]),
      chooseMove,
    };
    app = createApp({ store, aiProvider, random: () => 0.75 });
    server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const apiRequest = () => request(server);

  const create = async (
    mode: "standard" | "capture-general" = "standard",
    player1Side: "red" | "black" = "red",
  ) =>
    apiRequest().post("/api/v1/games").send({ mode, player1Side }).expect(201);

  it("创建对局并返回选边、红方先行和版本号", async () => {
    const response = await create("standard", "black");
    expect(response.body).toMatchObject({
      mode: "standard",
      allowDraw: true,
      allowUndo: true,
      canUndo: false,
      revision: 0,
      turn: "red",
      players: { player1: "black", player2: "red" },
      status: { phase: "active", winner: null, reason: null },
    });
    expect(response.body.seed).toBeNull();
    expect(store.get(response.body.id)?.seed).toMatch(/^MX-[A-F0-9]{12}$/);
    expect(response.body.board).toHaveLength(32);
  });

  it("公开并保存自动和棋与悔棋的开局设置", async () => {
    const response = await apiRequest()
      .post("/api/v1/games")
      .send({
        mode: "capture-general",
        matchType: "human-human",
        allowDraw: false,
        allowUndo: false,
      })
      .expect(201);

    expect(response.body).toMatchObject({
      mode: "capture-general",
      allowDraw: false,
      allowUndo: false,
      canUndo: false,
    });
    expect(store.get(response.body.id)?.allowDraw).toBe(false);
    expect(store.get(response.body.id)?.allowUndo).toBe(false);
  });

  it("接受公开 Seed，并让人人、人机和不同模式复用同一暗子开局", async () => {
    const human = await apiRequest()
      .post("/api/v1/games")
      .send({
        mode: "standard",
        matchType: "human-human",
        player1Side: "red",
        seed: "  调试局-e\u0301  ",
      })
      .expect(201);
    const ai = await apiRequest()
      .post("/api/v1/games")
      .send({
        mode: "capture-general",
        matchType: "human-ai",
        aiModel: "test-model:latest",
        player1Side: "black",
        seed: "调试局-é",
      })
      .expect(201);

    expect(human.body.seed).toBeNull();
    expect(ai.body.seed).toBeNull();
    const humanGame = store.get(human.body.id)!;
    const aiGame = store.get(ai.body.id)!;
    expect(humanGame.seed).toBe("调试局-é");
    expect(aiGame.seed).toBe(humanGame.seed);
    expect(aiGame.pieces.map((piece) => piece.trueIdentity)).toEqual(
      humanGame.pieces.map((piece) => piece.trueIdentity),
    );
  });

  it("拒绝空白或过长 Seed", async () => {
    for (const seed of ["   ", "x".repeat(81)]) {
      const response = await apiRequest()
        .post("/api/v1/games")
        .send({ matchType: "human-human", seed })
        .expect(400);
      expect(response.body.error.code).toBe("INVALID_REQUEST");
      expect(response.body.error.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: "seed" })]),
      );
    }
  });

  it("未指定执方时随机分配红黑，但始终由红方先走", async () => {
    const response = await apiRequest()
      .post("/api/v1/games")
      .send({ matchType: "human-human" })
      .expect(201);
    expect(response.body).toMatchObject({
      mode: "standard",
      matchType: "human-human",
      aiModel: null,
      turn: "red",
      players: { player1: "black", player2: "red" },
    });
  });

  it("列出 Ollama 本机模型供前端选择", async () => {
    const response = await apiRequest().get("/api/v1/ai/models").expect(200);
    expect(response.body).toEqual({
      provider: "ollama",
      available: true,
      models: [
        { name: "test-model:latest", family: "test", parameterSize: "1B" },
      ],
      message: "已发现 1 个可用于对弈的本机模型。",
    });
  });

  it("人机对战要求模型，并可由模型在自己的回合提交合法着法", async () => {
    const invalid = await apiRequest()
      .post("/api/v1/games")
      .send({ matchType: "human-ai" })
      .expect(400);
    expect(invalid.body.error.code).toBe("INVALID_REQUEST");

    const created = await apiRequest()
      .post("/api/v1/games")
      .send({
        mode: "capture-general",
        matchType: "human-ai",
        aiModel: "test-model:latest",
        player1Side: "black",
      })
      .expect(201);
    const response = await apiRequest()
      .post(`/api/v1/games/${created.body.id}/ai-move`)
      .send({ expectedRevision: 0 })
      .expect(200);

    expect(response.body).toMatchObject({
      game: { revision: 1, turn: "black", matchType: "human-ai" },
      decision: {
        model: "test-model:latest",
        source: "model",
        note: "测试模型选择。",
      },
    });
    expect(chooseMove).toHaveBeenCalledTimes(1);
    const modelInput = chooseMove.mock.calls[0][0];
    expect(modelInput.legalMoves.length).toBeGreaterThan(0);
    expect(JSON.stringify(modelInput.game)).not.toContain("trueIdentity");
    expect(
      modelInput.game.board
        .filter((piece) => !piece.faceUp)
        .every((piece) => !("identity" in piece)),
    ).toBe(true);
  });

  it("人机建局重新验证模型存在且明确拒绝 embedding-only 模型", async () => {
    vi.mocked(aiProvider.listModels).mockResolvedValueOnce([]);
    expect(
      (
        await apiRequest().post("/api/v1/games").send({
          matchType: "human-ai",
          aiModel: "removed-model",
        })
      ).body.error.code,
    ).toBe("MODEL_NOT_FOUND");

    vi.mocked(aiProvider.listModels).mockResolvedValueOnce([
      {
        name: "embedding-only",
        capabilities: ["embedding"],
        supportsThinking: false,
        supportsCompletion: false,
      },
    ]);
    const embedding = await apiRequest().post("/api/v1/games").send({
      matchType: "human-ai",
      aiModel: "embedding-only",
    });
    expect(embedding.status).toBe(422);
    expect(embedding.body.error.code).toBe("MODEL_NOT_GENERATIVE");
  });

  it("兼容 ai-move 端点也只纠错一次，失败时不随机代走", async () => {
    chooseMove.mockRejectedValue(
      new OllamaServiceError("OLLAMA_BAD_RESPONSE", "模型连续返回无效结构"),
    );
    const created = await apiRequest()
      .post("/api/v1/games")
      .send({
        matchType: "human-ai",
        aiModel: "test-model:latest",
        player1Side: "black",
      })
      .expect(201);

    await apiRequest()
      .post(`/api/v1/games/${created.body.id}/ai-move`)
      .send({ expectedRevision: 0 })
      .expect(502)
      .expect(({ body }) =>
        expect(body.error.code).toBe("OLLAMA_BAD_RESPONSE"),
      );

    expect(chooseMove).toHaveBeenCalledTimes(2);
    const unchanged = await apiRequest()
      .get(`/api/v1/games/${created.body.id}`)
      .expect(200);
    expect(unchanged.body).toMatchObject({ revision: 0, moveNumber: 0 });

    chooseMove.mockReset().mockResolvedValue({
      moveIndex: 0,
      source: "model",
      note: "异常后的下一次请求",
    });
    await apiRequest()
      .post(`/api/v1/games/${created.body.id}/ai-move`)
      .send({ expectedRevision: 0 })
      .expect(200);
    expect(chooseMove).toHaveBeenCalledOnce();
  });

  it("拒绝在人类回合调用模型落子接口", async () => {
    const created = await apiRequest()
      .post("/api/v1/games")
      .send({
        matchType: "human-ai",
        aiModel: "test-model:latest",
        player1Side: "red",
      })
      .expect(201);
    const response = await apiRequest()
      .post(`/api/v1/games/${created.body.id}/ai-move`)
      .send({ expectedRevision: 0 })
      .expect(409);
    expect(response.body.error.code).toBe("NOT_AI_TURN");
    expect(chooseMove).not.toHaveBeenCalled();
  });

  it("读取公开局面时不泄露任何未翻真实身份", async () => {
    const created = await create();
    const response = await apiRequest()
      .get(`/api/v1/games/${created.body.id}`)
      .expect(200);

    expect(JSON.stringify(response.body)).not.toContain("trueIdentity");
    expect(response.body).not.toHaveProperty("undoStack");
    const covered = response.body.board.filter(
      (piece: { faceUp: boolean }) => !piece.faceUp,
    );
    expect(covered).toHaveLength(30);
    for (const piece of covered) {
      expect(piece).not.toHaveProperty("identity");
      expect(piece).toHaveProperty("publicIdentity");
      expect(piece).toHaveProperty("controller");
    }
  });

  it("可读取全部或指定棋子的当前合法着法", async () => {
    const created = await create();
    const all = await apiRequest()
      .get(`/api/v1/games/${created.body.id}/legal-moves`)
      .expect(200);
    expect(all.body.revision).toBe(0);
    expect(all.body.turn).toBe("red");
    expect(all.body.moves.length).toBeGreaterThan(0);

    const pieceId = all.body.moves[0].pieceId;
    const one = await apiRequest()
      .get(`/api/v1/games/${created.body.id}/legal-moves`)
      .query({ pieceId })
      .expect(200);
    expect(one.body.moves.length).toBeGreaterThan(0);
    expect(
      one.body.moves.every(
        (move: { pieceId: string }) => move.pieceId === pieceId,
      ),
    ).toBe(true);
  });

  it("接受合法着法、翻面并递增 revision", async () => {
    const created = await create("capture-general");
    const legal = await apiRequest()
      .get(`/api/v1/games/${created.body.id}/legal-moves`)
      .expect(200);
    const move = legal.body.moves.find((candidate: { pieceId: string }) => {
      const piece = created.body.board.find(
        (boardPiece: { id: string; faceUp: boolean }) =>
          boardPiece.id === candidate.pieceId,
      );
      return piece && !piece.faceUp;
    });
    expect(move).toBeTruthy();

    const response = await apiRequest()
      .post(`/api/v1/games/${created.body.id}/moves`)
      .send({ from: move.from, to: move.to, expectedRevision: 0 })
      .expect(200);
    expect(response.body.revision).toBe(1);
    expect(response.body.turn).toBe("black");
    expect(response.body.canUndo).toBe(true);
    expect(response.body.lastMove.revealedIdentity).toBeTruthy();
    const moved = response.body.board.find(
      (piece: { id: string }) => piece.id === move.pieceId,
    );
    expect(moved.faceUp).toBe(true);
    expect(moved.identity).toBeTruthy();
  });

  it("悔棋接口恢复落子前局面并继续递增 revision", async () => {
    const created = await create("capture-general");
    const legal = await apiRequest()
      .get(`/api/v1/games/${created.body.id}/legal-moves`)
      .expect(200);
    const move = legal.body.moves[0];
    await apiRequest()
      .post(`/api/v1/games/${created.body.id}/moves`)
      .send({ from: move.from, to: move.to, expectedRevision: 0 })
      .expect(200);

    const undone = await apiRequest()
      .post(`/api/v1/games/${created.body.id}/undo`)
      .send({ expectedRevision: 1 })
      .expect(200);

    expect(undone.body).toMatchObject({
      revision: 2,
      moveNumber: 0,
      turn: "red",
      canUndo: false,
      lastMove: null,
      status: { phase: "active", winner: null, reason: null },
    });
    expect(undone.body.board).toEqual(created.body.board);
  });

  it("关闭悔棋时返回结构化错误", async () => {
    const created = await apiRequest()
      .post("/api/v1/games")
      .send({
        mode: "capture-general",
        matchType: "human-human",
        player1Side: "red",
        allowUndo: false,
      })
      .expect(201);
    const legal = await apiRequest()
      .get(`/api/v1/games/${created.body.id}/legal-moves`)
      .expect(200);
    const move = legal.body.moves[0];
    await apiRequest()
      .post(`/api/v1/games/${created.body.id}/moves`)
      .send({ from: move.from, to: move.to, expectedRevision: 0 })
      .expect(200);

    const response = await apiRequest()
      .post(`/api/v1/games/${created.body.id}/undo`)
      .send({ expectedRevision: 1 })
      .expect(409);
    expect(response.body.error.code).toBe("UNDO_DISABLED");
  });

  it("拒绝过期 revision 并返回可机器处理的冲突信息", async () => {
    const created = await create("capture-general");
    const legal = await apiRequest()
      .get(`/api/v1/games/${created.body.id}/legal-moves`)
      .expect(200);
    const first = legal.body.moves[0];
    await apiRequest()
      .post(`/api/v1/games/${created.body.id}/moves`)
      .send({ from: first.from, to: first.to, expectedRevision: 0 })
      .expect(200);

    const response = await apiRequest()
      .post(`/api/v1/games/${created.body.id}/moves`)
      .send({ from: first.from, to: first.to, expectedRevision: 0 })
      .expect(409);
    expect(response.body.error).toMatchObject({
      code: "STALE_REVISION",
      details: { expectedRevision: 0, actualRevision: 1 },
    });
  });

  it("非法、非当前方和格式错误着法返回结构化错误", async () => {
    const created = await create();
    const illegal = await apiRequest()
      .post(`/api/v1/games/${created.body.id}/moves`)
      .send({
        from: { x: 4, y: 9 },
        to: { x: 0, y: 0 },
        expectedRevision: 0,
      })
      .expect(422);
    expect(illegal.body.error.code).toBe("ILLEGAL_MOVE");

    const wrongSide = await apiRequest()
      .post(`/api/v1/games/${created.body.id}/moves`)
      .send({
        from: { x: 4, y: 0 },
        to: { x: 4, y: 1 },
        expectedRevision: 0,
      })
      .expect(422);
    expect(wrongSide.body.error.code).toBe("WRONG_SIDE");

    const invalid = await apiRequest()
      .post(`/api/v1/games/${created.body.id}/moves`)
      .send({ from: { x: -1, y: 9 }, to: { x: 0, y: 8 } })
      .expect(400);
    expect(invalid.body.error.code).toBe("INVALID_REQUEST");
  });

  it("认输后禁止继续落子", async () => {
    const created = await create("capture-general");
    const legal = await apiRequest()
      .get(`/api/v1/games/${created.body.id}/legal-moves`)
      .expect(200);
    const move = legal.body.moves[0];

    const resigned = await apiRequest()
      .post(`/api/v1/games/${created.body.id}/resign`)
      .send({ expectedRevision: 0 })
      .expect(200);
    expect(resigned.body).toMatchObject({
      revision: 1,
      status: { phase: "finished", winner: "black", reason: "resignation" },
    });

    const after = await apiRequest()
      .post(`/api/v1/games/${created.body.id}/moves`)
      .send({ from: move.from, to: move.to, expectedRevision: 1 })
      .expect(409);
    expect(after.body.error.code).toBe("GAME_FINISHED");
  });

  it("未知对局和非法建局参数返回 404/400", async () => {
    const missing = await apiRequest()
      .get("/api/v1/games/not-found")
      .expect(404);
    expect(missing.body.error.code).toBe("GAME_NOT_FOUND");

    const invalid = await apiRequest()
      .post("/api/v1/games")
      .send({
        mode: "unknown",
        player1Side: "green",
        allowDraw: "yes",
        allowUndo: "yes",
      })
      .expect(400);
    expect(invalid.body.error.code).toBe("INVALID_REQUEST");
  });
});
