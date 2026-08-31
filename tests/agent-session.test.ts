import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GameStore } from "../engine/store";
import { AgentSessionManager } from "../server/agent/session-manager";
import {
  detectTerminal,
  SystemTerminalLauncher,
  type TerminalLauncher,
} from "../server/agent/terminal";
import {
  readAgentSessionFile,
  writeAgentSessionFile,
} from "../server/agent/session-file";

const temporaryDirectories: string[] = [];

const temporaryDirectory = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "masked-xiangqi-agent-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

describe("Agent 会话文件与终端", () => {
  it("服务启动时撤销上个进程遗留的孤儿凭据", async () => {
    const directory = await temporaryDirectory();
    const orphan = path.join(
      directory,
      ".local",
      "agent-sessions",
      "orphan.json",
    );
    await writeAgentSessionFile(orphan, {
      version: 1,
      sessionId: "00000000-0000-4000-8000-000000000099",
      gameId: "orphan-game",
      apiBaseUrl: "http://127.0.0.1:3001",
      token: "orphan-token".padEnd(43, "x"),
      logPath: path.join(
        directory,
        ".local",
        "agent-logs",
        "orphan-game.jsonl",
      ),
    });
    await expect(access(orphan)).resolves.toBeUndefined();

    new AgentSessionManager({ repositoryRoot: directory });

    await expect(access(orphan)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("以 0600 权限写入一次性凭据并可严格读取", async () => {
    const directory = await temporaryDirectory();
    const filePath = path.join(
      directory,
      ".local",
      "agent-sessions",
      "session.json",
    );
    const contents = {
      version: 1 as const,
      sessionId: "00000000-0000-4000-8000-000000000000",
      gameId: "game-file",
      apiBaseUrl: "http://127.0.0.1:3001",
      token: "x".repeat(43),
      logPath: path.join(directory, ".local", "agent-logs", "game-file.jsonl"),
    };

    await writeAgentSessionFile(filePath, contents);

    expect(await readAgentSessionFile(filePath, directory)).toEqual(contents);
    if (process.platform !== "win32") {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(filePath))).mode & 0o777).toBe(0o700);
    }
  });

  it("按 macOS、Windows、Linux 的固定优先级检测终端", () => {
    expect(
      detectTerminal({
        platform: "darwin",
        exists: (candidate) => candidate === "/Applications/iTerm.app",
      }),
    ).toBe("iterm2");

    const windowsChecks: string[] = [];
    expect(
      detectTerminal({
        platform: "win32",
        commandExists: (command) => {
          windowsChecks.push(command);
          return command === "powershell";
        },
      }),
    ).toBe("windows-powershell");
    expect(windowsChecks).toEqual(["pwsh", "powershell"]);

    const linuxChecks: string[] = [];
    expect(
      detectTerminal({
        platform: "linux",
        commandExists: (command) => {
          linuxChecks.push(command);
          return command === "konsole";
        },
      }),
    ).toBe("konsole");
    expect(linuxChecks).toEqual([
      "x-terminal-emulator",
      "gnome-terminal",
      "konsole",
    ]);
  });

  it("终端启动器只运行固定 Runner，凭据不进入参数或手动命令", async () => {
    const repositoryRoot = process.cwd();
    const sessionFilePath = path.join(
      repositoryRoot,
      ".local",
      "agent-sessions",
      "safe-session.json",
    );
    const spawnProcess = vi.fn(
      (_command: string, _args: readonly string[], _options: SpawnOptions) => ({
        unref: vi.fn(),
      }),
    );
    const launcher = new SystemTerminalLauncher({
      repositoryRoot,
      platform: "linux",
      env: { DISPLAY: ":1" },
      terminal: "gnome-terminal",
      spawnProcess,
    });

    const result = await launcher.launch(sessionFilePath);

    expect(result).toMatchObject({
      launched: true,
      terminal: "gnome-terminal",
    });
    const [command, args, options] = spawnProcess.mock.calls[0];
    expect(command).toBe("gnome-terminal");
    expect(args).toContain(path.join(repositoryRoot, "server/agent/cli.ts"));
    expect(JSON.stringify(args)).not.toContain("secret-token");
    expect(options.env).toMatchObject({
      MASKED_XIANGQI_AGENT_SESSION_FILE: sessionFilePath,
    });
    expect(result.manualCommand).toContain("MASKED_XIANGQI_AGENT_SESSION_FILE");
    expect(result.manualCommand).not.toContain("secret-token");
  });

  it("在 iTerm2 中显式通过 zsh 解释 cd、环境变量与复合命令", async () => {
    const repositoryRoot = process.cwd();
    const sessionFilePath = path.join(
      repositoryRoot,
      ".local",
      "agent-sessions",
      "mac-session.json",
    );
    const spawnProcess = vi.fn(
      (_command: string, _args: readonly string[], _options: SpawnOptions) => ({
        unref: vi.fn(),
      }),
    );
    const launcher = new SystemTerminalLauncher({
      repositoryRoot,
      platform: "darwin",
      terminal: "iterm2",
      spawnProcess,
    });

    await launcher.launch(sessionFilePath);

    const [command, args] = spawnProcess.mock.calls[0];
    expect(command).toBe("/usr/bin/osascript");
    expect(args[0]).toBe("-e");
    expect(args[1]).toContain("/bin/zsh -c");
    expect(args[1]).toContain("MASKED_XIANGQI_AGENT_SESSION_FILE");
    expect(args[1].replaceAll("\\", "/")).toContain("server/agent/cli.ts");
  });

  it("单对局只启动一个会话，公开状态不泄露 token", async () => {
    const directory = await temporaryDirectory();
    const launches: string[] = [];
    const launcher: TerminalLauncher = {
      manualCommand: (filePath) => `manual ${filePath}`,
      launch: async (filePath) => {
        launches.push(filePath);
        return {
          launched: true,
          terminal: "terminal",
          manualCommand: `manual ${filePath}`,
        };
      },
    };
    const manager = new AgentSessionManager({
      repositoryRoot: directory,
      sessionDirectory: path.join(directory, ".local", "agent-sessions"),
      logDirectory: path.join(directory, ".local", "agent-logs"),
      launcher,
      sessionIdFactory: () => "00000000-0000-4000-8000-000000000001",
      tokenFactory: () => "session-secret-".padEnd(43, "x"),
    });
    const game = new GameStore().create({
      mode: "standard",
      player1Side: "red",
      matchType: "human-ai",
      aiModel: "model-name-must-not-enter-session-file",
    });

    const first = await manager.create(game, "http://127.0.0.1:3001");
    const duplicate = await manager.create(game, "http://127.0.0.1:3001");

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(launches).toHaveLength(1);
    expect(JSON.stringify(first.state)).not.toContain("session-secret");
    expect(first.state).not.toHaveProperty("sessionFilePath");
    const filePath = manager.sessionFilePath(game.id)!;
    const rawFile = await readFile(filePath, "utf8");
    expect(rawFile).toContain("session-secret");
    expect(rawFile).not.toContain("model-name-must-not-enter-session-file");
  });

  it("终端拒绝启动时保持 paused 并提供不含 token 的手动命令", async () => {
    const directory = await temporaryDirectory();
    const launcher: TerminalLauncher = {
      manualCommand: (filePath) => `run-fixed ${filePath}`,
      launch: async (filePath) => ({
        launched: false,
        terminal: null,
        manualCommand: `run-fixed ${filePath}`,
        error: "没有桌面环境",
      }),
    };
    const manager = new AgentSessionManager({
      repositoryRoot: directory,
      sessionDirectory: path.join(directory, ".local", "agent-sessions"),
      launcher,
      tokenFactory: () => "never-expose-this-token".padEnd(43, "x"),
    });
    const game = new GameStore().create({
      mode: "standard",
      player1Side: "red",
      matchType: "human-ai",
      aiModel: "local-model",
    });

    const result = await manager.create(game, "http://localhost:3001");

    expect(result.state).toMatchObject({
      status: "paused",
      error: "没有桌面环境",
    });
    expect(result.state.manualCommand).toContain("run-fixed");
    expect(result.state.manualCommand).not.toContain("never-expose-this-token");
  });

  it("活动控制器心跳超时后标记 exited，允许重新打开", async () => {
    const directory = await temporaryDirectory();
    let currentTime = new Date("2026-08-30T00:00:00.000Z");
    const launcher: TerminalLauncher = {
      manualCommand: (filePath) => `run ${filePath}`,
      launch: async (filePath) => ({
        launched: true,
        terminal: "terminal",
        manualCommand: `run ${filePath}`,
      }),
    };
    const manager = new AgentSessionManager({
      repositoryRoot: directory,
      sessionDirectory: path.join(directory, ".local", "agent-sessions"),
      launcher,
      now: () => currentTime,
      staleAfterMs: 1_000,
    });
    const game = new GameStore().create({
      mode: "standard",
      player1Side: "red",
      matchType: "human-ai",
      aiModel: "local-model",
    });
    await manager.create(game, "http://127.0.0.1:3001");

    currentTime = new Date("2026-08-30T00:00:02.000Z");

    expect(manager.get(game.id)).toMatchObject({
      status: "exited",
      error: "控制器心跳超时，终端可能已关闭。",
    });
  });

  it("最多保留配置数量的活动/暂停会话，暂停 TTL 到期会删除凭据", async () => {
    const directory = await temporaryDirectory();
    let currentTime = new Date("2026-08-31T00:00:00.000Z");
    let sequence = 0;
    const launcher: TerminalLauncher = {
      manualCommand: (filePath) => `run ${filePath}`,
      launch: async (filePath) => ({
        launched: false,
        terminal: null,
        manualCommand: `run ${filePath}`,
        error: "等待手动启动",
      }),
    };
    const manager = new AgentSessionManager({
      repositoryRoot: directory,
      launcher,
      now: () => currentTime,
      maxActiveSessions: 2,
      retentionMs: 60 * 60 * 1_000,
      sessionIdFactory: () =>
        `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
      tokenFactory: () => `token-${sequence}-${"x".repeat(36)}`,
    });
    const games = Array.from({ length: 3 }, () =>
      new GameStore().create({
        mode: "standard",
        player1Side: "red",
        matchType: "human-ai",
        aiModel: "local-model",
      }),
    );
    await manager.create(games[0], "http://127.0.0.1:3001");
    await manager.create(games[1], "http://127.0.0.1:3001");
    const firstCredential = manager.sessionFilePath(games[0].id)!;

    await expect(
      manager.create(games[2], "http://127.0.0.1:3001"),
    ).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
    await expect(access(firstCredential)).resolves.toBeUndefined();

    currentTime = new Date("2026-08-31T01:00:00.001Z");
    expect(manager.size).toBe(0);
    await expect(access(firstCredential)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      manager.create(games[2], "http://127.0.0.1:3001"),
    ).resolves.toMatchObject({ created: true });
  });

  it("结束、停止、重启与 stopAll 都撤销旧凭据，finished 控制器可在悔棋后重启", async () => {
    const directory = await temporaryDirectory();
    let sequence = 0;
    const launcher: TerminalLauncher = {
      manualCommand: (filePath) => `run ${filePath}`,
      launch: async (filePath) => ({
        launched: true,
        terminal: "terminal",
        manualCommand: `run ${filePath}`,
      }),
    };
    const manager = new AgentSessionManager({
      repositoryRoot: directory,
      launcher,
      sessionIdFactory: () =>
        `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
      tokenFactory: () => `token-${sequence}-${"x".repeat(36)}`,
    });
    const game = new GameStore().create({
      mode: "standard",
      player1Side: "red",
      matchType: "human-ai",
      aiModel: "local-model",
    });
    const first = await manager.create(game, "http://localhost:3001");
    const firstPath = manager.sessionFilePath(game.id)!;
    manager.finish(game.id);
    await expect(access(firstPath)).rejects.toMatchObject({ code: "ENOENT" });

    const restarted = await manager.restart(game, "http://localhost:3001");
    const secondPath = manager.sessionFilePath(game.id)!;
    expect(restarted.created).toBe(true);
    expect(restarted.state.sessionId).not.toBe(first.state.sessionId);
    manager.stopAll();
    await expect(access(secondPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(manager.get(game.id)?.status).toBe("stopped");
  });

  it("终端启动结果等待真实 spawn/error 事件，并正确处理带空格路径", async () => {
    const repositoryRoot = path.join(
      await temporaryDirectory(),
      "repository with spaces",
    );
    const sessionFilePath = path.join(
      repositoryRoot,
      ".local",
      "agent-sessions",
      "session with spaces.json",
    );
    const spawned = new EventEmitter() as EventEmitter & {
      unref: ReturnType<typeof vi.fn>;
    };
    spawned.unref = vi.fn();
    const successLauncher = new SystemTerminalLauncher({
      repositoryRoot,
      platform: "linux",
      env: { DISPLAY: ":1" },
      terminal: "gnome-terminal",
      spawnProcess: () => {
        setTimeout(() => spawned.emit("spawn"), 0);
        return spawned as unknown as Pick<ChildProcess, "unref"> &
          Partial<Pick<ChildProcess, "once">>;
      },
    });

    await expect(
      successLauncher.launch(sessionFilePath),
    ).resolves.toMatchObject({ launched: true, terminal: "gnome-terminal" });
    expect(spawned.unref).toHaveBeenCalledOnce();
    expect(successLauncher.manualCommand(sessionFilePath)).toContain(
      `='${sessionFilePath}'`,
    );

    const failed = new EventEmitter() as EventEmitter & {
      unref: ReturnType<typeof vi.fn>;
    };
    failed.unref = vi.fn();
    const failureLauncher = new SystemTerminalLauncher({
      repositoryRoot,
      platform: "darwin",
      terminal: "terminal",
      spawnProcess: () => {
        setTimeout(() => failed.emit("error", new Error("spawn denied")), 0);
        return failed as unknown as Pick<ChildProcess, "unref"> &
          Partial<Pick<ChildProcess, "once">>;
      },
    });
    await expect(
      failureLauncher.launch(sessionFilePath),
    ).resolves.toMatchObject({
      launched: false,
      terminal: "terminal",
      error: "终端启动失败：spawn denied",
    });
    expect(failed.unref).not.toHaveBeenCalled();
  });
});
