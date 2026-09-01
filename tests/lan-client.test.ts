// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import {
  LAN_SEAT_STORAGE_KEY,
  LAN_SEAT_TOMBSTONE_PREFIX,
  clearSeatRecord,
  isMySeatTurn,
  isOpponentOnline,
  isSeatRevoked,
  isWaitingForOpponent,
  joinUrlFor,
  latestSeatRecord,
  lanStateChanged,
  normalizeRoomCodeInput,
  readSeatRecord,
  sameSeatCredential,
  seatColorFor,
  takeRoomCodeFromLocation,
  writeSeatRecord,
} from "../src/lan";
import type { LanRoomState, PublicGameState } from "../shared/contracts";

const room = (overrides: Partial<LanRoomState> = {}): LanRoomState => ({
  host: "red",
  seats: {
    red: { claimed: true, online: true },
    black: { claimed: true, online: true },
  },
  undoRequest: null,
  ...overrides,
});

const lanGame = (overrides: Partial<PublicGameState> = {}): PublicGameState =>
  ({
    id: "game-1",
    matchType: "lan-human",
    revision: 3,
    turn: "red",
    lan: room(),
    ...overrides,
  }) as PublicGameState;

/**
 * This environment exposes Node's experimental `localStorage` stub, whose
 * methods are absent (which is why other suites call `removeItem?.()`).
 * Install a real in-memory store so the seat-record logic is actually
 * exercised; `src/lan.ts` guards every access for the environments that
 * genuinely deny storage.
 */
let store: Map<string, string>;

beforeEach(() => {
  store = new Map();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      get length() {
        return store.size;
      },
      key: (index: number) => [...store.keys()][index] ?? null,
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
    },
  });
});

afterEach(() => {
  store.clear();
});

describe("座位记录存储", () => {
  it("独立于旧的 last-game-id，读写与清除都自洽", () => {
    expect(readSeatRecord()).toBeNull();
    writeSeatRecord({ gameId: "game-1", color: "black", token: "t" });
    expect(readSeatRecord()).toMatchObject({
      gameId: "game-1",
      color: "black",
      token: "t",
    });
    // 指定不同对局时不会串座位。
    expect(readSeatRecord("other")).toBeNull();
    clearSeatRecord();
    expect(readSeatRecord()).toBeNull();
  });

  it("忽略损坏或旧格式的记录，不抛异常", () => {
    window.localStorage.setItem(LAN_SEAT_STORAGE_KEY, "not-json");
    expect(readSeatRecord()).toBeNull();
    // 旧版本写下的裸字符串不会被误当成座位。
    window.localStorage.setItem(LAN_SEAT_STORAGE_KEY, '"game-1"');
    expect(readSeatRecord()).toBeNull();
    window.localStorage.setItem(LAN_SEAT_STORAGE_KEY, '{"gameId":"g"}');
    expect(readSeatRecord()).toBeNull();
  });

  it("用签发时间协调跨标签页记录，且不会条件清除较新的座位", () => {
    const stale = {
      gameId: "old-game",
      color: "red" as const,
      token: "old-token",
      savedAt: "2026-09-01T00:00:00.000Z",
    };
    const latest = {
      gameId: "new-game",
      color: "black" as const,
      token: "new-token",
      savedAt: "2026-09-01T00:01:00.000Z",
    };
    const storedLatest = writeSeatRecord(latest);

    expect(latestSeatRecord(stale, readSeatRecord())).toEqual(storedLatest);
    expect(sameSeatCredential(stale, latest)).toBe(false);
    expect(clearSeatRecord(stale)).toBe(false);
    expect(readSeatRecord()).toEqual(storedLatest);
    expect(clearSeatRecord(storedLatest)).toBe(true);
    expect(readSeatRecord()).toBeNull();
  });

  it("清理凭据时不会删除并发签发的旧版共享记录", () => {
    const stale = writeSeatRecord({
      gameId: "old-game",
      color: "red",
      token: "old-token",
      savedAt: "2026-09-01T00:00:00.000Z",
    });
    const setItem = window.localStorage.setItem.bind(window.localStorage);
    let injected = false;
    window.localStorage.setItem = (key: string, value: string) => {
      setItem(key, value);
      if (key.startsWith(LAN_SEAT_TOMBSTONE_PREFIX) && !injected) {
        injected = true;
        // A v1.0 tab can only write this shared pointer; it has no immutable
        // slot for the new one-time token.
        setItem(
          LAN_SEAT_STORAGE_KEY,
          JSON.stringify({
            gameId: "new-game",
            color: "black",
            token: "new-token",
            savedAt: "2026-09-01T00:01:00.000Z",
          }),
        );
      }
    };

    expect(clearSeatRecord(stale)).toBe(false);
    expect(readSeatRecord()).toMatchObject({
      gameId: "new-game",
      token: "new-token",
    });
  });

  it("系统时钟回拨后仍由单调代次选中新签发座位", () => {
    const old = writeSeatRecord({
      gameId: "future-old-game",
      color: "red",
      token: "future-old-token",
      savedAt: "2030-01-01T00:00:00.000Z",
      generation: 8,
    });
    expect(clearSeatRecord(old)).toBe(true);

    const current = writeSeatRecord({
      gameId: "clock-rollback-game",
      color: "black",
      token: "clock-rollback-token",
      savedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(current.generation).toBe(9);
    expect(readSeatRecord()).toEqual(current);
  });

  it("清除提升的旧版凭据后由墓碑保留其逻辑代次", () => {
    window.localStorage.setItem(
      LAN_SEAT_STORAGE_KEY,
      JSON.stringify({
        gameId: "legacy-future-game",
        color: "red",
        token: "legacy-future-token",
        savedAt: "2030-01-01T00:00:00.000Z",
      }),
    );
    const promoted = readSeatRecord();
    expect(promoted).toMatchObject({
      gameId: "legacy-future-game",
      generation: 1,
    });
    expect(clearSeatRecord(promoted!)).toBe(true);

    const current = writeSeatRecord({
      gameId: "post-legacy-game",
      color: "black",
      token: "post-legacy-token",
      savedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(current.generation).toBe(2);
    expect(latestSeatRecord(promoted, readSeatRecord())).toEqual(current);
  });

  it("提升凭据的较新墓碑不会暴露旧版标签页遗留的旧槽", () => {
    const staleSlot = writeSeatRecord({
      gameId: "stale-slot-game",
      color: "red",
      token: "stale-slot-token",
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    // v1.0 can end only the shared pointer, leaving v1.1's slot behind, then
    // mint a new seat into that pointer alone.
    window.localStorage.removeItem(LAN_SEAT_STORAGE_KEY);
    window.localStorage.setItem(
      LAN_SEAT_STORAGE_KEY,
      JSON.stringify({
        gameId: "legacy-later-game",
        color: "black",
        token: "legacy-later-token",
        savedAt: "2026-01-02T00:00:00.000Z",
      }),
    );
    const promoted = readSeatRecord();
    expect(promoted).toMatchObject({
      gameId: "legacy-later-game",
      generation: 2,
    });

    expect(clearSeatRecord(promoted!)).toBe(true);
    expect(readSeatRecord()).toBeNull();
    expect(staleSlot.generation).toBe(1);
  });

  it("升级期间仍采用旧版标签页后来签发的无代次凭据", () => {
    const modern = writeSeatRecord({
      gameId: "modern-old-game",
      color: "red",
      token: "modern-old-token",
      savedAt: "2030-01-01T00:00:00.000Z",
      generation: 4,
    });
    expect(clearSeatRecord(modern)).toBe(true);

    // A still-open v1.0 tab knows only the shared key and can write after the
    // v1.1 slot was cleared. Its clock may also have moved backwards.
    window.localStorage.setItem(
      LAN_SEAT_STORAGE_KEY,
      JSON.stringify({
        gameId: "legacy-new-game",
        color: "black",
        token: "legacy-new-token",
        savedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    expect(readSeatRecord()).toMatchObject({
      gameId: "legacy-new-game",
      token: "legacy-new-token",
      generation: 5,
    });
  });

  it("墓碑因存储配额失败时保留仍可恢复的凭据", () => {
    const record = writeSeatRecord({
      gameId: "quota-game",
      color: "red",
      token: "quota-token",
    });
    const setItem = window.localStorage.setItem.bind(window.localStorage);
    window.localStorage.setItem = (key: string, value: string) => {
      if (key.startsWith(LAN_SEAT_TOMBSTONE_PREFIX)) {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      setItem(key, value);
    };

    expect(clearSeatRecord(record)).toBe(false);
    expect(readSeatRecord()).toEqual(record);
  });
});

describe("座位视角与门控", () => {
  it("只有持有对应座位才被认作己方", () => {
    const game = lanGame();
    const seat = {
      gameId: "game-1",
      color: "black" as const,
      token: "t",
      savedAt: "",
    };
    expect(seatColorFor(game, seat)).toBe("black");
    expect(seatColorFor(game, { ...seat, gameId: "other" })).toBeNull();
    expect(seatColorFor(game, null)).toBeNull();
  });

  it("非局域网对局不受座位门控影响", () => {
    const sameScreen = {
      matchType: "human-human",
      turn: "red",
    } as PublicGameState;
    expect(isMySeatTurn(sameScreen, null)).toBe(true);
  });

  it("局域网对局只有轮到自己才可操作", () => {
    const game = lanGame({ turn: "red" });
    expect(isMySeatTurn(game, "red")).toBe(true);
    expect(isMySeatTurn(game, "black")).toBe(false);
    expect(isMySeatTurn(game, null)).toBe(false);
  });

  it("座位被房主收回后可识别", () => {
    const blackSeat = {
      gameId: "game-1",
      color: "black" as const,
      token: "old-token",
      savedAt: "2026-09-01T00:00:00.000Z",
    };
    const revoked = lanGame({
      lan: room({
        // A replacement already occupies black; occupancy therefore cannot
        // identify whether this device's old credential is still valid.
        viewer: { status: "revoked" },
      }),
    });
    expect(isSeatRevoked(revoked, blackSeat)).toBe(true);
    expect(seatColorFor(revoked, blackSeat)).toBeNull();
    expect(
      seatColorFor(
        lanGame({ lan: room({ viewer: { status: "invalid" } }) }),
        blackSeat,
      ),
    ).toBeNull();
    expect(
      isSeatRevoked(
        lanGame({
          lan: room({ viewer: { status: "valid", color: "black" } }),
        }),
        blackSeat,
      ),
    ).toBe(false);
    expect(
      seatColorFor(
        lanGame({
          lan: room({ viewer: { status: "valid", color: "black" } }),
        }),
        blackSeat,
      ),
    ).toBe("black");
  });

  it("能判断对手在线与是否仍在等待加入", () => {
    const waiting = lanGame({
      lan: room({
        seats: {
          red: { claimed: true, online: true },
          black: { claimed: false, online: false },
        },
      }),
    });
    expect(isWaitingForOpponent(waiting)).toBe(true);
    expect(isOpponentOnline(waiting, "red")).toBe(false);

    const ready = lanGame();
    expect(isWaitingForOpponent(ready)).toBe(false);
    expect(isOpponentOnline(ready, "red")).toBe(true);
  });
});

describe("房间状态变化检测", () => {
  it("对手入座时 revision 不变，但必须被识别为有变化", () => {
    const before = lanGame({
      lan: room({
        seats: {
          red: { claimed: true, online: true },
          black: { claimed: false, online: false },
        },
      }),
    });
    const after = lanGame();
    expect(before.revision).toBe(after.revision);
    expect(lanStateChanged(before, after)).toBe(true);
  });

  it("在线状态、房间码与悔棋请求的变化都会被识别", () => {
    const base = lanGame();
    expect(
      lanStateChanged(
        base,
        lanGame({
          lan: room({
            seats: {
              red: { claimed: true, online: true },
              black: { claimed: true, online: false },
            },
          }),
        }),
      ),
    ).toBe(true);
    expect(
      lanStateChanged(base, lanGame({ lan: room({ roomCode: "NEW123" }) })),
    ).toBe(true);
    expect(
      lanStateChanged(
        base,
        lanGame({
          lan: room({
            undoRequest: {
              id: "request-1",
              requestedBy: "red",
              atRevision: 3,
              expiresAt: "2026-01-01T00:00:00.000Z",
            },
          }),
        }),
      ),
    ).toBe(true);
  });

  it("同 revision 的新悔棋 ID 仍会触发界面更新", () => {
    const request = {
      requestedBy: "red" as const,
      atRevision: 3,
      expiresAt: "2026-01-01T00:00:00.000Z",
    };
    const before = lanGame({
      lan: room({ undoRequest: { ...request, id: "request-1" } }),
    });
    const after = lanGame({
      lan: room({ undoRequest: { ...request, id: "request-2" } }),
    });
    expect(lanStateChanged(before, after)).toBe(true);
  });

  it("完全相同的房间状态不触发重绘", () => {
    expect(lanStateChanged(lanGame(), lanGame())).toBe(false);
    const plain = { matchType: "human-human" } as PublicGameState;
    expect(lanStateChanged(plain, plain)).toBe(false);
  });
});

describe("房间码与加入链接", () => {
  it("归一化输入，丢弃分隔符与非法字符", () => {
    expect(normalizeRoomCodeInput(" abc-234 ")).toBe("ABC234");
    expect(normalizeRoomCodeInput("a!b@c#2")).toBe("ABC2");
    expect(normalizeRoomCodeInput("ABC-234-EXTRA")).toBe("ABC234");
  });

  it("加入链接使用服务端给出的 IP 字面量", () => {
    expect(joinUrlFor("192.168.1.5", 3001, "ABC234")).toBe(
      "http://192.168.1.5:3001/?room=ABC234",
    );
  });

  it("读取 ?room= 之后立即从地址栏抹掉，避免邀请留在历史里", () => {
    window.history.replaceState(null, "", "/?room=abc-234&keep=1");
    expect(takeRoomCodeFromLocation()).toBe("ABC234");
    expect(window.location.search).toBe("?keep=1");
    // 再读一次就没有了。
    expect(takeRoomCodeFromLocation()).toBeNull();
  });
});
