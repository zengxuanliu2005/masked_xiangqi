import { networkInterfaces } from "node:os";
import type { Server } from "node:http";
import { isPrivateIpLiteral, type NetworkMode } from "./net/host-policy";

export const LOOPBACK_BIND_HOST = "127.0.0.1";
/**
 * Explicit rather than a bare `listen(port)`, which would dual-stack onto `::`
 * and expose more than LAN mode intends.
 */
export const LAN_BIND_HOST = "0.0.0.0";

export const bindHostFor = (mode: NetworkMode): string =>
  mode === "lan" ? LAN_BIND_HOST : LOOPBACK_BIND_HOST;

export interface NetworkControllerOptions {
  port: number;
  initialMode?: NetworkMode;
  /** Injectable so tests can drive the state machine without a real socket. */
  listen: (host: string, port: number) => Promise<Server>;
  interfaces?: typeof networkInterfaces;
  /** How long a rebind waits for in-flight requests before forcing sockets shut. */
  closeGraceMs?: number;
}

export interface NetworkStatus {
  /** The mode of the listener that is currently bound. */
  mode: NetworkMode;
  /** The final requested mode while work is queued; equals `mode` when idle. */
  targetMode: NetworkMode;
  port: number;
  addresses: string[];
  /** Set when the last switch failed and the previous bind was kept. */
  error: string | null;
  /** True while a start, close, switch, or rollback is queued/running. */
  pending: boolean;
  /** False while rebinding, after close, or if both binds failed. */
  listening: boolean;
}

/**
 * The machine's own reachable addresses, for building a join link. Filtered
 * through the very predicate the Host gate uses, so we can never advertise a
 * URL that the server would then refuse — a CGNAT/Tailscale address
 * (100.64.0.0/10) is reachable but deliberately outside the LAN allowlist.
 */
export const localAddresses = (
  read: typeof networkInterfaces = networkInterfaces,
): string[] => {
  const found: string[] = [];
  for (const entries of Object.values(read())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (!isPrivateIpLiteral(entry.address)) continue;
      found.push(entry.address);
    }
  }
  return found.sort();
};

export const createNetworkController = (options: NetworkControllerOptions) => {
  const { port, listen } = options;
  const readInterfaces = options.interfaces ?? networkInterfaces;
  const closeGraceMs = options.closeGraceMs ?? 1_500;
  let mode: NetworkMode = options.initialMode ?? "loopback";
  let targetMode: NetworkMode = mode;
  let server: Server | null = null;
  let lastError: string | null = null;
  let pendingOperations = 0;
  let queue: Promise<void> = Promise.resolve();
  let terminal = false;
  let closePromise: Promise<void> | null = null;

  /**
   * `server.close()` does not resolve until every in-flight request finishes,
   * and `ai-move` can stream from Ollama for minutes. Waiting for that would
   * leave the port unbound for the whole request, so idle sockets are dropped
   * first and stubborn ones are force-closed after a short grace period.
   */
  const closeCurrent = async (): Promise<void> => {
    const current = server;
    if (!current) return;
    server = null;
    try {
      current.closeIdleConnections?.();
    } catch {
      // Some embedders provide only partial Server-compatible shims. A broken
      // idle-socket helper must not prevent the actual listener from closing.
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try {
          current.closeAllConnections?.();
        } catch {
          // The listener reference has already been retired; keep draining
          // the queue even if a non-standard force-close helper is broken.
        } finally {
          // Even a non-standard Server shim that throws here must not strand
          // the FIFO forever. The old listener reference is already retired.
          finish();
        }
      }, closeGraceMs);
      timer.unref?.();
      try {
        current.close(() => finish());
      } catch {
        // A listener that was closed externally is already safe to replace.
        finish();
      }
    });
  };

  const status = (): NetworkStatus => ({
    mode,
    targetMode,
    port,
    addresses: mode === "lan" ? localAddresses(readInterfaces) : [],
    error: lastError,
    pending: pendingOperations > 0,
    listening: server !== null,
  });

  /**
   * Every listener mutation uses this one FIFO. The rejection branch on the
   * tail is consumed so one unexpected failure cannot permanently poison all
   * later shutdown or recovery operations.
   */
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    pendingOperations += 1;
    const result = queue.then(operation, operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      pendingOperations -= 1;
      if (pendingOperations === 0) targetMode = mode;
    });
  };

  return {
    mode: (): NetworkMode => mode,
    server: (): Server | null => server,

    start(): Promise<Server> {
      if (terminal) {
        return Promise.reject(new Error("监听控制器已经关闭。"));
      }
      targetMode = mode;
      return enqueue(async () => {
        if (terminal) throw new Error("监听控制器已经关闭。");
        if (server) return server;
        const started = await listen(bindHostFor(mode), port);
        server = started;
        lastError = null;
        return started;
      });
    },

    /**
     * Rebinds in place. `0.0.0.0` is a strict superset of `127.0.0.1`, so the
     * operator's own tab survives the switch in both directions. On failure the
     * previous mode is restored and the reason surfaced through `status()`.
     */
    setMode(next: NetworkMode): Promise<NetworkStatus> {
      // `close()` is terminal. In particular, a response `finish` callback
      // that runs after SIGTERM must not enqueue a bind that outlives shutdown.
      if (terminal) return Promise.resolve(status());
      targetMode = next;
      return enqueue(async () => {
        if (terminal) return;
        if (next === mode && server) {
          lastError = null;
          return;
        }

        const previous = mode;
        await closeCurrent();
        if (terminal) return;
        try {
          const rebound = await listen(bindHostFor(next), port);
          server = rebound;
          mode = next;
          lastError = null;
        } catch (error) {
          const reason =
            error instanceof Error ? error.message : "切换监听地址失败。";
          if (terminal) {
            server = null;
            mode = previous;
            return;
          }
          try {
            const restored = await listen(bindHostFor(previous), port);
            server = restored;
            mode = previous;
            lastError = reason;
          } catch (restoreError) {
            // Both binds failed, so the process now has no listener at all.
            // Surface it rather than rejecting: this task is initiated after
            // the HTTP response finishes and must never become unhandled.
            server = null;
            mode = previous;
            lastError = `${reason}；恢复原监听也失败：${
              restoreError instanceof Error ? restoreError.message : "未知错误"
            }`;
          }
        }
      }).then(status);
    },

    status,

    close(): Promise<void> {
      if (closePromise) return closePromise;
      // Set before enqueueing so a later `setMode()` cannot get behind this
      // operation in the FIFO and resurrect the listener.
      terminal = true;
      targetMode = mode;
      closePromise = enqueue(closeCurrent);
      return closePromise;
    },
  };
};

export type NetworkController = ReturnType<typeof createNetworkController>;
