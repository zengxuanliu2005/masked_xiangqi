import { createServer, type Server } from "node:http";
import { createApp } from "./app";
import type { NetworkMode } from "./net/host-policy";
import { createNetworkController } from "./network";

const port = Number.parseInt(process.env.PORT ?? "3001", 10);
const production =
  process.env.NODE_ENV === "production" ||
  process.argv.includes("--production");
const initialMode: NetworkMode =
  process.env.LAN === "1" || process.argv.includes("--lan")
    ? "lan"
    : "loopback";

const controller = createNetworkController({
  port,
  initialMode,
  listen: (host, listenPort) =>
    new Promise<Server>((resolve, reject) => {
      const server = createServer(app);
      server.once("error", reject);
      server.listen(listenPort, host, () => {
        server.removeListener("error", reject);
        resolve(server);
      });
    }),
});

const app = createApp({
  serveFrontend: production,
  // The Runner always talks to the loopback interface, whatever the listener
  // is bound to, so this stays fixed across a mode switch.
  apiBaseUrl: `http://127.0.0.1:${port}`,
  networkMode: () => controller.mode(),
  networkController: controller,
});

await controller.start();

const describe = () => {
  const status = controller.status();
  // In dev the entry point is the health endpoint; append it to EVERY address
  // rather than to the joined string, or only the last URL would carry it.
  const suffix = production ? "" : "/api/v1/health";
  const hosts =
    status.mode === "lan" ? ["127.0.0.1", ...status.addresses] : ["127.0.0.1"];
  return hosts.map((host) => `http://${host}:${port}${suffix}`).join(" , ");
};
console.log(
  `覆子服务已启动（${controller.mode() === "lan" ? "局域网" : "仅本机"}）：${describe()}`,
);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.locals.shutdown?.();
  const server = controller.server();
  server?.closeIdleConnections?.();
  const closed = controller.close();
  const deadline = new Promise<void>((resolve) => {
    setTimeout(() => {
      server?.closeAllConnections?.();
      resolve();
    }, 5_000).unref();
  });
  await Promise.race([closed, deadline]);
  process.exitCode = 0;
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
