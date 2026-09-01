import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  oppositeColor,
  type Color,
  type LanRoomState,
  type PublicGameState,
} from "../../shared/contracts";

export type LanRoomErrorCode =
  | "LAN_ROOM_NOT_FOUND"
  | "LAN_CODE_REVOKED"
  | "LAN_ROOM_FULL"
  | "LAN_JOIN_THROTTLED"
  | "LAN_SEAT_TOKEN_INVALID"
  | "LAN_SEAT_REVOKED"
  | "LAN_NOT_YOUR_SEAT"
  | "LAN_INVITE_STALE"
  | "LAN_WAITING_FOR_OPPONENT"
  | "LAN_UNDO_REQUEST_EXISTS"
  | "LAN_UNDO_REQUEST_NOT_FOUND"
  | "LAN_CANNOT_SELF_APPROVE"
  | "CAPACITY_EXCEEDED";

export class LanRoomError extends Error {
  constructor(
    public readonly code: LanRoomErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "LanRoomError";
  }
}

interface InternalSeat {
  /** Null means unclaimed — either never joined, or revoked by the host. */
  tokenHash: Buffer | null;
  lastSeenAt: number | null;
}

interface InternalUndoRequest {
  id: string;
  requestedBy: Color;
  atRevision: number;
  expiresAtMs: number;
}

interface InternalRoom {
  gameId: string;
  roomCode: string;
  hostColor: Color;
  seats: Record<Color, InternalSeat>;
  undoRequest: InternalUndoRequest | null;
  createdAtMs: number;
  /** Ending a game is not the same as evicting a seat; keep them distinct. */
  finished: boolean;
}

export interface LanRoomManagerOptions {
  /** Compatibility fallback for callers that cannot batch registry sweeps. */
  hasGame?: (gameId: string) => boolean;
  /** Preferred: prune the backing store once and return all surviving ids. */
  existingGames?: (gameIds: readonly string[]) => ReadonlySet<string>;
  now?: () => Date;
  tokenFactory?: () => string;
  codeFactory?: () => string;
  maxRooms?: number;
  /** A seat is "online" while its heartbeat is this fresh. */
  presenceStaleMs?: number;
  undoRequestTtlMs?: number;
  /** Injectable only for deterministic tests; production uses 128 random bits. */
  undoRequestIdFactory?: () => string;
  revokedCodeTtlMs?: number;
  maxFailedJoinsPerWindow?: number;
  joinWindowMs?: number;
}

export interface LanSeatCredential {
  gameId: string;
  color: Color;
  token: string;
}

/** No 0/O/1/I — these are read aloud and typed on phones. */
const ROOM_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const ROOM_CODE_LENGTH = 6;

const hashToken = (token: string): Buffer =>
  createHash("sha256").update(token).digest();

const defaultCodeFactory = (): string => {
  // 256 % 32 === 0, so a plain modulo over random bytes stays uniform.
  const bytes = randomBytes(ROOM_CODE_LENGTH);
  let code = "";
  for (const byte of bytes) code += ROOM_CODE_ALPHABET[byte % 32];
  return code;
};

export const normalizeRoomCode = (raw: string): string =>
  raw.trim().toUpperCase().replaceAll(/[\s-]/g, "");

export class LanRoomManager {
  private readonly rooms = new Map<string, InternalRoom>();
  private readonly codeIndex = new Map<string, string>();
  private readonly revokedCodes = new Map<string, number>();
  /** Hashes of seat tokens the host revoked, so an evicted device can be told
   *  precisely that — without turning the endpoint into an occupancy oracle
   *  for anyone who merely knows a game id. */
  private readonly revokedSeatTokens = new Map<string, number>();
  private failedJoins = new Map<string, number[]>();

  private readonly existingGames: (
    gameIds: readonly string[],
  ) => ReadonlySet<string>;
  private readonly now: () => Date;
  private readonly tokenFactory: () => string;
  private readonly codeFactory: () => string;
  private readonly maxRooms: number;
  private readonly presenceStaleMs: number;
  private readonly undoRequestTtlMs: number;
  private readonly undoRequestIdFactory: () => string;
  private readonly revokedCodeTtlMs: number;
  private readonly maxFailedJoinsPerWindow: number;
  private readonly joinWindowMs: number;

  constructor(options: LanRoomManagerOptions = {}) {
    const hasGame = options.hasGame ?? (() => true);
    this.existingGames =
      options.existingGames ??
      ((gameIds) => new Set(gameIds.filter((gameId) => hasGame(gameId))));
    this.now = options.now ?? (() => new Date());
    this.tokenFactory =
      options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
    this.codeFactory = options.codeFactory ?? defaultCodeFactory;
    this.maxRooms = options.maxRooms ?? 128;
    this.presenceStaleMs = options.presenceStaleMs ?? 10_000;
    this.undoRequestTtlMs = options.undoRequestTtlMs ?? 60_000;
    this.undoRequestIdFactory =
      options.undoRequestIdFactory ?? (() => randomBytes(16).toString("hex"));
    this.revokedCodeTtlMs = options.revokedCodeTtlMs ?? 10 * 60_000;
    this.maxFailedJoinsPerWindow = options.maxFailedJoinsPerWindow ?? 10;
    this.joinWindowMs = options.joinWindowMs ?? 60_000;
  }

  private nowMs(): number {
    return this.now().getTime();
  }

  /** Rooms never outlive their game; the store's TTL is the single authority. */
  private prune(): void {
    const now = this.nowMs();
    const existing = this.existingGames([...this.rooms.keys()]);
    for (const [gameId, room] of this.rooms) {
      if (existing.has(gameId)) continue;
      // A finished room can outlive its revoked-code tombstone. If that code is
      // later reused, pruning the old room must not delete the new owner's map.
      if (this.codeIndex.get(room.roomCode) === gameId) {
        this.codeIndex.delete(room.roomCode);
      }
      this.rooms.delete(gameId);
    }
    for (const [code, expiresAtMs] of this.revokedCodes) {
      if (expiresAtMs <= now) this.revokedCodes.delete(code);
    }
    for (const [hash, expiresAtMs] of this.revokedSeatTokens) {
      if (expiresAtMs <= now) this.revokedSeatTokens.delete(hash);
    }
  }

  private freshCode(): string {
    this.prune();
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const candidate = this.codeFactory();
      if (!this.codeIndex.has(candidate) && !this.revokedCodes.has(candidate)) {
        return candidate;
      }
    }
    throw new LanRoomError(
      "CAPACITY_EXCEEDED",
      "无法生成可用的房间码，请稍后重试。",
    );
  }

  /**
   * Capacity check on its own, so a caller can verify room availability before
   * creating a game it would otherwise have to leave orphaned in the store.
   */
  assertCapacity(): void {
    this.prune();
    // A finished game's room lingers only so both players can still read the
    // result; it is not a live room and must not consume a slot.
    let live = 0;
    for (const room of this.rooms.values()) if (!room.finished) live += 1;
    if (live >= this.maxRooms) {
      throw new LanRoomError(
        "CAPACITY_EXCEEDED",
        "房间数量已满，请结束一些对局后重试。",
      );
    }
  }

  create(
    gameId: string,
    hostColor: Color,
  ): LanSeatCredential & {
    roomCode: string;
  } {
    this.assertCapacity();
    const roomCode = this.freshCode();
    const token = this.tokenFactory();
    const now = this.nowMs();
    const room: InternalRoom = {
      gameId,
      roomCode,
      hostColor,
      seats: {
        red: { tokenHash: null, lastSeenAt: null },
        black: { tokenHash: null, lastSeenAt: null },
      },
      undoRequest: null,
      createdAtMs: now,
      finished: false,
    };
    room.seats[hostColor] = { tokenHash: hashToken(token), lastSeenAt: now };
    this.rooms.set(gameId, room);
    this.codeIndex.set(roomCode, gameId);
    return { gameId, color: hostColor, token, roomCode };
  }

  /**
   * Per-caller, because a shared counter turns one person fat-fingering a code
   * into a house-wide lockout — and a typo produces the same "unknown code" as
   * a guess, so typos cannot be excluded from the count.
   */
  private throttleGuard(clientKey: string): void {
    const now = this.nowMs();
    for (const [key, times] of this.failedJoins) {
      const fresh = times.filter((at) => now - at < this.joinWindowMs);
      if (fresh.length) this.failedJoins.set(key, fresh);
      else this.failedJoins.delete(key);
    }
    const attempts = this.failedJoins.get(clientKey) ?? [];
    if (attempts.length >= this.maxFailedJoinsPerWindow) {
      throw new LanRoomError(
        "LAN_JOIN_THROTTLED",
        "房间码尝试过于频繁，请稍后再试。",
      );
    }
  }

  private recordFailedJoin(clientKey: string): void {
    const attempts = this.failedJoins.get(clientKey) ?? [];
    attempts.push(this.nowMs());
    this.failedJoins.set(clientKey, attempts);
    // Bound the map so a spoofed-header flood cannot grow it without limit.
    if (this.failedJoins.size > 1_024) {
      const oldest = this.failedJoins.keys().next().value as string | undefined;
      if (oldest !== undefined && oldest !== clientKey) {
        this.failedJoins.delete(oldest);
      }
    }
  }

  /**
   * Deliberately synchronous: no await may separate the "is the guest seat
   * open?" check from the claim, or two redemptions of one code both succeed.
   */
  join(rawCode: string, clientKey = "local"): LanSeatCredential {
    this.prune();
    this.throttleGuard(clientKey);
    const code = normalizeRoomCode(rawCode);

    if (this.revokedCodes.has(code)) {
      throw new LanRoomError(
        "LAN_CODE_REVOKED",
        "该房间码已失效，请向房主索取新的房间码。",
      );
    }
    const gameId = this.codeIndex.get(code);
    const room = gameId ? this.rooms.get(gameId) : undefined;
    if (!room) {
      // Only an unknown code counts: a known-but-stale or known-but-full code
      // is an ordinary mistake, not a guess.
      this.recordFailedJoin(clientKey);
      throw new LanRoomError(
        "LAN_ROOM_NOT_FOUND",
        "没有找到该房间码对应的对局。",
      );
    }
    if (room.finished) {
      throw new LanRoomError("LAN_ROOM_NOT_FOUND", "该对局已经结束。");
    }

    const guestColor = oppositeColor(room.hostColor);
    if (room.seats[guestColor].tokenHash) {
      throw new LanRoomError("LAN_ROOM_FULL", "该对局的对手座位已经有人加入。");
    }

    const token = this.tokenFactory();
    room.seats[guestColor] = {
      tokenHash: hashToken(token),
      lastSeenAt: this.nowMs(),
    };
    return { gameId: room.gameId, color: guestColor, token };
  }

  has(gameId: string): boolean {
    this.prune();
    return this.rooms.has(gameId);
  }

  private requireRoom(gameId: string): InternalRoom {
    this.prune();
    const room = this.rooms.get(gameId);
    if (!room) {
      throw new LanRoomError(
        "LAN_ROOM_NOT_FOUND",
        "该对局没有可用的局域网房间。",
      );
    }
    return room;
  }

  /**
   * Resolves a bearer token to its seat colour. Distinguishes "your seat was
   * revoked" from "wrong token" by seat presence, so an evicted device can be
   * told precisely what happened.
   */
  authenticate(gameId: string, token: string): Color {
    const room = this.requireRoom(gameId);
    const received = hashToken(token);
    for (const color of ["red", "black"] as const) {
      const seat = room.seats[color];
      if (seat.tokenHash && timingSafeEqual(received, seat.tokenHash)) {
        return color;
      }
    }
    if (this.revokedSeatTokens.has(received.toString("hex"))) {
      throw new LanRoomError(
        "LAN_SEAT_REVOKED",
        "你已被移出对局，请向房主索取新的房间码。",
      );
    }
    throw new LanRoomError("LAN_SEAT_TOKEN_INVALID", "座位令牌无效。");
  }

  /** Rides the existing 1s poll; never issues a request of its own. */
  heartbeat(gameId: string, color: Color): void {
    const room = this.rooms.get(gameId);
    if (!room) return;
    const seat = room.seats[color];
    if (seat.tokenHash) seat.lastSeenAt = this.nowMs();
  }

  bothSeatsClaimed(gameId: string): boolean {
    const room = this.requireRoom(gameId);
    return Boolean(room.seats.red.tokenHash && room.seats.black.tokenHash);
  }

  assertReady(gameId: string): void {
    if (!this.bothSeatsClaimed(gameId)) {
      throw new LanRoomError(
        "LAN_WAITING_FOR_OPPONENT",
        "对手还没有加入，暂时不能落子。",
      );
    }
  }

  hostColor(gameId: string): Color {
    return this.requireRoom(gameId).hostColor;
  }

  /**
   * Lazily invalidates a pending request. A request never blocks anything:
   * either side may move or resign while one is outstanding, and the first
   * move kills it, so a disconnected requester can never wedge the game.
   */
  private livingUndoRequest(
    room: InternalRoom,
    game: PublicGameState,
  ): InternalUndoRequest | null {
    const request = room.undoRequest;
    if (!request) return null;
    if (
      request.atRevision !== game.revision ||
      request.expiresAtMs <= this.nowMs() ||
      game.status.phase !== "active"
    ) {
      room.undoRequest = null;
      return null;
    }
    return request;
  }

  requestUndo(gameId: string, color: Color, game: PublicGameState): string {
    const room = this.requireRoom(gameId);
    this.assertReady(gameId);
    // Otherwise the request is accepted and then dropped by the very next
    // projection, which reads to both players as nothing happening at all.
    if (game.status.phase !== "active") {
      throw new LanRoomError("LAN_UNDO_REQUEST_NOT_FOUND", "对局已经结束。");
    }
    // The engine takes back exactly the last ply, which belongs to whoever is
    // NOT on turn. Without this check the side that has not moved could ask to
    // undo the opponent's move, and the opponent's prompt ("对手请求悔棋")
    // would give no hint that they were approving the loss of their own move.
    if (color === game.turn) {
      throw new LanRoomError(
        "LAN_NOT_YOUR_SEAT",
        "只能请求撤回自己刚走的那一步。",
      );
    }
    if (this.livingUndoRequest(room, game)) {
      throw new LanRoomError(
        "LAN_UNDO_REQUEST_EXISTS",
        "已经有一个悔棋请求在等待回应。",
      );
    }
    const id = this.undoRequestIdFactory();
    room.undoRequest = {
      id,
      requestedBy: color,
      atRevision: game.revision,
      expiresAtMs: this.nowMs() + this.undoRequestTtlMs,
    };
    return id;
  }

  /**
   * Returns true when the caller's decision should actually take the move
   * back. Approval and execution are one atomic step in the route handler, so
   * there is no approved-but-unexecuted state to race against.
   */
  resolveUndo(
    gameId: string,
    color: Color,
    requestId: string,
    accept: boolean,
    game: PublicGameState,
  ): boolean {
    const room = this.requireRoom(gameId);
    const request = this.livingUndoRequest(room, game);
    if (!request) {
      throw new LanRoomError(
        "LAN_UNDO_REQUEST_NOT_FOUND",
        "该悔棋请求已经失效，请重新发起。",
      );
    }
    if (request.id !== requestId) {
      throw new LanRoomError(
        "LAN_UNDO_REQUEST_NOT_FOUND",
        "该悔棋请求已经失效，请重新读取后回应。",
      );
    }
    if (request.requestedBy === color) {
      if (accept) {
        throw new LanRoomError(
          "LAN_CANNOT_SELF_APPROVE",
          "不能自己批准自己的悔棋请求。",
        );
      }
      room.undoRequest = null;
      return false;
    }
    room.undoRequest = null;
    return accept;
  }

  /** Host-only: revokes the guest seat and mints a brand-new code. */
  reinvite(gameId: string, color: Color, expectedRoomCode: string): string {
    const room = this.requireRoom(gameId);
    if (color !== room.hostColor) {
      throw new LanRoomError("LAN_NOT_YOUR_SEAT", "只有房主可以重新邀请。");
    }
    // Re-inviting into a finished game would mint a code that leads nowhere;
    // a rematch is a new game, not a new guest for the old one.
    if (room.finished) {
      throw new LanRoomError(
        "LAN_ROOM_NOT_FOUND",
        "对局已经结束，请另开一局。",
      );
    }
    if (room.roomCode !== normalizeRoomCode(expectedRoomCode)) {
      throw new LanRoomError(
        "LAN_INVITE_STALE",
        "邀请状态已经更新，请读取最新房间码后重试。",
      );
    }
    const guestColor = oppositeColor(room.hostColor);
    const revoked = room.seats[guestColor].tokenHash;
    if (revoked) {
      this.revokedSeatTokens.set(
        revoked.toString("hex"),
        this.nowMs() + this.revokedCodeTtlMs,
      );
    }
    room.seats[guestColor] = { tokenHash: null, lastSeenAt: null };
    room.undoRequest = null;

    this.codeIndex.delete(room.roomCode);
    // A reused code would let the just-evicted device walk straight back in.
    this.revokedCodes.set(room.roomCode, this.nowMs() + this.revokedCodeTtlMs);
    room.roomCode = this.freshCode();
    this.codeIndex.set(room.roomCode, gameId);
    return room.roomCode;
  }

  /**
   * Ends the room's invite, but deliberately KEEPS both seat tokens.
   *
   * Wiping them here would make `claimed` go false for both players on the very
   * response that announces the result — which the client reads as "you were
   * removed from the game" — and would 401 the host out of their own finished
   * game. The credentials are not a lasting risk: the engine already refuses
   * every write on a finished game, no new guest can join once the code is
   * revoked, and the whole room is dropped when the game leaves the store.
   */
  finish(gameId: string): void {
    const room = this.rooms.get(gameId);
    if (!room || room.finished) return;
    room.finished = true;
    room.undoRequest = null;
    this.codeIndex.delete(room.roomCode);
    this.revokedCodes.set(room.roomCode, this.nowMs() + this.revokedCodeTtlMs);
  }

  /**
   * The browser-safe projection. `roomCode` is disclosed only to the host, so
   * a bare read of a game never hands out a live invite.
   */
  project(
    gameId: string,
    game: PublicGameState,
    viewer: Color | null,
  ): LanRoomState | null {
    const room = this.rooms.get(gameId);
    if (!room) return null;
    const request = this.livingUndoRequest(room, game);
    const now = this.nowMs();
    const seatState = (color: Color) => {
      const seat = room.seats[color];
      return {
        claimed: Boolean(seat.tokenHash),
        online: Boolean(
          seat.tokenHash &&
          seat.lastSeenAt !== null &&
          now - seat.lastSeenAt <= this.presenceStaleMs,
        ),
      };
    };
    return {
      // The code is revoked once the game ends; showing it would invite a join
      // that can only fail.
      ...(viewer === room.hostColor && !room.finished
        ? { roomCode: room.roomCode }
        : {}),
      host: room.hostColor,
      seats: { red: seatState("red"), black: seatState("black") },
      undoRequest: request
        ? {
            id: request.id,
            requestedBy: request.requestedBy,
            atRevision: request.atRevision,
            expiresAt: new Date(request.expiresAtMs).toISOString(),
          }
        : null,
    };
  }

  stopAll(): void {
    this.rooms.clear();
    this.codeIndex.clear();
    this.revokedCodes.clear();
    this.revokedSeatTokens.clear();
    this.failedJoins.clear();
  }

  get size(): number {
    return this.rooms.size;
  }
}
