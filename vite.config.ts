import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // `npm run dev` does not start a standalone Vite server: server/index.ts
  // loads Vite in middleware mode and mounts it on the Express listener, so
  // the page and the API always share one origin. These entries only apply to
  // a bare `vite` / `vite preview` invocation.
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
  },
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      thresholds: {
        statements: 85,
        lines: 85,
        functions: 85,
        branches: 80,
      },
      exclude: [
        "dist/**",
        "tests/**",
        "scripts/**",
        "*.config.{js,mjs,ts}",
        "server/index.ts",
        "server/agent/cli.ts",
        "src/main.tsx",
        "vite.config.ts",
      ],
    },
  },
});
