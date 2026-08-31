import { spawn } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const run = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn(npm, args, { stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm ${args.join(" ")} exited with ${code}`));
    });
  });

const waitForServer = async (baseUrl, child) => {
  const deadline = Date.now() + 20_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`production server exited early with ${child.exitCode}`);
    }
    try {
      const health = await fetch(`${baseUrl}/api/v1/health`);
      const page = await fetch(baseUrl);
      const favicon = await fetch(`${baseUrl}/favicon.svg`);
      if (
        health.ok &&
        page.ok &&
        favicon.ok &&
        (await page.text()).includes("覆子 · 象棋盲棋")
      ) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `production server did not become ready: ${String(lastError)}`,
  );
};

if (!process.argv.includes("--skip-install")) {
  await run(["ci"]);
  await run(["run", "build"]);
}

const port = "3217";
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(
  process.execPath,
  ["--import", "tsx", "server/index.ts", "--production"],
  {
    env: { ...process.env, PORT: port },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let output = "";
server.stdout.on("data", (chunk) => {
  output = `${output}${chunk}`.slice(-8_192);
});
server.stderr.on("data", (chunk) => {
  output = `${output}${chunk}`.slice(-8_192);
});

try {
  await waitForServer(baseUrl, server);
  process.stdout.write(
    "Production smoke passed: health, HTML, and favicon are reachable.\n",
  );
} finally {
  if (server.exitCode === null) {
    server.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => server.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_500)),
    ]);
  }
  if (server.exitCode === null) server.kill("SIGKILL");
  if (server.exitCode && server.exitCode !== 0) process.stderr.write(output);
}
