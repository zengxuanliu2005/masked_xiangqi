import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";

export interface AgentLogRecord {
  timestamp: string;
  event: string;
  [key: string]: unknown;
}

export interface AgentLogger {
  write(record: AgentLogRecord): Promise<void>;
}

export class JsonlAgentLogger implements AgentLogger {
  private initialized = false;
  private readonly maxBytes = 5 * 1024 * 1024;
  private readonly maxAgeMs = 7 * 24 * 60 * 60 * 1_000;

  constructor(private readonly filePath: string) {}

  async write(record: AgentLogRecord): Promise<void> {
    if (!this.initialized) {
      const directory = path.dirname(this.filePath);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const cutoff = Date.now() - this.maxAgeMs;
      await Promise.all(
        (await readdir(directory, { withFileTypes: true })).map(
          async (entry) => {
            if (!entry.isFile() || !/\.jsonl(?:\.1)?$/.test(entry.name)) return;
            const candidate = path.join(directory, entry.name);
            const metadata = await stat(candidate);
            if (metadata.mtimeMs < cutoff) await rm(candidate, { force: true });
          },
        ),
      );
      this.initialized = true;
    }
    const line = `${JSON.stringify(record)}\n`;
    let currentSize = 0;
    try {
      const metadata = await lstat(this.filePath);
      if (metadata.isSymbolicLink()) {
        throw new Error("Agent 日志不能写入软链接。");
      }
      currentSize = metadata.size;
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )) {
        throw error;
      }
    }
    if (currentSize + Buffer.byteLength(line) > this.maxBytes) {
      const rotated = `${this.filePath}.1`;
      await rm(rotated, { force: true });
      if (currentSize > 0) await rename(this.filePath, rotated);
    }
    await appendFile(this.filePath, line, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(this.filePath, 0o600);
  }
}

export class MemoryAgentLogger implements AgentLogger {
  readonly records: AgentLogRecord[] = [];

  async write(record: AgentLogRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }
}
