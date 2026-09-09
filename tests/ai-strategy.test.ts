import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AI_DIFFICULTIES } from "../shared/contracts";
import {
  clearStrategyCache,
  MAX_STRATEGY_BYTES,
  strategyFor,
} from "../server/ai/strategy";

// Never point at the real `.local/strategies`: these tests delete the
// directory between cases, and an operator's tuned overrides live there.
const overrideRoot = mkdtempSync(path.join(tmpdir(), "mx-strategies-"));

const writeOverride = (name: string, content: string) => {
  mkdirSync(overrideRoot, { recursive: true });
  writeFileSync(path.join(overrideRoot, name), content, "utf8");
};

describe("难度策略文件", () => {
  beforeEach(() => {
    clearStrategyCache();
    process.env.MASKED_XIANGQI_STRATEGY_DIR = overrideRoot;
    rmSync(overrideRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(overrideRoot, { recursive: true, force: true });
    delete process.env.MASKED_XIANGQI_STRATEGY_DIR;
    clearStrategyCache();
  });

  it("每一档都有可用的内置文本", () => {
    for (const difficulty of AI_DIFFICULTIES) {
      const text = strategyFor(difficulty);
      expect(text.length).toBeGreaterThan(0);
      expect(text.length).toBeLessThanOrEqual(MAX_STRATEGY_BYTES);
    }
  });

  it("内置文本不包含会泄漏暗子身份的字面量", () => {
    // tests/security 和 tests/ollama 都以这两个字面量为门禁，策略文本一旦
    // 写进 JSON 示例就会同时打破两处断言。
    for (const difficulty of AI_DIFFICULTIES) {
      const text = strategyFor(difficulty);
      expect(text).not.toContain("trueIdentity");
      expect(text).not.toContain('"identity"');
    }
  });

  it("缺省难度回落到中等", () => {
    expect(strategyFor(null)).toBe(strategyFor("medium"));
    expect(strategyFor(undefined)).toBe(strategyFor("medium"));
  });

  it("存在本地覆盖时优先使用覆盖内容", () => {
    writeOverride("hard.md", "自定义困难策略");
    expect(strategyFor("hard")).toBe("自定义困难策略");
    // Other tiers keep the bundled text.
    expect(strategyFor("easy")).toContain("简单");
  });

  it("覆盖文件超过上限时回落到内置文本", () => {
    writeOverride("hard.md", "超".repeat(MAX_STRATEGY_BYTES));
    expect(strategyFor("hard")).toContain("困难");
  });

  it("覆盖文件是软链接时回落到内置文本", () => {
    mkdirSync(overrideRoot, { recursive: true });
    const outside = path.join(overrideRoot, "outside.md");
    writeFileSync(outside, "软链接内容", "utf8");
    symlinkSync(outside, path.join(overrideRoot, "hard.md"));
    expect(strategyFor("hard")).toContain("困难");
  });

  it("覆盖文件是命名管道时拒绝读取并回落到内置文本", () => {
    if (process.platform === "win32") return;
    mkdirSync(overrideRoot, { recursive: true });
    execFileSync("mkfifo", [path.join(overrideRoot, "hard.md")]);

    expect(strategyFor("hard")).toContain("困难");
  });

  it("空的覆盖文件回落到内置文本，不会把提示清空", () => {
    writeOverride("hard.md", "   \n  ");
    expect(strategyFor("hard")).toContain("困难");
  });
});
