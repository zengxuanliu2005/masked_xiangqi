import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app";
import { GameStore } from "../engine/store";
import { AgentSessionManager } from "../server/agent/session-manager";
import type { TerminalLauncher } from "../server/agent/terminal";
import type { AiProvider } from "../server/ollama";

describe("Agent Session API", () => {
  let directory: string;
  let server: Server;
  let store: GameStore;
  let manager: AgentSessionManager;
  let launch: ReturnType<typeof vi.fn<TerminalLauncher["launch"]>>;
  let sessionCounter: number;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "masked-xiangqi-api-"));
    store = new GameStore();
    sessionCounter = 1;
    launch = vi.fn(async (filePath: string) => ({
      launched: true,
      terminal: "terminal" as const,
      manualCommand: `run ${filePath}`,
    }));
    const launcher: TerminalLauncher = {
      launch,
      manualCommand: (filePath) => `run ${filePath}`,
    };
    manager = new AgentSessionManager({
      repositoryRoot: directory,
      sessionDirectory: path.join(directory, ".local", "agent-sessions"),
      logDirectory: path.join(directory, ".local", "agent-logs"),
      launcher,
      sessionIdFactory: () =>
        `00000000-0000-4000-8000-${String(sessionCounter++).padStart(12, "0")}`,
      tokenFactory: () => `token-${sessionCounter}-${"x".repeat(36)}`,
    });
    const aiProvider: AiProvider = {
      listModels: vi.fn(async () => [{ name: "test-model" }]),
      chooseMove: vi.fn(async () => ({
        moveIndex: 0,
        source: "model" as const,
      })),
    };
    const app = createApp({
      store,
      aiProvider,
      agentSessionManager: manager,
      apiBaseUrl: "http://127.0.0.1:3001",
    });
    server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  const apiRequest = () => request(server);

  const createAiGame = async (player1Side: "red" | "black" = "red") =>
    apiRequest()
      .post("/api/v1/games")
      .send({
        matchType: "human-ai",
        aiModel: "test-model",
        player1Side,
      })
      .expect(201);

  const readToken = async (gameId: string): Promise<string> => {
    const filePath = manager.sessionFilePath(gameId)!;
    return (JSON.parse(await readFile(filePath, "utf8")) as { token: string })
      .token;
  };

  it("创建唯一会话并只公开脱敏状态", async () => {
    const game = await createAiGame("black");
    const first = await apiRequest()
      .post(`/api/v1/games/${game.body.id}/agent-session`)
      .expect(201);
    const duplicate = await apiRequest()
      .post(`/api/v1/games/${game.body.id}/agent-session`)
      .expect(200);

    expect(first.body).toMatchObject({
      gameId: game.body.id,
      status: "starting",
      terminal: "terminal",
      error: null,
    });
    expect(duplicate.body.sessionId).toBe(first.body.sessionId);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first.body)).not.toContain("token-");
    expect(first.body).not.toHaveProperty("sessionFilePath");
  });

  it("查询、Runner 心跳与状态更新要求会话令牌", async () => {
    const game = await createAiGame();
    await apiRequest()
      .post(`/api/v1/games/${game.body.id}/agent-session`)
      .expect(201);
    const token = await readToken(game.body.id);

    await apiRequest()
      .get(`/api/v1/games/${game.body.id}/agent-session/runner`)
      .expect(401)
      .expect(({ body }) =>
        expect(body.error.code).toBe("AGENT_TOKEN_INVALID"),
      );

    const control = await apiRequest()
      .get(`/api/v1/games/${game.body.id}/agent-session/runner`)
      .set("authorization", `Bearer ${token}`)
      .expect(200);
    expect(control.body).toEqual({
      stopRequested: false,
      status: "starting",
    });

    await apiRequest()
      .patch(`/api/v1/games/${game.body.id}/agent-session/runner`)
      .set("authorization", `Bearer ${token}`)
      .send({ status: "thinking", error: null })
      .expect(200);
    const publicState = await apiRequest()
      .get(`/api/v1/games/${game.body.id}/agent-session`)
      .expect(200);
    expect(publicState.body.status).toBe("thinking");
    expect(publicState.body.lastActivityAt).toBeTruthy();
    expect(JSON.stringify(publicState.body)).not.toContain(token);
  });

  it("活动会话不会双启，暂停后可换新令牌重启", async () => {
    const game = await createAiGame();
    const created = await apiRequest()
      .post(`/api/v1/games/${game.body.id}/agent-session`)
      .expect(201);
    const firstToken = await readToken(game.body.id);

    const activeRestart = await apiRequest()
      .post(`/api/v1/games/${game.body.id}/agent-session/restart`)
      .expect(200);
    expect(activeRestart.body.sessionId).toBe(created.body.sessionId);
    expect(launch).toHaveBeenCalledTimes(1);

    await apiRequest()
      .patch(`/api/v1/games/${game.body.id}/agent-session/runner`)
      .set("authorization", `Bearer ${firstToken}`)
      .send({ status: "paused", error: "bad JSON twice" })
      .expect(200);
    const restarted = await apiRequest()
      .post(`/api/v1/games/${game.body.id}/agent-session/restart`)
      .expect(201);

    expect(restarted.body.sessionId).not.toBe(created.body.sessionId);
    expect(restarted.body.status).toBe("starting");
    expect(launch).toHaveBeenCalledTimes(2);
    await apiRequest()
      .get(`/api/v1/games/${game.body.id}/agent-session/runner`)
      .set("authorization", `Bearer ${firstToken}`)
      .expect(401);
  });

  it("停止会话后 Runner 轮询可观察 stopRequested", async () => {
    const game = await createAiGame();
    await apiRequest()
      .post(`/api/v1/games/${game.body.id}/agent-session`)
      .expect(201);
    const token = await readToken(game.body.id);

    const stopped = await apiRequest()
      .delete(`/api/v1/games/${game.body.id}/agent-session`)
      .expect(200);
    expect(stopped.body.status).toBe("stopped");
    const control = await apiRequest()
      .get(`/api/v1/games/${game.body.id}/agent-session/runner`)
      .set("authorization", `Bearer ${token}`)
      .expect(200);
    expect(control.body.stopRequested).toBe(true);
  });

  it("拒绝人人局、已终局以及无会话查询", async () => {
    const human = await apiRequest()
      .post("/api/v1/games")
      .send({ matchType: "human-human", player1Side: "red" })
      .expect(201);
    await apiRequest()
      .post(`/api/v1/games/${human.body.id}/agent-session`)
      .expect(422)
      .expect(({ body }) => expect(body.error.code).toBe("NOT_AI_GAME"));
    await apiRequest()
      .get(`/api/v1/games/${human.body.id}/agent-session`)
      .expect(404)
      .expect(({ body }) =>
        expect(body.error.code).toBe("AGENT_SESSION_NOT_FOUND"),
      );

    const finished = await createAiGame("red");
    await apiRequest()
      .post(`/api/v1/games/${finished.body.id}/resign`)
      .send({ expectedRevision: 0 })
      .expect(200);
    await apiRequest()
      .post(`/api/v1/games/${finished.body.id}/agent-session`)
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe("GAME_FINISHED"));
  });
});
