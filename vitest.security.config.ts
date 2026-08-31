import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/security/**/*.security.ts"],
    testTimeout: 15_000,
  },
});
