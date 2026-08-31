import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app";
import { GameStore } from "../engine/store";
import { AgentSessionManager } from "../server/agent/session-manager";
import type { TerminalLauncher } from "../server/agent/terminal";
import { readAgentSessionFile } from "../server/agent/session-file";
import { AgentHttpClient } from "../server/agent/http-client";
import { AgentRunner } from "../server/agent/runner";
import { MemoryAgentLogger } from "../server/agent/jsonl";
import { MemoryAgentReporter } from "../server/agent/reporter";
import type { AiProvider } from "../server/ollama";

describe("Agent Runner HTTP 端到端", () => {
  let server: Server | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    if (directory) {
      await rm(directory, { recursive: true, force: true });
      directory = undefined;
    }
  });

  it("假终端创建私有会话，假 Ollama 经真实 REST API 完成合法一步", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "masked-xiangqi-e2e-"));
    const launch = vi.fn<TerminalLauncher["launch"]>(async (filePath) => ({
      launched: true,
      terminal: "terminal",
      manualCommand: `run ${filePath}`,
    }));
    const manager = new AgentSessionManager({
      repositoryRoot: directory,
      sessionDirectory: path.join(directory, ".local", "agent-sessions"),
      logDirectory: path.join(directory, ".local", "agent-logs"),
      launcher: { launch, manualCommand: (filePath) => `run ${filePath}` },
    });
    const store = new GameStore();
    const aiProvider: AiProvider = {
      listModels: vi.fn(async () => [{ name: "fake-ollama" }]),
      getModelCapabilities: vi.fn(async () => ({
        capabilities: ["completion", "thinking"],
        supportsThinking: true,
        isGptOss: false,
      })),
      chooseMove: vi.fn(async (_input, options) => {
        options?.onThinking?.("公开局面推演");
        return {
          moveIndex: 0,
          source: "model" as const,
          note: "选择首个合法着法",
          thinking: "公开局面推演",
          content: '{"moveIndex":0,"reason":"选择首个合法着法"}',
        };
      }),
    };
    server = createServer(
      createApp({ store, aiProvider, agentSessionManager: manager }),
    );
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", () => resolve());
    });
    const client = request(server);
    const created = await client
      .post("/api/v1/games")
      .send({
        matchType: "human-ai",
        aiModel: "fake-ollama",
        player1Side: "black",
      })
      .expect(201);
    await client
      .post(`/api/v1/games/${created.body.id}/agent-session`)
      .expect(201);
    const session = await readAgentSessionFile(
      manager.sessionFilePath(created.body.id)!,
      directory,
    );
    const logger = new MemoryAgentLogger();
    const reporter = new MemoryAgentReporter();
    const runner = new AgentRunner({
      api: new AgentHttpClient(session),
      aiProvider,
      logger,
      reporter,
      pollIntervalMs: 2,
    });

    const running = runner.run();
    await vi.waitFor(() =>
      expect(store.get(created.body.id)?.revision).toBe(1),
    );
    manager.stop(created.body.id);

    await expect(running).resolves.toBe("stopped");
    expect(launch).toHaveBeenCalledTimes(1);
    expect(aiProvider.chooseMove).toHaveBeenCalledTimes(1);
    expect(store.get(created.body.id)).toMatchObject({
      revision: 1,
      turn: "black",
      moveNumber: 1,
    });
    expect(reporter.output).toContain("公开局面推演");
    expect(JSON.stringify(logger.records)).not.toContain("trueIdentity");
  });
});
