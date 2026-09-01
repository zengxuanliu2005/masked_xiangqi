import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LanRoomError,
  LanRoomManager,
  normalizeRoomCode,
  type LanRoomManagerOptions,
} from "../server/lan/room-manager";
import type { PublicGameState } from "../shared/contracts";

/** turn defaults to red, so the ply that could be taken back is black's. */
const gameAt = (revision: number, overrides: Partial<PublicGameState> = {}) =>
  ({
    revision,
    turn: "red",
    status: { phase: "active", winner: null, reason: null },
    ...overrides,
  }) as PublicGameState;

/** Deterministic clock + credentials so every assertion is exact. */
const buildManager = (options: LanRoomManagerOptions = {}) => {
  let clock = 1_000;
  let tokenSeq = 0;
  let codeSeq = 0;
  let undoSeq = 0;
  const manager = new LanRoomManager({
    now: () => new Date(clock),
    tokenFactory: () => `token-${(tokenSeq += 1)}`,
    codeFactory: () => `CODE${String((codeSeq += 1)).padStart(2, "0")}`,
    undoRequestIdFactory: () => `undo-${(undoSeq += 1)}`,
    ...options,
  });
  return {
    manager,
    advance: (ms: number) => {
      clock += ms;
    },
  };
};

describe("局域网房间码", () => {
  it("归一化输入，容忍空格、连字符与小写", () => {
    expect(normalizeRoomCode(" ab-c 23 ")).toBe("ABC23");
  });

  it("默认房间码使用无歧义字母表且长度为 6", () => {
    const manager = new LanRoomManager({ maxRooms: 500 });
    const seen = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      const { roomCode } = manager.create(`game-${index}`, "red");
      expect(roomCode).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
      seen.add(roomCode);
    }
    expect(seen.size).toBe(200);
  });
});

describe("座位认领", () => {
  let harness: ReturnType<typeof buildManager>;

  beforeEach(() => {
    harness = buildManager();
  });

  it("建房时房主入座，客人座位保持空缺", () => {
    const { manager } = harness;
    const host = manager.create("g1", "red");
    expect(host).toMatchObject({ gameId: "g1", color: "red" });
    expect(manager.bothSeatsClaimed("g1")).toBe(false);
    expect(() => manager.assertReady("g1")).toThrow(LanRoomError);
  });

  it("兑换房间码拿到对面颜色的座位", () => {
    const { manager } = harness;
    const host = manager.create("g1", "red");
    const guest = manager.join(host.roomCode);
    expect(guest).toMatchObject({ gameId: "g1", color: "black" });
    expect(guest.token).not.toBe(host.token);
    expect(manager.bothSeatsClaimed("g1")).toBe(true);
    expect(() => manager.assertReady("g1")).not.toThrow();
  });

  it("同一个房间码不会被兑换两次", () => {
    const { manager } = harness;
    const host = manager.create("g1", "red");
    manager.join(host.roomCode);
    expect(() => manager.join(host.roomCode)).toThrow(
      expect.objectContaining({ code: "LAN_ROOM_FULL" }),
    );
  });

  it("令牌只认自己的座位，且明文不落在任何投影里", () => {
    const { manager } = harness;
    const host = manager.create("g1", "black");
    const guest = manager.join(host.roomCode);

    expect(manager.authenticate("g1", host.token)).toBe("black");
    expect(manager.authenticate("g1", guest.token)).toBe("red");
    expect(() => manager.authenticate("g1", "token-nope")).toThrow(
      expect.objectContaining({ code: "LAN_SEAT_TOKEN_INVALID" }),
    );

    const projection = manager.project("g1", gameAt(0), "black");
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain(host.token);
    expect(serialized).not.toContain(guest.token);
  });

  it("房间码只投影给房主", () => {
    const { manager } = harness;
    const host = manager.create("g1", "red");
    manager.join(host.roomCode);

    expect(manager.project("g1", gameAt(0), "red")?.roomCode).toBe(
      host.roomCode,
    );
    expect(manager.project("g1", gameAt(0), "black")?.roomCode).toBeUndefined();
    expect(manager.project("g1", gameAt(0), null)?.roomCode).toBeUndefined();
  });

  it("只有猜错房间码才计入限流", () => {
    const { manager } = buildManager({ maxFailedJoinsPerWindow: 3 });
    for (let index = 0; index < 3; index += 1) {
      expect(() => manager.join("ZZZZZZ", "device-a")).toThrow(
        expect.objectContaining({ code: "LAN_ROOM_NOT_FOUND" }),
      );
    }
    expect(() => manager.join("ZZZZZZ", "device-a")).toThrow(
      expect.objectContaining({ code: "LAN_JOIN_THROTTLED" }),
    );
  });

  it("限流按来源隔离，一个人手滑不会封住全家", () => {
    const { manager } = buildManager({ maxFailedJoinsPerWindow: 2 });
    const host = manager.create("g1", "red");
    // A 设备把码敲错到被限流。
    expect(() => manager.join("ZZZZZZ", "device-a")).toThrow();
    expect(() => manager.join("ZZZZZZ", "device-a")).toThrow();
    expect(() => manager.join("ZZZZZZ", "device-a")).toThrow(
      expect.objectContaining({ code: "LAN_JOIN_THROTTLED" }),
    );
    // B 设备用正确的码仍然进得来。
    expect(manager.join(host.roomCode, "device-b").color).toBe("black");
  });

  it("任意伪造令牌不会暴露座位是否空着", () => {
    const { manager } = buildManager();
    const host = manager.create("g1", "red");
    // 客人座位空着时，随便一个令牌也只能得到「无效」，
    // 否则这就成了一个不需要凭据的座位占用探测器。
    expect(() => manager.authenticate("g1", "garbage")).toThrow(
      expect.objectContaining({ code: "LAN_SEAT_TOKEN_INVALID" }),
    );
    const guest = manager.join(host.roomCode);
    expect(() => manager.authenticate("g1", "garbage")).toThrow(
      expect.objectContaining({ code: "LAN_SEAT_TOKEN_INVALID" }),
    );
    // 只有真正被作废的那个令牌才会被告知「已被移出」。
    manager.reinvite("g1", "red", host.roomCode);
    expect(() => manager.authenticate("g1", guest.token)).toThrow(
      expect.objectContaining({ code: "LAN_SEAT_REVOKED" }),
    );
    expect(() => manager.authenticate("g1", "garbage")).toThrow(
      expect.objectContaining({ code: "LAN_SEAT_TOKEN_INVALID" }),
    );
  });

  it("已满或已作废的房间码属于用户失误，不会把全家人锁在门外", () => {
    const { manager } = buildManager({ maxFailedJoinsPerWindow: 2 });
    const host = manager.create("g1", "red");
    manager.join(host.roomCode);

    // 反复用同一个已满的码重试，是常见的「再粘一次」而不是暴力猜测。
    for (let index = 0; index < 5; index += 1) {
      expect(() => manager.join(host.roomCode)).toThrow(
        expect.objectContaining({ code: "LAN_ROOM_FULL" }),
      );
    }
    // 另一台设备用正确的新码仍然可以加入。
    const second = manager.create("g2", "red");
    expect(() => manager.join(second.roomCode)).not.toThrow();
  });

  it("对局被清理后房间随之消失", () => {
    const live = new Set(["g1"]);
    const { manager } = buildManager({ hasGame: (id) => live.has(id) });
    manager.create("g1", "red");
    expect(manager.has("g1")).toBe(true);
    live.delete("g1");
    expect(manager.has("g1")).toBe(false);
    expect(manager.size).toBe(0);
  });

  it("旧房间清理不会删除后来复用该码的新房间索引", () => {
    const live = new Set(["old-game"]);
    const { manager, advance } = buildManager({
      hasGame: (id) => live.has(id),
      codeFactory: () => "ABC234",
      revokedCodeTtlMs: 10,
    });
    const oldRoom = manager.create("old-game", "red");
    manager.finish("old-game");

    advance(11);
    live.add("new-game");
    const newRoom = manager.create("new-game", "red");
    expect(newRoom.roomCode).toBe(oldRoom.roomCode);

    live.delete("old-game");
    expect(manager.join(newRoom.roomCode)).toMatchObject({
      gameId: "new-game",
      color: "black",
    });
  });

  it("房间数量有上限", () => {
    const { manager } = buildManager({ maxRooms: 2 });
    manager.create("g1", "red");
    manager.create("g2", "red");
    expect(() => manager.create("g3", "red")).toThrow(
      expect.objectContaining({ code: "CAPACITY_EXCEEDED" }),
    );
  });

  it("一次房间清理只批量扫描一次底层对局存储", () => {
    const existingGames = vi.fn((ids: readonly string[]) => new Set(ids));
    const { manager } = buildManager({ existingGames, maxRooms: 128 });
    const hosts = Array.from({ length: 128 }, (_, index) =>
      manager.create(`g-${index}`, "red"),
    );
    existingGames.mockClear();

    expect(manager.authenticate("g-0", hosts[0].token)).toBe("red");
    expect(existingGames).toHaveBeenCalledTimes(1);
    expect(existingGames.mock.calls[0][0]).toHaveLength(128);
  });

  it("已结束的对局不占用房间名额", () => {
    const { manager } = buildManager({ maxRooms: 2 });
    manager.create("g1", "red");
    manager.create("g2", "red");
    // 对局要在 GameStore 里留存一小时，期间房间记录还在，但它不是活动房间，
    // 不应该把新对局挡在门外。
    manager.finish("g1");
    expect(() => manager.create("g3", "red")).not.toThrow();
  });

  it("容量检查可以单独调用，便于建局前先确认", () => {
    const { manager } = buildManager({ maxRooms: 1 });
    manager.create("g1", "red");
    expect(() => manager.assertCapacity()).toThrow(
      expect.objectContaining({ code: "CAPACITY_EXCEEDED" }),
    );
  });
});

describe("在线状态", () => {
  it("心跳新鲜时为在线，超过阈值转为离线", () => {
    const { manager, advance } = buildManager({ presenceStaleMs: 10_000 });
    const host = manager.create("g1", "red");
    manager.join(host.roomCode);

    expect(manager.project("g1", gameAt(0), "red")?.seats.black.online).toBe(
      true,
    );

    advance(10_001);
    const stale = manager.project("g1", gameAt(0), "red");
    expect(stale?.seats.black).toEqual({ claimed: true, online: false });

    manager.heartbeat("g1", "black");
    expect(manager.project("g1", gameAt(0), "red")?.seats.black.online).toBe(
      true,
    );
  });

  it("不下发原始心跳时间戳", () => {
    const { manager } = buildManager();
    const host = manager.create("g1", "red");
    manager.join(host.roomCode);
    const serialized = JSON.stringify(manager.project("g1", gameAt(0), "red"));
    expect(serialized).not.toContain("lastSeenAt");
  });
});

describe("重新邀请", () => {
  it("作废客人座位并签发新房间码，旧码不可再用", () => {
    const { manager } = buildManager();
    const host = manager.create("g1", "red");
    const guest = manager.join(host.roomCode);
    const oldCode = host.roomCode;

    const newCode = manager.reinvite("g1", "red", oldCode);
    expect(newCode).not.toBe(oldCode);
    expect(manager.bothSeatsClaimed("g1")).toBe(false);

    // 旧码明确报「已失效」，而不是含糊的「找不到」。
    expect(() => manager.join(oldCode)).toThrow(
      expect.objectContaining({ code: "LAN_CODE_REVOKED" }),
    );
    // 被移出的设备拿到的是可识别的 SEAT_REVOKED。
    expect(() => manager.authenticate("g1", guest.token)).toThrow(
      expect.objectContaining({ code: "LAN_SEAT_REVOKED" }),
    );

    const rejoined = manager.join(newCode);
    expect(rejoined.color).toBe("black");
    expect(rejoined.token).not.toBe(guest.token);
  });

  it("只有房主可以重新邀请", () => {
    const { manager } = buildManager();
    const host = manager.create("g1", "red");
    manager.join(host.roomCode);
    expect(() => manager.reinvite("g1", "black", host.roomCode)).toThrow(
      expect.objectContaining({ code: "LAN_NOT_YOUR_SEAT" }),
    );
  });

  it("延迟或重复的旧重邀请求不能旋转新房间码或撤销新座位", () => {
    const { manager } = buildManager();
    const host = manager.create("g1", "red");
    manager.join(host.roomCode);
    const nextCode = manager.reinvite("g1", "red", host.roomCode);
    const replacement = manager.join(nextCode);

    expect(() => manager.reinvite("g1", "red", host.roomCode)).toThrow(
      expect.objectContaining({ code: "LAN_INVITE_STALE" }),
    );
    expect(manager.authenticate("g1", replacement.token)).toBe("black");
    expect(manager.project("g1", gameAt(0), "red")?.roomCode).toBe(nextCode);
  });
});

describe("悔棋协商", () => {
  const ready = () => {
    const harness = buildManager();
    const host = harness.manager.create("g1", "red");
    harness.manager.join(host.roomCode);
    return harness;
  };

  it("对手同意才真正撤回", () => {
    const { manager } = ready();
    // gameAt(4) 的 turn 是 red，所以刚走完的是 black，只有 black 能悔。
    const requestId = manager.requestUndo("g1", "black", gameAt(4));
    expect(manager.project("g1", gameAt(4), "red")?.undoRequest).toMatchObject({
      requestedBy: "black",
      atRevision: 4,
    });
    expect(manager.resolveUndo("g1", "red", requestId, true, gameAt(4))).toBe(
      true,
    );
    expect(manager.project("g1", gameAt(4), "red")?.undoRequest).toBeNull();
  });

  it("对手拒绝则不撤回", () => {
    const { manager } = ready();
    const requestId = manager.requestUndo("g1", "black", gameAt(4));
    expect(manager.resolveUndo("g1", "red", requestId, false, gameAt(4))).toBe(
      false,
    );
  });

  it("没走过棋的一方不能请求悔棋", () => {
    const { manager } = ready();
    // gameAt(4).turn === "red"，红方还没走，最后一步是黑方的。
    expect(() => manager.requestUndo("g1", "red", gameAt(4))).toThrow(
      expect.objectContaining({ code: "LAN_NOT_YOUR_SEAT" }),
    );
  });

  it("请求方可以撤回自己的请求，但不能自批", () => {
    const { manager } = ready();
    const requestId = manager.requestUndo("g1", "black", gameAt(4));
    expect(() =>
      manager.resolveUndo("g1", "black", requestId, true, gameAt(4)),
    ).toThrow(expect.objectContaining({ code: "LAN_CANNOT_SELF_APPROVE" }));
    expect(
      manager.resolveUndo("g1", "black", requestId, false, gameAt(4)),
    ).toBe(false);
  });

  it("对手先落子会让请求失效，双方界面同时消失", () => {
    const { manager } = ready();
    const requestId = manager.requestUndo("g1", "black", gameAt(4));
    // revision 前进即代表局面已变，请求自动作废。
    expect(manager.project("g1", gameAt(5), "red")?.undoRequest).toBeNull();
    expect(() =>
      manager.resolveUndo("g1", "red", requestId, true, gameAt(5)),
    ).toThrow(expect.objectContaining({ code: "LAN_UNDO_REQUEST_NOT_FOUND" }));
  });

  it("超时后请求失效，请求方掉线不会卡住对局", () => {
    const harness = buildManager({ undoRequestTtlMs: 30_000 });
    const host = harness.manager.create("g1", "red");
    harness.manager.join(host.roomCode);
    harness.manager.requestUndo("g1", "black", gameAt(4));

    harness.advance(30_001);
    expect(
      harness.manager.project("g1", gameAt(4), "red")?.undoRequest,
    ).toBeNull();
    // 失效之后可以重新发起，不需要任何一方在线。
    expect(() =>
      harness.manager.requestUndo("g1", "black", gameAt(4)),
    ).not.toThrow();
  });

  it("终局会清掉请求，但保留双方座位身份", () => {
    const { manager } = ready();
    manager.requestUndo("g1", "black", gameAt(4));
    const finished = gameAt(4, {
      status: { phase: "finished", winner: "red", reason: "resignation" },
    });
    expect(manager.project("g1", finished, "black")?.undoRequest).toBeNull();

    manager.finish("g1");
    // 终局不等于被踢出：座位必须仍然算「已认领」，否则结算页会把双方
    // 都显示成「你已被移出对局」。
    expect(manager.bothSeatsClaimed("g1")).toBe(true);
  });

  it("同一时刻只允许一个待处理请求", () => {
    const { manager } = ready();
    manager.requestUndo("g1", "black", gameAt(4));
    expect(() => manager.requestUndo("g1", "black", gameAt(4))).toThrow(
      expect.objectContaining({ code: "LAN_UNDO_REQUEST_EXISTS" }),
    );
  });

  it("旧请求的延迟响应不能处理同 revision 的后续请求", () => {
    const { manager } = ready();
    const firstId = manager.requestUndo("g1", "black", gameAt(4));
    expect(manager.resolveUndo("g1", "red", firstId, false, gameAt(4))).toBe(
      false,
    );

    const secondId = manager.requestUndo("g1", "black", gameAt(4));
    expect(secondId).not.toBe(firstId);
    expect(() =>
      manager.resolveUndo("g1", "red", firstId, true, gameAt(4)),
    ).toThrow(expect.objectContaining({ code: "LAN_UNDO_REQUEST_NOT_FOUND" }));
    expect(manager.project("g1", gameAt(4), "red")?.undoRequest?.id).toBe(
      secondId,
    );
    expect(manager.resolveUndo("g1", "red", secondId, false, gameAt(4))).toBe(
      false,
    );
  });

  it("终局后不能再发起悔棋请求", () => {
    const { manager } = ready();
    const finished = gameAt(4, {
      status: { phase: "finished", winner: "red", reason: "checkmate" },
    });
    // 否则请求会被接受，然后被下一次投影静默丢弃——两边都以为没反应。
    expect(() => manager.requestUndo("g1", "black", finished)).toThrow(
      expect.objectContaining({ code: "LAN_UNDO_REQUEST_NOT_FOUND" }),
    );
  });

  it("对手未入座时不能发起悔棋", () => {
    const { manager } = buildManager();
    manager.create("g1", "red");
    expect(() => manager.requestUndo("g1", "black", gameAt(1))).toThrow(
      expect.objectContaining({ code: "LAN_WAITING_FOR_OPPONENT" }),
    );
  });
});
