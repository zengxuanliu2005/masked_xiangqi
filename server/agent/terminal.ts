import { existsSync } from "node:fs";
import path from "node:path";
import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import type { AgentTerminalKind } from "../../shared/contracts";
import { AGENT_SESSION_FILE_ENV } from "./session-file";

export interface TerminalLaunchResult {
  launched: boolean;
  terminal: AgentTerminalKind | null;
  manualCommand: string;
  error?: string;
}

export interface TerminalLauncher {
  launch(sessionFilePath: string): Promise<TerminalLaunchResult>;
  manualCommand(sessionFilePath: string): string;
}

export interface TerminalDetectionOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (candidate: string) => boolean;
  commandExists?: (command: string) => boolean;
}

const defaultCommandExists = (command: string): boolean => {
  const lookup = process.platform === "win32" ? "where.exe" : "which";
  return spawnSync(lookup, [command], { stdio: "ignore" }).status === 0;
};

/** Return the first supported terminal in the documented platform order. */
export function detectTerminal(
  options: TerminalDetectionOptions = {},
): AgentTerminalKind | null {
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const commandExists = options.commandExists ?? defaultCommandExists;

  if (platform === "darwin") {
    if (
      exists("/Applications/iTerm.app") ||
      exists("/Applications/iTerm2.app")
    ) {
      return "iterm2";
    }
    if (
      exists("/System/Applications/Utilities/Terminal.app") ||
      exists("/Applications/Utilities/Terminal.app")
    ) {
      return "terminal";
    }
    return null;
  }
  if (platform === "win32") {
    if (commandExists("pwsh")) return "powershell7";
    if (commandExists("powershell")) return "windows-powershell";
    if (commandExists("cmd.exe") || commandExists("cmd")) return "cmd";
    return null;
  }
  if (platform === "linux") {
    for (const [command, terminal] of [
      ["x-terminal-emulator", "x-terminal-emulator"],
      ["gnome-terminal", "gnome-terminal"],
      ["konsole", "konsole"],
      ["xfce4-terminal", "xfce4-terminal"],
    ] as const) {
      if (commandExists(command)) return terminal;
    }
  }
  return null;
}

const quotePosix = (value: string): string =>
  `'${value.replaceAll("'", `'"'"'`)}'`;
const quotePowerShell = (value: string): string =>
  `'${value.replaceAll("'", "''")}'`;
const quoteCmd = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const quoteAppleScript = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

export interface SystemTerminalLauncherOptions {
  repositoryRoot?: string;
  runnerPath?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  terminal?: AgentTerminalKind | null;
  spawnProcess?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => Pick<ChildProcess, "unref"> & Partial<Pick<ChildProcess, "once">>;
}

/**
 * Launches one repository-owned entrypoint. Callers provide only a generated
 * session-file path; no command, model name, URL, or token can be injected.
 */
export class SystemTerminalLauncher implements TerminalLauncher {
  private readonly repositoryRoot: string;
  private readonly runnerPath: string;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly selectedTerminal: AgentTerminalKind | null;
  private readonly spawnProcess: NonNullable<
    SystemTerminalLauncherOptions["spawnProcess"]
  >;

  constructor(options: SystemTerminalLauncherOptions = {}) {
    this.repositoryRoot = path.resolve(options.repositoryRoot ?? process.cwd());
    this.runnerPath = path.resolve(
      options.runnerPath ??
        path.join(this.repositoryRoot, "server/agent/cli.ts"),
    );
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.selectedTerminal =
      options.terminal === undefined
        ? detectTerminal({ platform: this.platform, env: this.env })
        : options.terminal;
    this.spawnProcess =
      options.spawnProcess ??
      ((command, args, spawnOptions) =>
        spawn(command, [...args], spawnOptions));
  }

  private assertSessionPath(sessionFilePath: string): string {
    const resolved = path.resolve(sessionFilePath);
    const localRoot = path.join(
      this.repositoryRoot,
      ".local",
      "agent-sessions",
    );
    const relative = path.relative(localRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(
        "Agent 会话文件必须位于仓库的 .local/agent-sessions 目录。 ",
      );
    }
    return resolved;
  }

  manualCommand(sessionFilePath: string): string {
    const sessionPath = this.assertSessionPath(sessionFilePath);
    if (this.platform === "win32") {
      if (this.selectedTerminal === "cmd") {
        return `set "${AGENT_SESSION_FILE_ENV}=${sessionPath}" && ${quoteCmd(process.execPath)} --import tsx ${quoteCmd(this.runnerPath)}`;
      }
      return `$env:${AGENT_SESSION_FILE_ENV}=${quotePowerShell(sessionPath)}; & ${quotePowerShell(process.execPath)} --import tsx ${quotePowerShell(this.runnerPath)}`;
    }
    return `${AGENT_SESSION_FILE_ENV}=${quotePosix(sessionPath)} ${quotePosix(process.execPath)} --import tsx ${quotePosix(this.runnerPath)}`;
  }

  async launch(sessionFilePath: string): Promise<TerminalLaunchResult> {
    let sessionPath: string;
    try {
      sessionPath = this.assertSessionPath(sessionFilePath);
    } catch (error) {
      return {
        launched: false,
        terminal: null,
        manualCommand: "",
        error: error instanceof Error ? error.message : "会话文件路径无效。",
      };
    }
    const manualCommand = this.manualCommand(sessionPath);
    const terminal = this.selectedTerminal;
    if (!terminal) {
      return {
        launched: false,
        terminal: null,
        manualCommand,
        error: "没有检测到受支持的桌面终端。",
      };
    }
    if (
      this.platform === "linux" &&
      !this.env.DISPLAY &&
      !this.env.WAYLAND_DISPLAY
    ) {
      return {
        launched: false,
        terminal,
        manualCommand,
        error: "当前 Linux 环境没有可用的桌面显示会话。",
      };
    }

    const childEnv = {
      ...this.env,
      [AGENT_SESSION_FILE_ENV]: sessionPath,
    };
    let command: string;
    let args: readonly string[];
    if (terminal === "iterm2" || terminal === "terminal") {
      const application = terminal === "iterm2" ? "iTerm" : "Terminal";
      const shellCommand = `cd ${quotePosix(this.repositoryRoot)} && ${manualCommand}`;
      const script =
        terminal === "iterm2"
          ? // iTerm executes an AppleScript `command` directly rather than through
            // the profile's shell. Invoke a shell explicitly so built-ins (`cd`),
            // environment assignments, and `&&` are interpreted as intended.
            `tell application "${application}" to create window with default profile command "${quoteAppleScript(`/bin/zsh -c ${quotePosix(shellCommand)}`)}"`
          : `tell application "${application}" to do script "${quoteAppleScript(shellCommand)}"`;
      command = "/usr/bin/osascript";
      args = ["-e", script];
    } else if (
      terminal === "powershell7" ||
      terminal === "windows-powershell"
    ) {
      command = terminal === "powershell7" ? "pwsh" : "powershell";
      const run = `& ${quotePowerShell(process.execPath)} --import tsx ${quotePowerShell(this.runnerPath)}`;
      args = ["-NoLogo", "-NoProfile", "-NoExit", "-Command", run];
    } else if (terminal === "cmd") {
      command = "cmd.exe";
      args = [
        "/d",
        "/k",
        `${quoteCmd(process.execPath)} --import tsx ${quoteCmd(this.runnerPath)}`,
      ];
    } else {
      command = terminal;
      const runnerArgs = [process.execPath, "--import", "tsx", this.runnerPath];
      args =
        terminal === "gnome-terminal"
          ? ["--", ...runnerArgs]
          : terminal === "xfce4-terminal"
            ? ["--command", runnerArgs.map(quotePosix).join(" ")]
            : ["-e", ...runnerArgs];
    }

    try {
      const child = this.spawnProcess(command, args, {
        cwd: this.repositoryRoot,
        env: childEnv,
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
      if (child.once) {
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve();
          };
          const timer = setTimeout(
            () => finish(new Error("等待终端进程启动超时。")),
            2_000,
          );
          child.once!("spawn", () => finish());
          child.once!("error", (error) => finish(error));
        });
      }
      child.unref();
      return { launched: true, terminal, manualCommand };
    } catch (error) {
      return {
        launched: false,
        terminal,
        manualCommand,
        error:
          error instanceof Error
            ? `终端启动失败：${error.message}`
            : "终端启动失败。",
      };
    }
  }
}
