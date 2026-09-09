import type { InlineConfig } from "vite";
import { LOOPBACK_BIND_HOST } from "./network";

/** Vite uses this port for its standalone middleware-mode HMR listener. */
export const DEV_HMR_PORT = 24_678;

/**
 * Development-only Vite configuration shared by the listener and tests.
 *
 * The HTTP application follows the runtime loopback/LAN switch, but HMR is a
 * separate listener that Vite creates once at process startup. Binding that
 * socket to LAN would leave it reachable after the application switches back
 * to loopback, so it deliberately stays host-only in every startup mode.
 */
export const DEV_VITE_CONFIG = {
  appType: "spa",
  server: {
    middlewareMode: true,
    fs: {
      // A dev middleware serves the project tree. In LAN mode that tree is
      // reachable from every device on the network, so retain Vite's sensitive
      // defaults and add the directory containing Agent credentials and logs.
      deny: [
        "**/.local/**",
        "**/.env",
        "**/.env.*",
        "**/*.{crt,pem}",
        "**/.git/**",
      ],
    },
    hmr: {
      host: LOOPBACK_BIND_HOST,
      port: DEV_HMR_PORT,
    },
  },
} satisfies InlineConfig;
