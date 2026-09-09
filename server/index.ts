import { createServer, type Server } from "node:http";
import { createApp } from "./app";
import { DEV_VITE_CONFIG } from "./dev-vite";
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

// Dev serves the SPA from this same listener through Vite's middlewares, so
// the page and the API share one origin and the LAN toggle behaves exactly as
// it does in production. `vite` is a devDependency, so this import must stay
// dynamic: a production install has no such package to resolve.
const vite = production
  ? null
  : await (async () => {
      const { createServer: createViteServer } = await import("vite");
      // `appType: "spa"` lets these middlewares transform index.html and
      // provide history fallback. HMR stays on its independent loopback socket
      // while the application listener is destroyed and recreated on rebind.
      return createViteServer(DEV_VITE_CONFIG);
    })();
const frontendMiddleware = vite?.middlewares;

const app = createApp({
  serveFrontend: production,
  frontendMiddleware,
  // The Runner always talks to the loopback interface, whatever the listener
  // is bound to, so this stays fixed across a mode switch.
  apiBaseUrl: `http://127.0.0.1:${port}`,
  networkMode: () => controller.mode(),
  networkController: controller,
});

await controller.start();

const describe = () => {
  const status = controller.status();
  // Dev and production both serve the page from this listener now, so every
  // address below is directly openable.
  const hosts =
    status.mode === "lan" ? ["127.0.0.1", ...status.addresses] : ["127.0.0.1"];
  return hosts.map((host) => `http://${host}:${port}`).join(" , ");
};
console.log(
  `覆子服务已启动（${controller.mode() === "lan" ? "局域网" : "仅本机"}）：${describe()}`,
);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.locals.shutdown?.();
  // Vite owns the HMR WebSocket server and file watchers. Without this the
  // dev process never exits: SIGTERM closes the HTTP listener and then hangs.
  await vite?.close();
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
