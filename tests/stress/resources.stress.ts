import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyMove,
  MAX_POSITION_COUNTS,
  MAX_UNDO_PLY,
} from "../../engine/game";
import { GameStore } from "../../engine/store";
import { createScenario } from "../../engine/setup";
import { createApp } from "../../server/app";
import { JsonlAgentLogger } from "../../server/agent/jsonl";
import { AgentSessionManager } from "../../server/agent/session-manager";
import type { TerminalLauncher } from "../../server/agent/terminal";
import type { AiProvider } from "../../server/ollama";
import { testPiece } from "../helpers";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("有界资源压力", () => {
  it("10,000 次对局 churn 后容量与 RSS 增量保持有界", () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const store = new GameStore({ now: () => now });
    const baseline = process.memoryUsage().rss;
    for (let index = 0; index < 10_000; index += 1) {
      const game = store.create({
        mode: "capture-general",
        player1Side: "red",
        matchType: "human-human",
      });
      game.status = { phase: "finished", winner: "red", reason: "resignation" };
      game.finishedAt = now.toISOString();
      now = new Date(now.getTime() + 60 * 60 * 1_000 + 1);
    }
    expect(store.size).toBeLessThanOrEqual(1);
    expect(process.memoryUsage().rss - baseline).toBeLessThan(
      200 * 1024 * 1024,
    );
  });

  it("1,004 ply 长局不会突破悔棋栈或重复局面 Map 上限", () => {
    const game = createScenario({
      mode: "capture-general",
      allowDraw: false,
      pieces: [
        testPiece("black-general", "black", "general", 4, 0),
        testPiece("black-rook", "black", "rook", 8, 0),
        testPiece("red-rook", "red", "rook", 0, 9),
        testPiece("red-general", "red", "general", 4, 9),
      ],
    });
    for (let ply = 0; ply < 1_004; ply += 1) {
      const redForward = Math.floor(ply / 2) % 2 === 0;
      const command =
        ply % 2 === 0
          ? {
              from: { x: 0, y: redForward ? 9 : 8 },
              to: { x: 0, y: redForward ? 8 : 9 },
            }
          : {
              from: { x: 8, y: redForward ? 0 : 1 },
              to: { x: 8, y: redForward ? 1 : 0 },
            };
      applyMove(game, { ...command, expectedRevision: ply });
    }
    expect(game.revision).toBe(1_004);
    expect(game.moveNumber).toBe(1_004);
    expect(game.undoStack.length).toBe(MAX_UNDO_PLY);
    expect(game.positionCounts.size).toBeLessThanOrEqual(MAX_POSITION_COUNTS);
  });

  it("500 次 Agent 会话启停后凭据文件清空且 Session Map 有界", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "masked-session-stress-"));
    temporaryDirectories.push(root);
    let sessionId = 0;
    const launcher: TerminalLauncher = {
      launch: vi.fn(async (filePath) => ({
        launched: true,
        terminal: "terminal" as const,
        manualCommand: `run ${filePath}`,
      })),
      manualCommand: (filePath) => `run ${filePath}`,
    };
    const manager = new AgentSessionManager({
      repositoryRoot: root,
      launcher,
      sessionIdFactory: () =>
        `00000000-0000-4000-8000-${String(++sessionId).padStart(12, "0")}`,
      tokenFactory: () => `token-${sessionId}-${"x".repeat(36)}`,
    });
    const store = new GameStore();
    for (let index = 0; index < 500; index += 1) {
      const game = store.create({
        mode: "capture-general",
        player1Side: "red",
        matchType: "human-ai",
        aiModel: "fake",
      });
      await manager.create(game, "http://127.0.0.1:3001");
      manager.stop(game.id);
    }
    expect(manager.size).toBeLessThanOrEqual(500);
    expect(
      await readdir(path.join(root, ".local", "agent-sessions")),
    ).toHaveLength(0);
  });

  it("JSONL 日志限制为 5 MiB 并只保留一个轮转文件", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "masked-log-stress-"));
    temporaryDirectories.push(root);
    const logPath = path.join(root, "agent-logs", "game.jsonl");
    const logger = new JsonlAgentLogger(logPath);
    for (let index = 0; index < 64; index += 1) {
      await logger.write({
        timestamp: new Date().toISOString(),
        event: "stress",
        payload: "x".repeat(90_000),
      });
    }
    expect((await stat(logPath)).size).toBeLessThanOrEqual(5 * 1024 * 1024);
    expect((await stat(`${logPath}.1`)).size).toBeLessThanOrEqual(
      5 * 1024 * 1024,
    );
    expect((await readdir(path.dirname(logPath))).sort()).toEqual([
      "game.jsonl",
      "game.jsonl.1",
    ]);
  });

  it("混合 HTTP 并发期间无意外 5xx，延迟满足本机门限", async () => {
    const aiProvider: AiProvider = {
      listModels: vi.fn(async () => []),
      chooseMove: vi.fn(async () => ({
        moveIndex: 0,
        source: "model" as const,
      })),
    };
    const app = createApp({ aiProvider });
    const server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const api = request(server);
    const descriptorBaseline =
      process.platform === "win32" ? null : (await readdir("/dev/fd")).length;
    let requestCount = 0;
    let unexpected5xx = 0;
    let slowerThan200Ms = 0;
    let slowerThan500Ms = 0;
    try {
      const durationMs = Number(process.env.STRESS_DURATION_MS ?? 2_000);
      const deadline = Date.now() + durationMs;
      while (Date.now() < deadline) {
        await Promise.all(
          Array.from({ length: 50 }, async (_, index) => {
            const started = performance.now();
            const result =
              index % 2 === 0
                ? await api.get("/api/v1/health")
                : await api.get("/api/v1/ai/models");
            const latency = performance.now() - started;
            requestCount += 1;
            if (result.status >= 500) unexpected5xx += 1;
            if (latency >= 200) slowerThan200Ms += 1;
            if (latency >= 500) slowerThan500Ms += 1;
          }),
        );
      }
      expect(requestCount).toBeGreaterThan(0);
      expect(unexpected5xx).toBe(0);
      expect(slowerThan200Ms / requestCount).toBeLessThan(0.05);
      expect(slowerThan500Ms / requestCount).toBeLessThan(0.01);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (descriptorBaseline !== null) {
      await new Promise((resolve) => setImmediate(resolve));
      expect((await readdir("/dev/fd")).length).toBeLessThanOrEqual(
        descriptorBaseline + 10,
      );
    }
  });
});
