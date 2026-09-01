import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { CreateGameRequest } from "../shared/contracts";
import { ApiClientError, gameApi } from "../src/api";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("浏览器 API 客户端", () => {
  it("创建游戏类型排除必须通过房间端点建立的 LAN 对局", () => {
    expectTypeOf<CreateGameRequest["matchType"]>().toEqualTypeOf<
      "human-human" | "human-ai"
    >();
  });

  it("为全部 REST 操作构造稳定路径、方法、JSON 与取消信号", async () => {
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;

    await gameApi.createGame({
      matchType: "human-ai",
      mode: "capture-general",
      aiModel: "qwen",
      seed: "test seed",
    });
    await gameApi.getAiModels();
    await gameApi.getGame("game id", signal);
    await gameApi.getLegalMoves("game id", "piece/一", signal);
    await gameApi.getLegalMoves("game id");
    await gameApi.move("game id", { x: 0, y: 9 }, { x: 0, y: 8 }, 3);
    await gameApi.undo("game id", 4);
    await gameApi.resign("game id", 5);
    await gameApi.aiMove("game id", 6);
    await gameApi.createAgentSession("game id");
    await gameApi.getAgentSession("game id", signal);
    await gameApi.restartAgentSession("game id");
    await gameApi.stopAgentSession("game id");
    await gameApi.createRoom({ mode: "standard" });
    await gameApi.joinRoom("abc 234");
    await gameApi.reinvite("game id", 7, "ABC234", "seat-token");
    await gameApi.requestUndo("game id", 7, "seat-token");
    await gameApi.resolveUndo(
      "game id",
      7,
      "undo-request-id",
      true,
      "seat-token",
    );
    await gameApi.getNetwork(signal);
    await gameApi.setNetworkMode("lan");

    expect(fetchMock).toHaveBeenCalledTimes(20);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/games",
      "/api/v1/ai/models",
      "/api/v1/games/game id",
      "/api/v1/games/game id/legal-moves?pieceId=piece%2F%E4%B8%80",
      "/api/v1/games/game id/legal-moves",
      "/api/v1/games/game id/moves",
      "/api/v1/games/game id/undo",
      "/api/v1/games/game id/resign",
      "/api/v1/games/game id/ai-move",
      "/api/v1/games/game id/agent-session",
      "/api/v1/games/game id/agent-session",
      "/api/v1/games/game id/agent-session/restart",
      "/api/v1/games/game id/agent-session",
      "/api/v1/rooms",
      "/api/v1/rooms/abc%20234/join",
      "/api/v1/games/game id/invite",
      "/api/v1/games/game id/undo-request",
      "/api/v1/games/game id/undo-request/resolve",
      "/api/v1/network",
      "/api/v1/network",
    ]);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[5][1]?.body))).toEqual({
      from: { x: 0, y: 9 },
      to: { x: 0, y: 8 },
      expectedRevision: 3,
    });
    expect(fetchMock.mock.calls[2][1]?.signal).toBe(signal);
    expect(fetchMock.mock.calls[9][1]).toMatchObject({ method: "POST" });
    expect(fetchMock.mock.calls[9][1]?.headers).toEqual({});
    expect(fetchMock.mock.calls[12][1]).toMatchObject({ method: "DELETE" });

    // 座位令牌只走 Authorization 头，绝不进 URL 或请求体。
    expect(fetchMock.mock.calls[15][1]?.headers).toMatchObject({
      authorization: "Bearer seat-token",
    });
    expect(String(fetchMock.mock.calls[15][0])).not.toContain("seat-token");
    expect(JSON.parse(String(fetchMock.mock.calls[15][1]?.body))).toEqual({
      expectedRevision: 7,
      expectedRoomCode: "ABC234",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[17][1]?.body))).toEqual({
      expectedRevision: 7,
      requestId: "undo-request-id",
      accept: true,
    });
    // 无令牌的调用不会带上空的 Authorization 头。
    expect(fetchMock.mock.calls[13][1]?.headers).toEqual({
      "content-type": "application/json",
    });
    expect(fetchMock.mock.calls[18][1]?.signal).toBe(signal);
  });

  it("保留服务端结构化错误的状态、代码、消息与详情", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            error: {
              code: "STALE_REVISION",
              message: "局面已更新。",
              details: { actualRevision: 7 },
            },
          },
          409,
        ),
      ),
    );

    await expect(gameApi.undo("game", 6)).rejects.toEqual(
      expect.objectContaining<ApiClientError>({
        name: "ApiClientError",
        status: 409,
        code: "STALE_REVISION",
        message: "局面已更新。",
        details: { actualRevision: 7 },
      }),
    );
  });

  it("错误载荷缺字段时使用稳定的客户端兜底", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}, 500)),
    );

    await expect(gameApi.getAiModels()).rejects.toMatchObject({
      status: 500,
      code: "REQUEST_FAILED",
      message: "请求失败，请稍后重试。",
    });
  });
});
