import { createServer, type Server } from "node:http";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app";
import { GameStore } from "../engine/store";
import { LanRoomManager } from "../server/lan/room-manager";
import type { AiProvider } from "../server/ollama";
import type { Color, PublicGameState } from "../shared/contracts";

interface SeatResponse {
  game: PublicGameState;
  roomCode?: string;
  seat: { color: Color; token: string };
}

describe("局域网房间 API", () => {
  let store: GameStore;
  let server: Server;
  let lanRooms: LanRoomManager;

  const aiProvider: AiProvider = {
    listModels: vi.fn(async () => []),
    chooseMove: vi.fn(),
  } as unknown as AiProvider;

  beforeEach(async () => {
    store = new GameStore();
    lanRooms = new LanRoomManager({
      hasGame: (gameId) => store.has(gameId),
      existingGames: (gameIds) => store.existing(gameIds),
    });
    const app = createApp({
      store,
      aiProvider,
      lanRoomManager: lanRooms,
      random: () => 0.1, // host = red
    });
    server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const api = () => request(server);

  const host = async (): Promise<SeatResponse> =>
    (await api().post("/api/v1/rooms").send({}).expect(201))
      .body as SeatResponse;

  const join = async (roomCode: string): Promise<SeatResponse> =>
    (await api().post(`/api/v1/rooms/${roomCode}/join`).send({}).expect(200))
      .body as SeatResponse;

  /** legal-moves entries carry pieceId/captures; the move schema is strict. */
  const moveBody = (
    entry: { from: unknown; to: unknown },
    expectedRevision: number,
  ) => ({ from: entry.from, to: entry.to, expectedRevision });

  const seated = async () => {
    const created = await host();
    const guest = await join(created.roomCode!);
    return { created, guest };
  };

  it("建房返回一次性座位令牌、房间码与 lan-human 对局", async () => {
    const created = await host();
    expect(created.game.matchType).toBe("lan-human");
    expect(created.game.players.player1).toBe("red");
    expect(created.seat).toMatchObject({ color: "red" });
    expect(created.roomCode).toMatch(/^[23456789A-Z]{6}$/);
    // 房主视角能看到房间码，且客人座位还空着。
    expect(created.game.lan).toMatchObject({
      host: "red",
      seats: { black: { claimed: false } },
    });
  });

  it("POST /games 仍然拒绝创建局域网对局", async () => {
    const rejected = await api()
      .post("/api/v1/games")
      .send({ matchType: "lan-human" })
      .expect(400);
    expect(rejected.body.error.code).toBe("INVALID_REQUEST");
  });

  it("客人兑换房间码入座并拿到对面颜色", async () => {
    const { created, guest } = await seated();
    expect(guest.seat.color).toBe("black");
    expect(guest.seat.token).not.toBe(created.seat.token);
    expect(guest.game.lan?.seats.black.claimed).toBe(true);
    // 房间码只给房主，客人拿不到。
    expect(guest.game.lan?.roomCode).toBeUndefined();
  });

  it("未知、已满与限流的房间码分别给出可区分的错误", async () => {
    const { created } = await seated();
    expect(
      (await api().post("/api/v1/rooms/ZZZZZZ/join").send({}).expect(404)).body
        .error.code,
    ).toBe("LAN_ROOM_NOT_FOUND");
    expect(
      (
        await api()
          .post(`/api/v1/rooms/${created.roomCode}/join`)
          .send({})
          .expect(409)
      ).body.error.code,
    ).toBe("LAN_ROOM_FULL");
  });

  it("落子必须带正确座位令牌，且只能走自己的一方", async () => {
    const { created, guest } = await seated();
    const move = created.game.lan
      ? await api()
          .get(`/api/v1/games/${created.game.id}/legal-moves`)
          .expect(200)
      : null;
    const first = move!.body.moves[0];

    // 无令牌
    expect(
      (
        await api()
          .post(`/api/v1/games/${created.game.id}/moves`)
          .send(moveBody(first, 0))
          .expect(401)
      ).body.error.code,
    ).toBe("LAN_SEAT_TOKEN_INVALID");

    // 红方先行，黑方座位不能代走
    expect(
      (
        await api()
          .post(`/api/v1/games/${created.game.id}/moves`)
          .set("authorization", `Bearer ${guest.seat.token}`)
          .send(moveBody(first, 0))
          .expect(403)
      ).body.error.code,
    ).toBe("LAN_NOT_YOUR_SEAT");

    // 房主（红方）可以落子
    const applied = await api()
      .post(`/api/v1/games/${created.game.id}/moves`)
      .set("authorization", `Bearer ${created.seat.token}`)
      .send(moveBody(first, 0))
      .expect(200);
    expect(applied.body.revision).toBe(1);
    expect(applied.body.turn).toBe("black");
  });

  it("同 revision 的并发 LAN 落子恰好一个成功，其余稳定返回 STALE_REVISION", async () => {
    const { created } = await seated();
    const legal = await api()
      .get(`/api/v1/games/${created.game.id}/legal-moves`)
      .expect(200);
    const body = moveBody(legal.body.moves[0], 0);

    const attempts = await Promise.all(
      Array.from({ length: 2 }, () =>
        api()
          .post(`/api/v1/games/${created.game.id}/moves`)
          .set("authorization", `Bearer ${created.seat.token}`)
          .send(body),
      ),
    );
    expect(attempts.map(({ status }) => status).sort()).toEqual([200, 409]);
    expect(attempts.find(({ status }) => status === 409)?.body.error.code).toBe(
      "STALE_REVISION",
    );
  });

  it("对手未入座时不能落子", async () => {
    const created = await host();
    const moves = await api()
      .get(`/api/v1/games/${created.game.id}/legal-moves`)
      .expect(200);
    expect(
      (
        await api()
          .post(`/api/v1/games/${created.game.id}/moves`)
          .set("authorization", `Bearer ${created.seat.token}`)
          .send(moveBody(moves.body.moves[0], 0))
          .expect(409)
      ).body.error.code,
    ).toBe("LAN_WAITING_FOR_OPPONENT");
  });

  it("直接调用 /undo 被拒，必须走协商流程", async () => {
    const { created } = await seated();
    expect(
      (
        await api()
          .post(`/api/v1/games/${created.game.id}/undo`)
          .set("authorization", `Bearer ${created.seat.token}`)
          .send({ expectedRevision: 0 })
          .expect(403)
      ).body.error.code,
    ).toBe("LAN_UNDO_REQUIRES_CONSENT");
  });

  it("悔棋需要对手同意，同意后才真正回退", async () => {
    const { created, guest } = await seated();
    const gameId = created.game.id;
    const moves = await api()
      .get(`/api/v1/games/${gameId}/legal-moves`)
      .expect(200);
    await api()
      .post(`/api/v1/games/${gameId}/moves`)
      .set("authorization", `Bearer ${created.seat.token}`)
      .send(moveBody(moves.body.moves[0], 0))
      .expect(200);

    await api()
      .post(`/api/v1/games/${gameId}/undo-request`)
      .set("authorization", `Bearer ${created.seat.token}`)
      .send({ expectedRevision: 1 })
      .expect(201);

    // 对手在自己的轮询里看到请求。
    const guestView = await api()
      .get(`/api/v1/games/${gameId}`)
      .set("authorization", `Bearer ${guest.seat.token}`)
      .expect(200);
    expect(guestView.body.lan.undoRequest).toMatchObject({
      requestedBy: "red",
      atRevision: 1,
    });
    const requestId = guestView.body.lan.undoRequest.id as string;
    expect(requestId).toMatch(/^[0-9a-f]{32}$/);

    // 请求方不能自批。
    expect(
      (
        await api()
          .post(`/api/v1/games/${gameId}/undo-request/resolve`)
          .set("authorization", `Bearer ${created.seat.token}`)
          .send({ expectedRevision: 1, requestId, accept: true })
          .expect(403)
      ).body.error.code,
    ).toBe("LAN_CANNOT_SELF_APPROVE");

    const resolved = await api()
      .post(`/api/v1/games/${gameId}/undo-request/resolve`)
      .set("authorization", `Bearer ${guest.seat.token}`)
      .send({ expectedRevision: 1, requestId, accept: true })
      .expect(200);
    expect(resolved.body.moveNumber).toBe(0);
    expect(resolved.body.turn).toBe("red");
    expect(resolved.body.lan.undoRequest).toBeNull();
  });

  it("延迟的旧悔棋 ID 不能处理同 revision 的新请求", async () => {
    const { created, guest } = await seated();
    const gameId = created.game.id;
    const moves = await api()
      .get(`/api/v1/games/${gameId}/legal-moves`)
      .expect(200);
    await api()
      .post(`/api/v1/games/${gameId}/moves`)
      .set("authorization", `Bearer ${created.seat.token}`)
      .send(moveBody(moves.body.moves[0], 0))
      .expect(200);

    const requestUndo = async () => {
      const result = await api()
        .post(`/api/v1/games/${gameId}/undo-request`)
        .set("authorization", `Bearer ${created.seat.token}`)
        .send({ expectedRevision: 1 })
        .expect(201);
      return result.body.lan.undoRequest.id as string;
    };
    const firstId = await requestUndo();
    await api()
      .post(`/api/v1/games/${gameId}/undo-request/resolve`)
      .set("authorization", `Bearer ${guest.seat.token}`)
      .send({ expectedRevision: 1, requestId: firstId, accept: false })
      .expect(200);

    const secondId = await requestUndo();
    expect(secondId).not.toBe(firstId);
    const stale = await api()
      .post(`/api/v1/games/${gameId}/undo-request/resolve`)
      .set("authorization", `Bearer ${guest.seat.token}`)
      .send({ expectedRevision: 1, requestId: firstId, accept: true })
      .expect(409);
    expect(stale.body.error.code).toBe("LAN_UNDO_REQUEST_NOT_FOUND");

    const current = await api()
      .get(`/api/v1/games/${gameId}`)
      .set("authorization", `Bearer ${guest.seat.token}`)
      .expect(200);
    expect(current.body.lan.undoRequest.id).toBe(secondId);
  });

  it("对手先落子会让悔棋请求失效", async () => {
    const { created, guest } = await seated();
    const gameId = created.game.id;
    const first = await api().get(`/api/v1/games/${gameId}/legal-moves`);
    await api()
      .post(`/api/v1/games/${gameId}/moves`)
      .set("authorization", `Bearer ${created.seat.token}`)
      .send(moveBody(first.body.moves[0], 0))
      .expect(200);
    await api()
      .post(`/api/v1/games/${gameId}/undo-request`)
      .set("authorization", `Bearer ${created.seat.token}`)
      .send({ expectedRevision: 1 })
      .expect(201);

    // 黑方不回应，直接落子。
    const reply = await api().get(`/api/v1/games/${gameId}/legal-moves`);
    await api()
      .post(`/api/v1/games/${gameId}/moves`)
      .set("authorization", `Bearer ${guest.seat.token}`)
      .send(moveBody(reply.body.moves[0], 1))
      .expect(200);

    const after = await api()
      .get(`/api/v1/games/${gameId}`)
      .set("authorization", `Bearer ${created.seat.token}`)
      .expect(200);
    expect(after.body.lan.undoRequest).toBeNull();
  });

  it("任一方都可以在对手回合认输，且认输的是自己", async () => {
    const { created, guest } = await seated();
    // 轮到红方，但黑方座位认输 → 红方获胜。
    const resigned = await api()
      .post(`/api/v1/games/${created.game.id}/resign`)
      .set("authorization", `Bearer ${guest.seat.token}`)
      .send({ expectedRevision: 0 })
      .expect(200);
    expect(resigned.body.status).toMatchObject({
      phase: "finished",
      winner: "red",
      reason: "resignation",
    });
  });

  it("房主重新邀请后旧令牌被识别为已移出，新码可再次入座", async () => {
    const { created, guest } = await seated();
    const gameId = created.game.id;

    const reinvited = await api()
      .post(`/api/v1/games/${gameId}/invite`)
      .set("authorization", `Bearer ${created.seat.token}`)
      .send({ expectedRevision: 0, expectedRoomCode: created.roomCode })
      .expect(200);
    expect(reinvited.body.roomCode).not.toBe(created.roomCode);

    // 被移出的设备读取对局仍然成功（读是开放的），并能看到自己座位已空。
    const staleRead = await api()
      .get(`/api/v1/games/${gameId}`)
      .set("authorization", `Bearer ${guest.seat.token}`)
      .expect(200);
    expect(staleRead.body.lan.seats.black.claimed).toBe(false);

    // 但写操作会拿到可识别的 LAN_SEAT_REVOKED。
    expect(
      (
        await api()
          .post(`/api/v1/games/${gameId}/resign`)
          .set("authorization", `Bearer ${guest.seat.token}`)
          .send({ expectedRevision: 0 })
          .expect(401)
      ).body.error.code,
    ).toBe("LAN_SEAT_REVOKED");

    // 旧房间码彻底失效。
    expect(
      (
        await api()
          .post(`/api/v1/rooms/${created.roomCode}/join`)
          .send({})
          .expect(410)
      ).body.error.code,
    ).toBe("LAN_CODE_REVOKED");

    const rejoined = await join(reinvited.body.roomCode);
    expect(rejoined.seat.color).toBe("black");

    // Once the replacement occupies black, occupancy is true again; the old
    // token still receives an explicit revoked projection.
    const staleAfterReplacement = await api()
      .get(`/api/v1/games/${gameId}`)
      .set("authorization", `Bearer ${guest.seat.token}`)
      .expect(200);
    expect(staleAfterReplacement.body.lan.seats.black.claimed).toBe(true);
    expect(staleAfterReplacement.body.lan.viewer).toEqual({
      status: "revoked",
    });
    const replacementView = await api()
      .get(`/api/v1/games/${gameId}`)
      .set("authorization", `Bearer ${rejoined.seat.token}`)
      .expect(200);
    expect(replacementView.body.lan.viewer).toEqual({
      status: "valid",
      color: "black",
    });

    // A delayed retry carrying the old code cannot rotate the new invite or
    // revoke the freshly joined replacement.
    const staleRetry = await api()
      .post(`/api/v1/games/${gameId}/invite`)
      .set("authorization", `Bearer ${created.seat.token}`)
      .send({ expectedRevision: 0, expectedRoomCode: created.roomCode })
      .expect(409);
    expect(staleRetry.body.error.code).toBe("LAN_INVITE_STALE");
    await api()
      .get(`/api/v1/games/${gameId}`)
      .set("authorization", `Bearer ${rejoined.seat.token}`)
      .expect(200);
  });

  it("客人不能重新邀请", async () => {
    const { created, guest } = await seated();
    expect(
      (
        await api()
          .post(`/api/v1/games/${created.game.id}/invite`)
          .set("authorization", `Bearer ${guest.seat.token}`)
          .send({
            expectedRevision: 0,
            expectedRoomCode: created.roomCode,
          })
          .expect(403)
      ).body.error.code,
    ).toBe("LAN_NOT_YOUR_SEAT");
  });

  it("合法着法对两个座位与匿名读取完全一致，不做按座位过滤", async () => {
    const { created, guest } = await seated();
    const path = `/api/v1/games/${created.game.id}/legal-moves`;
    const [anonymous, asHost, asGuest] = await Promise.all([
      api().get(path).expect(200),
      api().get(path).set("authorization", `Bearer ${created.seat.token}`),
      api().get(path).set("authorization", `Bearer ${guest.seat.token}`),
    ]);
    expect(asHost.body).toEqual(anonymous.body);
    expect(asGuest.body).toEqual(anonymous.body);
  });

  it("活动局对两个座位都隐藏 Seed 与暗子身份，且不回传令牌", async () => {
    const { created, guest } = await seated();
    for (const token of [created.seat.token, guest.seat.token]) {
      const view = await api()
        .get(`/api/v1/games/${created.game.id}`)
        .set("authorization", `Bearer ${token}`)
        .expect(200);
      expect(view.body.seed).toBeNull();
      expect(JSON.stringify(view.body)).not.toContain(token);
      for (const piece of view.body.board) {
        if (!piece.faceUp) expect(piece.identity).toBeUndefined();
      }
    }
  });

  it("没走过棋的一方不能发起悔棋请求", async () => {
    const { created, guest } = await seated();
    const gameId = created.game.id;
    const first = await api().get(`/api/v1/games/${gameId}/legal-moves`);
    await api()
      .post(`/api/v1/games/${gameId}/moves`)
      .set("authorization", `Bearer ${created.seat.token}`)
      .send(moveBody(first.body.moves[0], 0))
      .expect(200);

    // 红方刚走完，现在轮到黑方。黑方还没走过，不能要求「悔棋」——
    // 那实际上会撤掉红方的棋，而红方的提示只会说「对手请求悔棋」。
    expect(
      (
        await api()
          .post(`/api/v1/games/${gameId}/undo-request`)
          .set("authorization", `Bearer ${guest.seat.token}`)
          .send({ expectedRevision: 1 })
          .expect(403)
      ).body.error.code,
    ).toBe("LAN_NOT_YOUR_SEAT");
  });

  it("终局后双方仍持有座位，房主不会被自己的对局挡在门外", async () => {
    const { created, guest } = await seated();
    const gameId = created.game.id;
    await api()
      .post(`/api/v1/games/${gameId}/resign`)
      .set("authorization", `Bearer ${created.seat.token}`)
      .send({ expectedRevision: 0 })
      .expect(200);

    for (const seat of [created.seat, guest.seat]) {
      const view = await api()
        .get(`/api/v1/games/${gameId}`)
        .set("authorization", `Bearer ${seat.token}`)
        .expect(200);
      // 终局 ≠ 被移出：座位仍算已认领，否则结算页会误报「你已被移出对局」。
      expect(view.body.lan.seats[seat.color].claimed).toBe(true);
      expect(view.body.status.phase).toBe("finished");
      // 终局后不再展示已作废的房间码。
      expect(view.body.lan.roomCode).toBeUndefined();
    }

    // 终局后不能再邀请：那只会生成一个走不通的房间码，重赛应该另开一局。
    expect(
      (
        await api()
          .post(`/api/v1/games/${gameId}/invite`)
          .set("authorization", `Bearer ${created.seat.token}`)
          .send({
            expectedRevision: 1,
            expectedRoomCode: created.roomCode,
          })
          .expect(404)
      ).body.error.code,
    ).toBe("LAN_ROOM_NOT_FOUND");

    // 房间码同时失效，避免有人加入一局已经结束的棋。
    expect(
      (
        await api()
          .post(`/api/v1/rooms/${created.roomCode}/join`)
          .send({})
          .expect(410)
      ).body.error.code,
    ).toBe("LAN_CODE_REVOKED");
  });

  it("Seed 规则与 POST /games 一致，避免同一 Seed 开出不同局面", async () => {
    // 两个端点都必须 trim 并限制在 80 字符内，否则同一个 Seed 会因入口不同
    // 而产生不同的布子。
    const withSpaces = await api()
      .post("/api/v1/rooms")
      .send({ seed: "  opening-42  " })
      .expect(201);
    await api()
      .post(`/api/v1/games/${withSpaces.body.game.id}/resign`)
      .set("authorization", `Bearer ${withSpaces.body.seat.token}`)
      .send({ expectedRevision: 0 })
      .expect(200);
    const finished = await api()
      .get(`/api/v1/games/${withSpaces.body.game.id}`)
      .expect(200);
    expect(finished.body.seed).toBe("opening-42");

    await api()
      .post("/api/v1/rooms")
      .send({ seed: "x".repeat(81) })
      .expect(400);
  });

  it("房间已满时不会在 store 里留下孤儿对局", async () => {
    const smallStore = new GameStore();
    const smallRooms = new LanRoomManager({
      maxRooms: 1,
      hasGame: (gameId) => smallStore.has(gameId),
    });
    const app = createApp({
      store: smallStore,
      aiProvider,
      lanRoomManager: smallRooms,
      random: () => 0.1,
    });
    const local = createServer(app);
    await new Promise<void>((resolve, reject) => {
      local.once("error", reject);
      local.listen(0, "127.0.0.1", () => resolve());
    });
    try {
      await request(local).post("/api/v1/rooms").send({}).expect(201);
      expect(smallStore.size).toBe(1);

      // 容量在建局之前就检查：被拒绝的请求不应该消耗对局名额，
      // 否则每次重试都会漏掉一个只能等 24 小时 TTL 的对局。
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await request(local).post("/api/v1/rooms").send({}).expect(503);
      }
      expect(smallStore.size).toBe(1);
    } finally {
      await new Promise<void>((resolve) => local.close(() => resolve()));
    }
  });

  it("Agent 与 ai-move 端点对局域网对局报 NOT_AI_GAME", async () => {
    const { created } = await seated();
    expect(
      (
        await api()
          .post(`/api/v1/games/${created.game.id}/ai-move`)
          .send({ expectedRevision: 0 })
          .expect(422)
      ).body.error.code,
    ).toBe("NOT_AI_GAME");
  });
});
