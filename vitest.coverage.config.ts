import { mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default mergeConfig(viteConfig, {
  test: {
    include: [
      "tests/**/*.test.{ts,tsx}",
      "tests/security/**/*.security.ts",
      "tests/stress/**/*.stress.ts",
    ],
  },
});
