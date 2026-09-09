import { describe, expect, it } from "vitest";
import { DEV_HMR_PORT, DEV_VITE_CONFIG } from "../server/dev-vite";
import { LAN_BIND_HOST, LOOPBACK_BIND_HOST } from "../server/network";

describe("开发服务器的 Vite 边界", () => {
  it("独立 HMR listener 始终只绑定回环地址", () => {
    // The application listener may switch to LAN and back at runtime, while
    // Vite creates this separate socket only once. It must therefore never
    // inherit the startup mode or it would remain exposed after LAN is off.
    expect(DEV_VITE_CONFIG.server.hmr).toEqual({
      host: LOOPBACK_BIND_HOST,
      port: DEV_HMR_PORT,
    });
    expect(DEV_VITE_CONFIG.server.hmr.host).not.toBe(LAN_BIND_HOST);
  });

  it("开发文件服务保留敏感路径拒绝列表", () => {
    expect(DEV_VITE_CONFIG.server.fs.deny).toEqual(
      expect.arrayContaining([
        "**/.local/**",
        "**/.env",
        "**/.env.*",
        "**/.git/**",
      ]),
    );
  });
});
