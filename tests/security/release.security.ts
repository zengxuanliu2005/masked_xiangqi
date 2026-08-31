import { mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyMove, legalMoves, resign, toPublicGame } from "../../engine/game";
import { GameStore } from "../../engine/store";
import { createGame } from "../../engine/setup";
import { createApp } from "../../server/app";
import {
  readAgentSessionFile,
  writeAgentSessionFile,
} from "../../server/agent/session-file";
import {
  buildPrompt,
  sanitizeModelText,
  type AiProvider,
} from "../../server/ollama";

const temporaryDirectories: string[] = [];
const servers: Server[] = [];

const serve = async (app: ReturnType<typeof createApp>) => {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  return request(server);
};

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

const provider = (
  chooseMove: AiProvider["chooseMove"] = vi.fn(async () => ({
    moveIndex: 0,
    source: "model" as const,
    note: "安全测试",
  })),
) =>
  ({
    listModels: vi.fn(async () => [
      {
        name: "generative",
        capabilities: ["completion"],
        supportsCompletion: true,
      },
    ]),
    chooseMove,
  }) satisfies AiProvider;

describe("发布安全门禁", () => {
  it("活动 Seed 与未翻身份不会进入公开状态、合法着法、Prompt 或日志载荷", () => {
    const canary = "MX-SECRET-CANARY-DO-NOT-LEAK";
    const game = createGame({
      mode: "capture-general",
      player1Side: "black",
      matchType: "human-ai",
      aiModel: "generative",
      seed: canary,
    });
    const publicGame = toPublicGame(game);
    const moves = legalMoves(game);
    const prompt = buildPrompt({
      game: publicGame,
      legalMoves: moves,
      model: "generative",
    });
    const simulatedLog = JSON.stringify({
      event: "public_position",
      game: publicGame,
    });

    expect(publicGame.seed).toBeNull();
    expect(JSON.stringify(publicGame)).not.toContain(canary);
    expect(JSON.stringify(moves)).not.toContain(canary);
    expect(prompt).not.toContain(canary);
    expect(simulatedLog).not.toContain(canary);
    for (const piece of publicGame.board.filter(
      (candidate) => !candidate.faceUp,
    )) {
      expect(piece).not.toHaveProperty("identity");
    }

    const first = moves[0];
    applyMove(game, { ...first, expectedRevision: 0 });
    resign(game, 1);
    expect(toPublicGame(game).seed).toBe(canary);
  });

  it("严格处理非法 JSON、未知字段、媒体类型、超限、Host、Origin 与未知路由", async () => {
    const app = createApp({ aiProvider: provider() });
    const api = await serve(app);
    const invalidJson = await api
      .post("/api/v1/games")
      .set("content-type", "application/json")
      .send('{"matchType":')
      .expect(400);
    expect(invalidJson.body.error.code).toBe("INVALID_JSON");

    const unknown = await api
      .post("/api/v1/games")
      .send({ matchType: "human-human", unexpected: true })
      .expect(400);
    expect(unknown.body.error.code).toBe("INVALID_REQUEST");

    const media = await api
      .post("/api/v1/games")
      .set("content-type", "text/plain")
      .send("{}")
      .expect(415);
    expect(media.body.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");

    const wrongCharset = await api
      .post("/api/v1/games")
      .set("content-type", "application/json; charset=iso-8859-1")
      .send("{}")
      .expect(415);
    expect(wrongCharset.body.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");

    const prefix = '{"matchType":"human-human","unexpected":"';
    const suffix = '"}';
    const exactBody = `${prefix}${"x".repeat(
      16 * 1024 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix),
    )}${suffix}`;
    expect(Buffer.byteLength(exactBody)).toBe(16 * 1024);
    const exactBoundary = await api
      .post("/api/v1/games")
      .set("content-type", "application/json")
      .send(exactBody)
      .expect(400);
    expect(exactBoundary.body.error.code).toBe("INVALID_REQUEST");

    const oversized = await api
      .post("/api/v1/games")
      .set("content-type", "application/json")
      .send(`${exactBody} `)
      .expect(413);
    expect(oversized.body.error.code).toBe("PAYLOAD_TOO_LARGE");

    expect(
      (await api.get("/api/v1/health").set("host", "example.com").expect(403))
        .body.error.code,
    ).toBe("HOST_FORBIDDEN");
    expect(
      (
        await api
          .get("/api/v1/health")
          .set("origin", "https://example.com")
          .expect(403)
      ).body.error.code,
    ).toBe("ORIGIN_FORBIDDEN");
    expect((await api.get("/api/v1/nope").expect(404)).body.error.code).toBe(
      "ENDPOINT_NOT_FOUND",
    );
  });

  it("同 revision 的 100 个并发写请求恰好一个成功", async () => {
    const app = createApp({ aiProvider: provider(), random: () => 0 });
    const api = await serve(app);
    const created = await api
      .post("/api/v1/games")
      .send({ matchType: "human-human", mode: "capture-general" })
      .expect(201);
    const legal = await api
      .get(`/api/v1/games/${created.body.id}/legal-moves`)
      .expect(200);
    const move = legal.body.moves[0];
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        api
          .post(`/api/v1/games/${created.body.id}/moves`)
          .send({ from: move.from, to: move.to, expectedRevision: 0 }),
      ),
    );
    expect(results.filter((result) => result.status === 200)).toHaveLength(1);
    expect(results.filter((result) => result.status === 409)).toHaveLength(99);
    const current = await api
      .get(`/api/v1/games/${created.body.id}`)
      .expect(200);
    expect(current.body).toMatchObject({ revision: 1, moveNumber: 1 });
  });

  it("move、undo、resign 的同 revision 并发矩阵只有一个状态写入成功", async () => {
    const app = createApp({ aiProvider: provider(), random: () => 0 });
    const api = await serve(app);
    const created = await api
      .post("/api/v1/games")
      .send({ matchType: "human-human", mode: "capture-general" })
      .expect(201);
    const legal = await api
      .get(`/api/v1/games/${created.body.id}/legal-moves`)
      .expect(200);
    const move = legal.body.moves[0];
    const writes = [
      ...Array.from({ length: 10 }, () =>
        api.post(`/api/v1/games/${created.body.id}/moves`).send({
          from: move.from,
          to: move.to,
          expectedRevision: 0,
        }),
      ),
      ...Array.from({ length: 10 }, () =>
        api
          .post(`/api/v1/games/${created.body.id}/undo`)
          .send({ expectedRevision: 0 }),
      ),
      ...Array.from({ length: 10 }, () =>
        api
          .post(`/api/v1/games/${created.body.id}/resign`)
          .send({ expectedRevision: 0 }),
      ),
    ];

    const results = await Promise.all(writes);

    expect(results.filter(({ status }) => status === 200)).toHaveLength(1);
    expect(results.filter(({ status }) => status === 409)).toHaveLength(29);
    expect(
      (await api.get(`/api/v1/games/${created.body.id}`)).body.revision,
    ).toBe(1);
  });

  it("无可回收对局空间时稳定返回 503 CAPACITY_EXCEEDED", async () => {
    const app = createApp({
      store: new GameStore({ maxGames: 1 }),
      aiProvider: provider(),
    });
    const api = await serve(app);
    await api
      .post("/api/v1/games")
      .send({ matchType: "human-human" })
      .expect(201);

    const full = await api
      .post("/api/v1/games")
      .send({ matchType: "human-human" })
      .expect(503);

    expect(full.body.error.code).toBe("CAPACITY_EXCEEDED");
  });

  it("同局 20 个 ai-move 请求仅一个进入上游且不会双落子", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let upstreamActive = 0;
    let maxUpstreamActive = 0;
    let upstreamCalls = 0;
    const chooseMove = vi.fn<AiProvider["chooseMove"]>(async () => {
      upstreamCalls += 1;
      upstreamActive += 1;
      maxUpstreamActive = Math.max(maxUpstreamActive, upstreamActive);
      await gate;
      upstreamActive -= 1;
      return { moveIndex: 0, source: "model", note: "single flight" };
    });
    const app = createApp({ aiProvider: provider(chooseMove) });
    const api = await serve(app);
    const created = await api
      .post("/api/v1/games")
      .send({
        matchType: "human-ai",
        aiModel: "generative",
        player1Side: "black",
        mode: "capture-general",
      })
      .expect(201);
    const requests = Promise.all(
      Array.from({ length: 20 }, () =>
        api
          .post(`/api/v1/games/${created.body.id}/ai-move`)
          .send({ expectedRevision: 0 }),
      ),
    );
    for (let index = 0; index < 100 && upstreamCalls === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // Keep the upstream request open long enough for every socket to reach the
    // per-game single-flight guard, including under coverage instrumentation.
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    const results = await requests;
    expect(results.filter((result) => result.status === 200)).toHaveLength(1);
    expect(
      results.filter(
        (result) => result.body.error?.code === "AI_DECISION_IN_PROGRESS",
      ),
    ).toHaveLength(19);
    expect(upstreamCalls).toBe(1);
    expect(maxUpstreamActive).toBe(1);
    expect(
      (await api.get(`/api/v1/games/${created.body.id}`)).body.revision,
    ).toBe(1);
  });

  it("会话读取拒绝路径逃逸、外部日志、软链接与非 loopback API", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "masked-security-"));
    temporaryDirectories.push(root);
    const sessionRoot = path.join(root, ".local", "agent-sessions");
    const valid = {
      version: 1 as const,
      sessionId: "00000000-0000-4000-8000-000000000000",
      gameId: "security-game",
      apiBaseUrl: "http://127.0.0.1:3001",
      token: "x".repeat(43),
      logPath: path.join(root, ".local", "agent-logs", "security-game.jsonl"),
    };
    const outside = path.join(root, "outside.json");
    await writeAgentSessionFile(outside, valid);
    await expect(readAgentSessionFile(outside, root)).rejects.toThrow(".local");

    const invalidLog = path.join(sessionRoot, "invalid-log.json");
    await writeAgentSessionFile(invalidLog, { ...valid, logPath: outside });
    await expect(readAgentSessionFile(invalidLog, root)).rejects.toThrow(
      "Agent 日志",
    );

    const remote = path.join(sessionRoot, "remote.json");
    await writeAgentSessionFile(remote, {
      ...valid,
      apiBaseUrl: "https://example.com",
    });
    await expect(readAgentSessionFile(remote, root)).rejects.toThrow(
      "本机 HTTP API",
    );

    const target = path.join(sessionRoot, "target.json");
    const link = path.join(sessionRoot, "link.json");
    await writeAgentSessionFile(target, valid);
    try {
      await symlink(target, link);
      await expect(readAgentSessionFile(link, root)).rejects.toThrow("软链接");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
  });

  it("终端控制字符被移除而普通 thinking、final JSON 与理由保持完整", () => {
    const unsafe = "分析\u001b[31m红色\u001b[0m\u001b]0;劫持标题\u0007\n";
    expect(sanitizeModelText(unsafe)).toBe("分析红色\n");
    const normal = '{"moveIndex":0,"reason":"稳健推进。"}';
    expect(sanitizeModelText(normal)).toBe(normal);
  });
});
