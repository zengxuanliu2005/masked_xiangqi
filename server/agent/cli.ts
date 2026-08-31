import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { AgentRunner } from "./runner";
import { AgentHttpClient } from "./http-client";
import { JsonlAgentLogger } from "./jsonl";
import { ConsoleAgentReporter } from "./reporter";
import { AGENT_SESSION_FILE_ENV, readAgentSessionFile } from "./session-file";
import { OllamaClient } from "../ollama";

const waitForManualClose = async () => {
  if (!input.isTTY) return;
  const terminal = createInterface({ input, output });
  try {
    await terminal.question("\n按 Enter 关闭此控制台…");
  } finally {
    terminal.close();
  }
};

const main = async () => {
  const sessionFilePath = process.env[AGENT_SESSION_FILE_ENV];
  if (!sessionFilePath) {
    throw new Error(`缺少 ${AGENT_SESSION_FILE_ENV}，请通过网页生成会话。`);
  }
  const session = await readAgentSessionFile(sessionFilePath);
  const shutdown = new AbortController();
  for (const signalName of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signalName, () =>
      shutdown.abort(new DOMException("控制台正在关闭。", "AbortError")),
    );
  }
  const runner = new AgentRunner({
    api: new AgentHttpClient(session),
    aiProvider: new OllamaClient(),
    logger: new JsonlAgentLogger(session.logPath),
    reporter: new ConsoleAgentReporter(),
    signal: shutdown.signal,
  });
  const result = await runner.run();
  console.log(`日志位置：${session.logPath}`);
  if (result === "finished" || result === "paused" || result === "exited") {
    await waitForManualClose();
  }
};

main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  await waitForManualClose();
  process.exitCode = 1;
});
