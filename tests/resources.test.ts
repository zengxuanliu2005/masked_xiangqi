import {
  access,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GameStore, GameStoreCapacityError } from "../engine/store";
import { JsonlAgentLogger } from "../server/agent/jsonl";

const createOptions = {
  mode: "capture-general" as const,
  player1Side: "red" as const,
  matchType: "human-human" as const,
};

describe("GameStore 生命周期与容量", () => {
  it("容量满时拒绝新局，并在 TTL 到期后优先回收结束局和闲置活动局", () => {
    let now = new Date("2026-08-31T00:00:00.000Z");
    const store = new GameStore({
      maxGames: 2,
      finishedRetentionMs: 60 * 60 * 1_000,
      activeIdleMs: 24 * 60 * 60 * 1_000,
      now: () => now,
    });
    const finished = store.create(createOptions);
    const active = store.create(createOptions);

    expect(() => store.create(createOptions)).toThrow(GameStoreCapacityError);
    finished.status = {
      phase: "finished",
      winner: "red",
      reason: "resignation",
    };
    finished.finishedAt = now.toISOString();
    now = new Date(now.getTime() + 60 * 60 * 1_000 + 1);

    const afterFinishedExpiry = store.create(createOptions);
    expect(store.get(finished.id)).toBeUndefined();
    expect(store.get(active.id)).toBeDefined();
    expect(store.get(afterFinishedExpiry.id)).toBeDefined();

    now = new Date(now.getTime() + 24 * 60 * 60 * 1_000 + 1);
    const afterIdleExpiry = store.create(createOptions);
    expect(store.size).toBe(1);
    expect(store.get(afterIdleExpiry.id)).toBeDefined();
  });

  it("读取会刷新闲置时间，clear 会释放全部局面", () => {
    let now = new Date("2026-08-31T00:00:00.000Z");
    const store = new GameStore({
      maxGames: 2,
      activeIdleMs: 1_000,
      now: () => now,
    });
    const game = store.create(createOptions);
    now = new Date("2026-08-31T00:00:00.750Z");
    expect(store.get(game.id)?.lastAccessedAt).toBe(now.toISOString());
    now = new Date("2026-08-31T00:00:01.500Z");
    store.create(createOptions);
    expect(store.get(game.id)).toBeDefined();
    store.clear();
    expect(store.size).toBe(0);
  });

  it("has 会先回收过期对局，但不会把容量扫描当成访问", () => {
    let now = new Date("2026-08-31T00:00:00.000Z");
    const store = new GameStore({
      maxGames: 1,
      activeIdleMs: 1_000,
      now: () => now,
    });
    const game = store.create(createOptions);
    const originalAccess = game.lastAccessedAt;

    now = new Date("2026-08-31T00:00:00.750Z");
    expect(store.has(game.id)).toBe(true);
    expect(game.lastAccessedAt).toBe(originalAccess);
    expect(store.existing([game.id, "missing"])).toEqual(new Set([game.id]));
    expect(game.lastAccessedAt).toBe(originalAccess);

    now = new Date("2026-08-31T00:00:01.001Z");
    expect(store.has(game.id)).toBe(false);
    expect(store.size).toBe(0);
    expect(() => store.create(createOptions)).not.toThrow();
  });
});

describe("Agent JSONL 日志生命周期", () => {
  it("首次写入删除 7 天前日志并保持逐行 JSON", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "masked-log-ttl-"));
    try {
      const oldLog = path.join(directory, "old.jsonl");
      const oldRotation = path.join(directory, "old.jsonl.1");
      await writeFile(oldLog, "old\n");
      await writeFile(oldRotation, "old rotation\n");
      const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000);
      await utimes(oldLog, oldTime, oldTime);
      await utimes(oldRotation, oldTime, oldTime);

      const current = path.join(directory, "current.jsonl");
      await new JsonlAgentLogger(current).write({
        timestamp: "2026-08-31T00:00:00.000Z",
        event: "started",
        ordinaryText: "thinking 与 final 均保留",
      });

      await expect(access(oldLog)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(oldRotation)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(JSON.parse((await readFile(current, "utf8")).trim())).toEqual({
        timestamp: "2026-08-31T00:00:00.000Z",
        event: "started",
        ordinaryText: "thinking 与 final 均保留",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("拒绝把日志写入软链接", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "masked-log-symlink-"));
    try {
      const target = path.join(directory, "target.txt");
      const log = path.join(directory, "game.jsonl");
      await writeFile(target, "must stay unchanged");
      await symlink(target, log);

      await expect(
        new JsonlAgentLogger(log).write({
          timestamp: "2026-08-31T00:00:00.000Z",
          event: "unsafe",
        }),
      ).rejects.toThrow("不能写入软链接");
      expect(await readFile(target, "utf8")).toBe("must stay unchanged");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
