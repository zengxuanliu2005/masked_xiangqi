import {
  chmod,
  lstat,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const AGENT_SESSION_FILE_ENV = "MASKED_XIANGQI_AGENT_SESSION_FILE";

const sessionFileSchema = z
  .object({
    version: z.literal(1),
    sessionId: z.string().uuid(),
    gameId: z.string().min(1),
    apiBaseUrl: z.string().url(),
    token: z.string().min(32),
    logPath: z.string().min(1),
  })
  .strict();

export type AgentSessionFile = z.infer<typeof sessionFileSchema>;

export async function writeAgentSessionFile(
  filePath: string,
  contents: AgentSessionFile,
): Promise<void> {
  const validated = sessionFileSchema.parse(contents);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(filePath), 0o700);
  await writeFile(filePath, `${JSON.stringify(validated)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await chmod(filePath, 0o600);
}

export async function readAgentSessionFile(
  filePath: string,
  repositoryRoot = process.cwd(),
): Promise<AgentSessionFile> {
  const root = path.resolve(repositoryRoot);
  const sessionRoot = path.join(root, ".local", "agent-sessions");
  const logRoot = path.join(root, ".local", "agent-logs");
  const assertContainedPath = async (
    candidate: string,
    expectedRoot: string,
    label: string,
  ): Promise<string> => {
    const resolved = path.resolve(candidate);
    const relative = path.relative(expectedRoot, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`${label}必须位于仓库指定的 .local 目录内。`);
    }
    let current = expectedRoot;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      try {
        if ((await lstat(current)).isSymbolicLink()) {
          throw new Error(`${label}不能经过软链接。`);
        }
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          continue;
        }
        throw error;
      }
    }
    return resolved;
  };

  const resolvedSessionPath = await assertContainedPath(
    filePath,
    sessionRoot,
    "Agent 会话文件",
  );
  if (!resolvedSessionPath.endsWith(".json")) {
    throw new Error("Agent 会话文件必须是 JSON 文件。");
  }
  if ((await stat(resolvedSessionPath)).size > 16 * 1024) {
    throw new Error("Agent 会话文件超过 16 KiB 限制。");
  }
  const parsed = sessionFileSchema.parse(
    JSON.parse(await readFile(resolvedSessionPath, "utf8")) as unknown,
  );
  const apiUrl = new URL(parsed.apiBaseUrl);
  if (
    apiUrl.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "::1", "[::1]"].includes(
      apiUrl.hostname.toLowerCase(),
    ) ||
    apiUrl.username ||
    apiUrl.password
  ) {
    throw new Error("Agent Runner 只能连接无凭据的本机 HTTP API。");
  }
  const resolvedLogPath = await assertContainedPath(
    parsed.logPath,
    logRoot,
    "Agent 日志",
  );
  if (!resolvedLogPath.endsWith(".jsonl")) {
    throw new Error("Agent 日志必须是 JSONL 文件。");
  }
  return {
    ...parsed,
    apiBaseUrl: apiUrl.toString().replace(/\/$/, ""),
    logPath: resolvedLogPath,
  };
}
