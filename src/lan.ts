import type { Color, LanRoomState, PublicGameState } from "../shared/contracts";

/**
 * A separate key from `masked-xiangqi:last-game-id`, which stays a bare string.
 * Nothing to migrate, and the resume flow keeps working for older records.
 */
export const LAN_SEAT_STORAGE_KEY = "masked-xiangqi:lan-seat";
export const LAN_SEAT_SLOT_PREFIX = `${LAN_SEAT_STORAGE_KEY}:slot:`;
export const LAN_SEAT_TOMBSTONE_PREFIX = `${LAN_SEAT_STORAGE_KEY}:cleared:`;

/** Room codes are fixed-length; the join form refuses anything shorter. */
export const ROOM_CODE_LENGTH = 6;

export interface LanSeatRecord {
  gameId: string;
  color: Color;
  token: string;
  savedAt: string;
  /** Unique immutable storage slot; absent only on pre-v1.1 records. */
  storageId?: string;
  /** Monotonic best-effort issuance order; absent only on pre-v1.1 records. */
  generation?: number;
}

export const sameSeatCredential = (
  left: Pick<LanSeatRecord, "gameId" | "token">,
  right: Pick<LanSeatRecord, "gameId" | "token">,
): boolean => left.gameId === right.gameId && left.token === right.token;

/**
 * Chooses the freshest recovery credential without making localStorage more
 * authoritative than a seat that was just minted in this tab. Modern records
 * use a monotonic generation; timestamps only order legacy/concurrent ties,
 * with immutable IDs providing a deterministic final tie-breaker.
 */
export const latestSeatRecord = (
  inMemory: LanSeatRecord | null,
  persisted: LanSeatRecord | null,
): LanSeatRecord | null => {
  if (!inMemory) return persisted;
  if (!persisted) return inMemory;

  const memoryGeneration = inMemory.generation ?? 0;
  const persistedGeneration = persisted.generation ?? 0;
  if (persistedGeneration > memoryGeneration) return persisted;
  if (memoryGeneration > persistedGeneration) return inMemory;

  const memoryTime = Date.parse(inMemory.savedAt);
  const persistedTime = Date.parse(persisted.savedAt);
  if (Number.isFinite(memoryTime) && Number.isFinite(persistedTime)) {
    if (persistedTime > memoryTime) return persisted;
    if (memoryTime > persistedTime) return inMemory;
  }
  // Concurrent tabs can choose the same next generation and millisecond.
  // Break every remaining tie by immutable data so all tabs select the same
  // winner regardless of localStorage enumeration or reducer order.
  const memoryTieBreaker = [
    inMemory.savedAt,
    inMemory.storageId ?? "",
    inMemory.gameId,
    inMemory.token,
    inMemory.color,
  ].join("\u0000");
  const persistedTieBreaker = [
    persisted.savedAt,
    persisted.storageId ?? "",
    persisted.gameId,
    persisted.token,
    persisted.color,
  ].join("\u0000");
  return persistedTieBreaker > memoryTieBreaker ? persisted : inMemory;
};

const isSeatRecord = (value: unknown): value is LanSeatRecord => {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<LanSeatRecord>;
  return (
    typeof record.gameId === "string" &&
    (record.color === "red" || record.color === "black") &&
    typeof record.token === "string" &&
    typeof record.savedAt === "string" &&
    (record.storageId === undefined || typeof record.storageId === "string") &&
    (record.generation === undefined ||
      (Number.isSafeInteger(record.generation) && record.generation >= 0))
  );
};

const parseSeatRecord = (raw: string | null): LanSeatRecord | null => {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isSeatRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

interface LanSeatTombstone {
  gameId: string;
  token: string;
  clearedAt: string;
  /** Keeps the issuance clock monotonic even when the seat had no slot. */
  generation?: number;
}

const parseSeatTombstone = (raw: string | null): LanSeatTombstone | null => {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const tombstone = parsed as Partial<LanSeatTombstone>;
    return typeof tombstone.gameId === "string" &&
      typeof tombstone.token === "string" &&
      typeof tombstone.clearedAt === "string" &&
      (tombstone.generation === undefined ||
        (Number.isSafeInteger(tombstone.generation) &&
          tombstone.generation >= 0))
      ? (tombstone as LanSeatTombstone)
      : null;
  } catch {
    return null;
  }
};

const seatStorageId = (): string => {
  try {
    return crypto.randomUUID();
  } catch {
    const bytes = new Uint32Array(4);
    crypto.getRandomValues(bytes);
    return [...bytes]
      .map((value) => value.toString(16).padStart(8, "0"))
      .join("");
  }
};

const storageKeys = (): string[] => {
  const keys: string[] = [];
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key) keys.push(key);
    }
  } catch {
    // The legacy key below remains a best-effort fallback.
  }
  return keys;
};

const storedSeatSlots = (keys: string[]): LanSeatRecord[] =>
  keys
    .filter((key) => key.startsWith(LAN_SEAT_SLOT_PREFIX))
    .map((key) => parseSeatRecord(window.localStorage.getItem(key)))
    .filter((record): record is LanSeatRecord => Boolean(record));

const storedSeatTombstones = (keys: string[]): LanSeatTombstone[] =>
  keys
    .filter((key) => key.startsWith(LAN_SEAT_TOMBSTONE_PREFIX))
    .map((key) => parseSeatTombstone(window.localStorage.getItem(key)))
    .filter((record): record is LanSeatTombstone => Boolean(record));

const storedSeatRecords = (keys = storageKeys()): LanSeatRecord[] => {
  const records = storedSeatSlots(keys);
  const tombstones = storedSeatTombstones(keys);
  const legacy = parseSeatRecord(
    window.localStorage.getItem(LAN_SEAT_STORAGE_KEY),
  );
  if (legacy) {
    const duplicatesSlot = records.some((record) =>
      sameSeatCredential(record, legacy),
    );
    const wasCleared = tombstones.some((tombstone) =>
      sameSeatCredential(tombstone, legacy),
    );
    if (legacy.generation === undefined && !duplicatesSlot && !wasCleared) {
      // A pre-v1.1 tab can still mint a seat after this build has written
      // generation-bearing slots. The shared pointer is its only write, so an
      // unmatched, non-tombstoned legacy credential becomes the next logical
      // generation regardless of wall-clock changes.
      const maximum = [...records, ...tombstones].reduce(
        (current, record) => Math.max(current, record.generation ?? 0),
        0,
      );
      records.push({
        ...legacy,
        generation: maximum < Number.MAX_SAFE_INTEGER ? maximum + 1 : maximum,
      });
    } else {
      records.push(legacy);
    }
  }
  return records;
};

const nextSeatGeneration = (): number => {
  try {
    const keys = storageKeys();
    const currentMaximum = [
      ...storedSeatRecords(keys),
      ...storedSeatTombstones(keys),
    ].reduce((maximum, record) => Math.max(maximum, record.generation ?? 0), 0);
    return currentMaximum < Number.MAX_SAFE_INTEGER
      ? currentMaximum + 1
      : currentMaximum;
  } catch {
    // With unavailable storage only this tab's in-memory credential matters.
    return 1;
  }
};

export const createSeatRecord = (
  record: Omit<LanSeatRecord, "savedAt" | "storageId" | "generation">,
): LanSeatRecord => ({
  ...record,
  savedAt: new Date().toISOString(),
  storageId: seatStorageId(),
  generation: nextSeatGeneration(),
});

export const readSeatRecord = (gameId?: string): LanSeatRecord | null => {
  try {
    const keys = storageKeys();
    const records = storedSeatRecords(keys);
    const tombstones = storedSeatTombstones(keys);
    const latest = records.reduce<LanSeatRecord | null>(
      (current, record) => latestSeatRecord(current, record),
      null,
    );
    if (
      latest &&
      tombstones.some(
        (tombstone) =>
          sameSeatCredential(tombstone, latest) ||
          (tombstone.generation !== undefined &&
            tombstone.generation > (latest.generation ?? 0)),
      )
    ) {
      return null;
    }
    if (gameId && latest?.gameId !== gameId) return null;
    return latest;
  } catch {
    return null;
  }
};

export const writeSeatRecord = (
  record: Omit<LanSeatRecord, "savedAt"> | LanSeatRecord,
): LanSeatRecord => {
  const stored: LanSeatRecord = {
    ...record,
    savedAt: "savedAt" in record ? record.savedAt : new Date().toISOString(),
    storageId: record.storageId ?? seatStorageId(),
    generation: record.generation ?? nextSeatGeneration(),
  };
  try {
    // The immutable slot is authoritative. The legacy key is only a pointer
    // for older builds; losing it to a concurrent remove cannot lose the seat.
    window.localStorage.setItem(
      `${LAN_SEAT_SLOT_PREFIX}${stored.storageId}`,
      JSON.stringify(stored),
    );
    window.localStorage.setItem(LAN_SEAT_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Seat recovery is a convenience; private browsing may deny storage.
  }
  return stored;
};

/**
 * Ends only the credential the caller actually finished. Its immutable
 * tombstone keeps an older slot from becoming recoverable again, while a
 * different credential written by another tab remains unaffected. Conditional
 * cleanup never removes the shared legacy pointer: localStorage has no atomic
 * compare-and-delete, so its tombstone makes the old value non-authoritative
 * without risking deletion of a legacy-only credential written concurrently.
 */
export const clearSeatRecord = (
  expected?: Pick<LanSeatRecord, "gameId" | "token"> &
    Partial<Pick<LanSeatRecord, "generation">>,
): boolean => {
  try {
    if (!expected) {
      for (const key of storageKeys()) {
        if (
          key.startsWith(LAN_SEAT_SLOT_PREFIX) ||
          key.startsWith(LAN_SEAT_TOMBSTONE_PREFIX)
        ) {
          window.localStorage.removeItem(key);
        }
      }
      window.localStorage.removeItem(LAN_SEAT_STORAGE_KEY);
      return true;
    }

    let expectedWasPersisted = false;
    let alreadyTombstoned = false;
    let generationTombstoned = false;
    try {
      const keys = storageKeys();
      const legacy = parseSeatRecord(
        window.localStorage.getItem(LAN_SEAT_STORAGE_KEY),
      );
      expectedWasPersisted =
        storedSeatSlots(keys).some((record) =>
          sameSeatCredential(record, expected),
        ) || Boolean(legacy && sameSeatCredential(legacy, expected));
      const matchingTombstones = storedSeatTombstones(keys).filter(
        (tombstone) => sameSeatCredential(tombstone, expected),
      );
      alreadyTombstoned = matchingTombstones.length > 0;
      generationTombstoned =
        expected.generation !== undefined &&
        matchingTombstones.some(
          (tombstone) =>
            tombstone.generation !== undefined &&
            tombstone.generation >= expected.generation!,
        );
    } catch {
      // If recovery storage cannot even be read, this credential is usable
      // only from React memory and does not require a persistent tombstone.
    }

    const tombstone: LanSeatTombstone = {
      ...expected,
      clearedAt: new Date().toISOString(),
    };
    // Persist the credential-scoped tombstone without mutating the shared
    // compatibility pointer. A pre-v1.1 writer has no immutable slot, and a
    // get/remove pair could erase its newly issued credential in between.
    if (
      !alreadyTombstoned ||
      (expected.generation !== undefined && !generationTombstoned)
    ) {
      try {
        window.localStorage.setItem(
          `${LAN_SEAT_TOMBSTONE_PREFIX}${seatStorageId()}`,
          JSON.stringify(tombstone),
        );
      } catch {
        // A memory-only seat can be forgotten without persistent cleanup. If
        // its old token is readable from storage, however, replacement must
        // stop rather than let that credential reappear on refresh.
        return !expectedWasPersisted;
      }
    }
    const current = readSeatRecord();
    return current === null;
  } catch {
    // A failed tombstone write must not make an active credential unreachable.
    return false;
  }
};

export const isLanGame = (game: PublicGameState | null): boolean =>
  game?.matchType === "lan-human";

/** The colour this device plays, or null when it holds no seat. */
export const seatColorFor = (
  game: PublicGameState | null,
  seat: LanSeatRecord | null,
): Color | null => {
  if (!isLanGame(game) || !seat || !game || seat.gameId !== game.id)
    return null;
  const viewer = game.lan?.viewer;
  if (viewer) {
    return viewer.status === "valid" && viewer.color === seat.color
      ? seat.color
      : null;
  }
  // Compatibility with an older projection that did not include `viewer`.
  // Occupancy cannot prove that a token is current once viewer metadata exists,
  // but an explicitly empty legacy seat does prove that it is no longer ours.
  return game.lan?.seats[seat.color].claimed ? seat.color : null;
};

export const isMySeatTurn = (
  game: PublicGameState | null,
  seatColor: Color | null,
): boolean => {
  if (!game) return false;
  if (game.matchType !== "lan-human") return true;
  return seatColor !== null && seatColor === game.turn;
};

/** True once the host has revoked this device's seat via 重新邀请. */
export const isSeatRevoked = (
  game: PublicGameState | null,
  seat: LanSeatRecord | null,
): boolean => {
  if (
    !game ||
    game.matchType !== "lan-human" ||
    !seat ||
    seat.gameId !== game.id
  ) {
    return false;
  }
  const viewer = game.lan?.viewer;
  if (viewer) {
    return viewer.status !== "valid" || viewer.color !== seat.color;
  }
  // Backward-compatible fallback for an older server projection. A v1.1
  // server always returns `viewer` when a token was supplied.
  return game.lan ? !game.lan.seats[seat.color].claimed : false;
};

export const opponentOf = (seatColor: Color | null): Color | null =>
  seatColor === "red" ? "black" : seatColor === "black" ? "red" : null;

export const isOpponentOnline = (
  game: PublicGameState | null,
  seatColor: Color | null,
): boolean => {
  const opponent = opponentOf(seatColor);
  if (!game?.lan || !opponent) return false;
  return game.lan.seats[opponent].online;
};

export const isWaitingForOpponent = (game: PublicGameState | null): boolean => {
  if (!game?.lan) return false;
  return !game.lan.seats.red.claimed || !game.lan.seats.black.claimed;
};

const sameLanSeats = (left: LanRoomState, right: LanRoomState): boolean =>
  (["red", "black"] as const).every(
    (color) =>
      left.seats[color].claimed === right.seats[color].claimed &&
      left.seats[color].online === right.seats[color].online,
  );

/**
 * Whether anything in the room changed while `revision` stayed put.
 *
 * This is load-bearing: joining a room, going offline, and having an undo
 * request answered all leave `revision` untouched, and the poll's normal path
 * only reacts to a revision increase. Without this the host would sit on
 * 「等待对手加入」 forever while the guest was already playing.
 */
export const lanStateChanged = (
  previous: PublicGameState,
  next: PublicGameState,
): boolean => {
  const before = previous.lan;
  const after = next.lan;
  if (!before && !after) return false;
  if (!before || !after) return true;
  if (before.roomCode !== after.roomCode) return true;
  if (
    before.viewer?.status !== after.viewer?.status ||
    (before.viewer?.status === "valid" &&
      after.viewer?.status === "valid" &&
      before.viewer.color !== after.viewer.color)
  ) {
    return true;
  }
  if (!sameLanSeats(before, after)) return true;
  const beforeUndo = before.undoRequest;
  const afterUndo = after.undoRequest;
  if (!beforeUndo && !afterUndo) return false;
  if (!beforeUndo || !afterUndo) return true;
  return (
    beforeUndo.id !== afterUndo.id ||
    beforeUndo.requestedBy !== afterUndo.requestedBy ||
    beforeUndo.atRevision !== afterUndo.atRevision
  );
};

export const normalizeRoomCodeInput = (raw: string): string =>
  raw
    .trim()
    .toUpperCase()
    .replaceAll(/[^0-9A-Z]/g, "")
    .slice(0, ROOM_CODE_LENGTH);

/**
 * Built from the server-reported address, never `window.location.hostname`:
 * LAN mode only accepts IP literals, so an mDNS name such as `macbook.local`
 * would produce a link the server then refuses.
 */
export const joinUrlFor = (
  address: string,
  port: number,
  code: string,
): string => `http://${address}:${port}/?room=${encodeURIComponent(code)}`;

/** Reads and then strips `?room=`, so the invite does not linger in history. */
export const takeRoomCodeFromLocation = (): string | null => {
  try {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("room");
    if (!code) return null;
    params.delete("room");
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}`,
    );
    return normalizeRoomCodeInput(code);
  } catch {
    return null;
  }
};
