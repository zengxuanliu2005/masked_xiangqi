import { createApp } from "./app";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "3001", 10);
const app = createApp({
  serveFrontend:
    process.env.NODE_ENV === "production" ||
    process.argv.includes("--production"),
  apiBaseUrl: `http://${host}:${port}`,
});

const server = app.listen(port, host, () => {
  const entry =
    process.env.NODE_ENV === "production" ||
    process.argv.includes("--production")
      ? ""
      : "/api/v1/health";
  console.log(`覆子服务已启动：http://${host}:${port}${entry}`);
});

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.locals.shutdown?.();
  server.closeIdleConnections?.();
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  const deadline = new Promise<void>((resolve) => {
    setTimeout(() => {
      server.closeAllConnections?.();
      resolve();
    }, 5_000).unref();
  });
  await Promise.race([closed, deadline]);
  process.exitCode = 0;
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
