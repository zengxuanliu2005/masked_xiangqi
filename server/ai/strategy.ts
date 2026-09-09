import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_AI_DIFFICULTY,
  type AiDifficulty,
} from "../../shared/contracts";

/**
 * Per-difficulty strategy prose injected into the Ollama prompt.
 *
 * The bundled files under `server/ai/strategies/` are the source of truth and
 * are what the tests assert against. `.local/strategies/<tier>.md` overrides
 * one tier so the prompt can be tuned without editing the repository. A
 * missing, non-regular, oversized, or unreadable override always falls back
 * to the bundled text: a broken strategy file must never stop a game from
 * starting.
 *
 * The text is server-side only. It is never projected to the browser, and it
 * must never contain anything derived from a covered piece's server-only true
 * identity.
 */

/** Generous for prose, small enough that the per-move prompt stays cheap. */
export const MAX_STRATEGY_BYTES = 8 * 1024;

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const bundledRoot = path.join(moduleDirectory, "strategies");
/**
 * Resolved per call, not at module load: tests point this at a scratch
 * directory so a run can never touch an operator's real `.local` overrides.
 */
const overrideRoot = () =>
  process.env.MASKED_XIANGQI_STRATEGY_DIR ??
  path.resolve(process.cwd(), ".local", "strategies");

const cache = new Map<AiDifficulty, string>();

/** Reject anything that escapes the override directory or passes a symlink. */
const readContainedFile = (root: string, difficulty: AiDifficulty): string => {
  const resolved = path.resolve(root, `${difficulty}.md`);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("策略文件必须位于指定目录内。");
  }
  const stats = lstatSync(resolved);
  if (stats.isSymbolicLink()) {
    throw new Error("策略文件不能是软链接。");
  }
  if (!stats.isFile()) {
    throw new Error("策略文件必须是普通文件。");
  }
  if (stats.size > MAX_STRATEGY_BYTES) {
    throw new Error("策略文件超过 8 KiB 限制。");
  }
  return readFileSync(resolved, "utf8").trim();
};

const loadStrategy = (difficulty: AiDifficulty): string => {
  for (const root of [overrideRoot(), bundledRoot]) {
    try {
      const text = readContainedFile(root, difficulty);
      if (text) return text;
    } catch {
      // Unusable at this location; try the next one.
    }
  }
  // Even a missing bundled file only costs the prompt its strategy prose. It
  // must never turn into a failed move.
  return "";
};

export const strategyFor = (
  difficulty: AiDifficulty | null | undefined,
): string => {
  const tier = difficulty ?? DEFAULT_AI_DIFFICULTY;
  const cached = cache.get(tier);
  if (cached !== undefined) return cached;
  const text = loadStrategy(tier);
  cache.set(tier, text);
  return text;
};

/** Test seam: the cache is process-wide and would outlive a fixture. */
export const clearStrategyCache = (): void => {
  cache.clear();
};
