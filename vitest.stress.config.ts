import { defineConfig } from "vitest/config";

const requestedDuration = Number(process.env.STRESS_DURATION_MS ?? 2_000);
const stressTimeout = Math.max(
  30_000,
  Number.isFinite(requestedDuration) ? requestedDuration + 60_000 : 30_000,
);

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/stress/**/*.stress.ts"],
    testTimeout: stressTimeout,
    hookTimeout: 30_000,
  },
});
