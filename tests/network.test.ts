import { createServer, type Server } from "node:http";
import type { NetworkInterfaceInfo } from "node:os";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app";
import { GameStore } from "../engine/store";
import {
  bindHostFor,
  createNetworkController,
  localAddresses,
} from "../server/network";
import type { AiProvider } from "../server/ollama";

const aiProvider = {
  listModels: vi.fn(async () => []),
  chooseMove: vi.fn(),
} as unknown as AiProvider;

const interfacesWith = (addresses: [string, boolean][]) =>
  (() => ({
    en0: addresses.map(([address, internal]) => ({
      address,
      family: "IPv4",
      internal,
      netmask: "255.255.255.0",
      mac: "00:00:00:00:00:00",
      cidr: null,
    })) as unknown as NetworkInterfaceInfo[],
  })) as unknown as typeof import("node:os").networkInterfaces;

describe("监听地址控制器", () => {
  it("按模式选择绑定地址", () => {
    expect(bindHostFor("loopback")).toBe("127.0.0.1");
    // 显式 0.0.0.0，避免裸 listen(port) 连 :: 一起放开。
    expect(bindHostFor("lan")).toBe("0.0.0.0");
  });

  it("只公布网关会放行的私有地址", () => {
    const read = interfacesWith([
      ["192.168.1.5", false],
      ["127.0.0.1", true],
      // CGNAT / Tailscale：可达但不在局域网白名单内，公布出去会得到 403。
      ["100.90.97.98", false],
      ["8.8.8.8", false],
    ]);
    expect(localAddresses(read)).toEqual(["192.168.1.5"]);
  });

  it("切换模式时重新绑定，并在失败时回退到原模式", async () => {
    const bindings: string[] = [];
    let failNext = false;
    const controller = createNetworkController({
      port: 1234,
      initialMode: "loopback",
      interfaces: interfacesWith([["192.168.1.5", false]]),
      listen: async (host) => {
        if (failNext) {
          failNext = false;
          throw new Error("EADDRINUSE");
        }
        bindings.push(host);
        return { close: (cb?: () => void) => cb?.() } as unknown as Server;
      },
    });

    await controller.start();
    expect(controller.mode()).toBe("loopback");
    expect(bindings).toEqual(["127.0.0.1"]);
    expect(controller.status()).toMatchObject({
      mode: "loopback",
      targetMode: "loopback",
      pending: false,
      listening: true,
    });

    await controller.setMode("lan");
    expect(controller.mode()).toBe("lan");
    expect(bindings).toEqual(["127.0.0.1", "0.0.0.0"]);
    expect(controller.status().addresses).toEqual(["192.168.1.5"]);

    // 绑定失败时保持原模式并记录原因，而不是留下无监听的服务。
    failNext = true;
    const status = await controller.setMode("loopback");
    expect(controller.mode()).toBe("lan");
    expect(status.error).toContain("EADDRINUSE");
    expect(bindings).toEqual(["127.0.0.1", "0.0.0.0", "0.0.0.0"]);
  });

  it("并发切换进入同一 FIFO，任何时刻最多保留一个 listener", async () => {
    const trace: string[] = [];
    let activeListeners = 0;
    let maximumListeners = 0;
    const controller = createNetworkController({
      port: 1234,
      initialMode: "loopback",
      interfaces: interfacesWith([["192.168.1.5", false]]),
      listen: async (host) => {
        trace.push(`listen:${host}`);
        activeListeners += 1;
        maximumListeners = Math.max(maximumListeners, activeListeners);
        let closed = false;
        return {
          close: (callback?: () => void) => {
            trace.push(`close:${host}`);
            if (!closed) {
              closed = true;
              activeListeners -= 1;
            }
            callback?.();
          },
        } as unknown as Server;
      },
    });

    await controller.start();
    const toLan = controller.setMode("lan");
    const backToLoopback = controller.setMode("loopback");
    expect(controller.status()).toMatchObject({
      mode: "loopback",
      targetMode: "loopback",
      pending: true,
      listening: true,
    });

    await Promise.all([toLan, backToLoopback]);
    expect(trace).toEqual([
      "listen:127.0.0.1",
      "close:127.0.0.1",
      "listen:0.0.0.0",
      "close:0.0.0.0",
      "listen:127.0.0.1",
    ]);
    expect(maximumListeners).toBe(1);
    expect(activeListeners).toBe(1);
    expect(controller.status()).toMatchObject({
      mode: "loopback",
      targetMode: "loopback",
      pending: false,
      listening: true,
    });

    await controller.close();
    expect(activeListeners).toBe(0);
    expect(controller.status().listening).toBe(false);
  });

  it("重绑不会被长请求拖住，超过宽限期就强制断开", async () => {
    let closeCalled = false;
    let forced = false;
    const controller = createNetworkController({
      port: 1234,
      initialMode: "loopback",
      closeGraceMs: 20,
      interfaces: interfacesWith([["192.168.1.5", false]]),
      listen: async () =>
        ({
          // close() never calls back: mimics an in-flight ai-move stream.
          close: () => {
            closeCalled = true;
          },
          closeIdleConnections: () => undefined,
          closeAllConnections: () => {
            forced = true;
          },
        }) as unknown as Server,
    });
    await controller.start();
    await controller.setMode("lan");
    expect(closeCalled).toBe(true);
    // 关键：没有卡住，而且旧连接被强制关掉，端口不会长时间无人监听。
    expect(forced).toBe(true);
    expect(controller.mode()).toBe("lan");
    expect(controller.status().listening).toBe(true);
  });

  it("关闭辅助方法抛错也不会卡死监听队列", async () => {
    const controller = createNetworkController({
      port: 1234,
      initialMode: "loopback",
      closeGraceMs: 5,
      interfaces: interfacesWith([["192.168.1.5", false]]),
      listen: async () =>
        ({
          close: () => undefined,
          closeIdleConnections: () => {
            throw new Error("idle helper failed");
          },
          closeAllConnections: () => {
            throw new Error("force helper failed");
          },
        }) as unknown as Server,
    });

    await controller.start();
    await expect(controller.close()).resolves.toBeUndefined();
    expect(controller.status()).toMatchObject({
      pending: false,
      listening: false,
    });
  });

  it("关机关闭是终态，晚到的模式切换不能重新打开 listener", async () => {
    const bindings: string[] = [];
    let activeListeners = 0;
    const controller = createNetworkController({
      port: 1234,
      initialMode: "loopback",
      interfaces: interfacesWith([["192.168.1.5", false]]),
      listen: async (host) => {
        bindings.push(host);
        activeListeners += 1;
        let closed = false;
        return {
          close: (callback?: () => void) => {
            if (!closed) {
              closed = true;
              activeListeners -= 1;
            }
            callback?.();
          },
        } as unknown as Server;
      },
    });

    await controller.start();
    const closing = controller.close();
    // Mirrors a POST /network response `finish` callback delivered after
    // SIGTERM already started the controller shutdown.
    const lateSwitch = controller.setMode("lan");
    await Promise.all([closing, lateSwitch]);

    expect(bindings).toEqual(["127.0.0.1"]);
    expect(activeListeners).toBe(0);
    expect(controller.status()).toMatchObject({
      mode: "loopback",
      targetMode: "loopback",
      pending: false,
      listening: false,
    });
    await expect(controller.setMode("lan")).resolves.toMatchObject({
      listening: false,
    });
    await expect(controller.start()).rejects.toThrow("监听控制器已经关闭");
  });

  it("新旧绑定都失败时不抛异常，而是如实报告没有监听", async () => {
    let failAll = false;
    const controller = createNetworkController({
      port: 1234,
      initialMode: "loopback",
      interfaces: interfacesWith([["192.168.1.5", false]]),
      listen: async (host) => {
        if (failAll) throw new Error(`EADDRINUSE ${host}`);
        return { close: (cb?: () => void) => cb?.() } as unknown as Server;
      },
    });
    await controller.start();
    expect(controller.status().listening).toBe(true);

    // 调用方是 response.on("finish") 里的即发即忘处理器；如果这里 reject，
    // 在 Node 默认设置下会直接杀掉进程，而 status() 还宣称模式正常。
    failAll = true;
    await expect(controller.setMode("lan")).resolves.toMatchObject({
      listening: false,
    });
    expect(controller.status().error).toContain("恢复原监听也失败");
  });

  it("loopback 模式不公布任何局域网地址", async () => {
    const controller = createNetworkController({
      port: 1234,
      initialMode: "loopback",
      interfaces: interfacesWith([["192.168.1.5", false]]),
      listen: async () =>
        ({ close: (cb?: () => void) => cb?.() }) as unknown as Server,
    });
    await controller.start();
    expect(controller.status().addresses).toEqual([]);
  });
});

describe("网络模式端点与本机专属限制", () => {
  let server: Server;

  const serve = async (
    mode: "loopback" | "lan",
    peerAddress = "127.0.0.1",
    store = new GameStore(),
  ) => {
    const app = createApp({
      store,
      aiProvider,
      networkMode: () => mode,
      remoteAddress: () => peerAddress,
      networkController: {
        status: () => ({
          mode,
          targetMode: mode,
          port: 3001,
          addresses: mode === "lan" ? ["192.168.1.5"] : [],
          error: null,
          pending: false,
          listening: true,
        }),
        setMode: vi.fn(async () => undefined),
      },
    });
    server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    return request(server);
  };

  afterEach(async () => {
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("局域网模式只放行服务器真实网卡 Host，仍拒绝其他私网、公网与域名", async () => {
    const api = await serve("lan");
    await api.get("/api/v1/health").set("host", "192.168.1.5:3001").expect(200);
    // 本机在两种模式下都必须继续可用。
    await api.get("/api/v1/health").set("host", "127.0.0.1:3001").expect(200);

    for (const host of [
      "10.0.0.7:3001",
      "8.8.8.8:3001",
      "evil.com",
      "192.168.1.5.evil.com",
    ]) {
      const refused = await api
        .get("/api/v1/health")
        .set("host", host)
        .expect(403);
      expect(refused.body.error.code).toBe("HOST_FORBIDDEN");
    }
  });

  it("局域网模式下 Agent 与 ai-move 端点仍然只限本机", async () => {
    const api = await serve("lan", "192.168.1.20");
    const lanHost = "192.168.1.5:3001";
    for (const call of [
      api.post("/api/v1/games/x/agent-session"),
      api.get("/api/v1/games/x/agent-session"),
      api.post("/api/v1/games/x/agent-session/restart"),
      api.delete("/api/v1/games/x/agent-session"),
      api.get("/api/v1/games/x/agent-session/runner"),
      api.post("/api/v1/games/x/ai-move"),
    ]) {
      const refused = await call.set("host", lanHost).expect(403);
      expect(refused.body.error.code).toBe("LOOPBACK_ONLY");
    }
  });

  it("局域网客人不能切换监听模式，也看不到房主的其他地址", async () => {
    const api = await serve("lan", "192.168.1.20");
    const refused = await api
      .post("/api/v1/network")
      .set("host", "192.168.1.5:3001")
      .send({ mode: "loopback" })
      .expect(403);
    expect(refused.body.error.code).toBe("LOOPBACK_ONLY");

    const guestView = await api
      .get("/api/v1/network")
      .set("host", "192.168.1.5:3001")
      .expect(200);
    expect(guestView.body).toMatchObject({ mode: "lan", addresses: [] });
  });

  it("局域网模式只接受来自服务自身的 Origin", async () => {
    const api = await serve("lan", "192.168.1.20");
    // 浏览器访问本服务时 Origin 主机与 Host 一致。
    await api
      .get("/api/v1/health")
      .set("host", "192.168.1.5:3001")
      .set("origin", "http://192.168.1.5:3001")
      .expect(200);

    // 同网段另一台设备上的页面：主机也是私有字面量，但不是本服务。
    // 放行它等于把 API 交给局域网里任何一个网页去跨域驱动。
    const foreign = await api
      .get("/api/v1/health")
      .set("host", "192.168.1.5:3001")
      .set("origin", "http://192.168.1.99:8080")
      .expect(403);
    expect(foreign.body.error.code).toBe("ORIGIN_FORBIDDEN");

    const otherPort = await api
      .get("/api/v1/health")
      .set("host", "192.168.1.5:3001")
      .set("origin", "http://192.168.1.5:8080")
      .expect(403);
    expect(otherPort.body.error.code).toBe("ORIGIN_FORBIDDEN");
  });

  it("非本机调用者会被告知无法切换监听模式", async () => {
    const api = await serve("lan", "192.168.1.20");
    const guest = await api
      .get("/api/v1/network")
      .set("host", "192.168.1.5:3001")
      .expect(200);
    // 客户端据此禁用开关，而不是让它点了必然 403。
    expect(guest.body.local).toBe(false);
  });

  it("公网 socket 对端即使伪造真实 LAN Host 也会被拒绝", async () => {
    const api = await serve("lan", "8.8.8.8");
    const refused = await api
      .get("/api/v1/health")
      .set("host", "192.168.1.5:3001")
      .expect(403);
    expect(refused.body.error.code).toBe("HOST_FORBIDDEN");
  });

  it("伪造 loopback Host 或代理头不能把远程对端变成本机", async () => {
    const api = await serve("lan", "192.168.1.20");
    const headers = {
      host: "127.0.0.1:3001",
      "x-forwarded-for": "127.0.0.1",
      "x-real-ip": "127.0.0.1",
      forwarded: "for=127.0.0.1;host=127.0.0.1",
    };
    const health = await api.get("/api/v1/health").set(headers).expect(403);
    expect(health.body.error.code).toBe("HOST_FORBIDDEN");

    for (const path of ["/api/v1/games", "/api/v1/rooms"]) {
      const refused = await api.post(path).set(headers).send({}).expect(403);
      expect(refused.body.error.code).toBe("LOOPBACK_ONLY");
    }
  });

  it("远程对端即使用真实 LAN Host 也不能创建游戏、房间或访问 AI", async () => {
    const api = await serve("lan", "192.168.1.20");
    const lanHost = "192.168.1.5:3001";
    for (const call of [
      api.post("/api/v1/games").send({ matchType: "human-human" }),
      api.post("/api/v1/rooms").send({}),
      api.get("/api/v1/ai/models"),
    ]) {
      const refused = await call.set("host", lanHost).expect(403);
      expect(refused.body.error.code).toBe("LOOPBACK_ONLY");
    }
  });

  it("远程对端能读取但不能改写既有的非 LAN 对局", async () => {
    const store = new GameStore();
    const game = store.create({
      mode: "capture-general",
      allowDraw: true,
      allowUndo: true,
      matchType: "human-human",
      player1Side: "red",
      aiModel: null,
      seed: "remote-write-boundary",
    });
    const api = await serve("lan", "192.168.1.20", store);
    const lanHost = "192.168.1.5:3001";
    const legal = await api
      .get(`/api/v1/games/${game.id}/legal-moves`)
      .set("host", lanHost)
      .expect(200);
    const first = legal.body.moves[0];

    for (const call of [
      api.post(`/api/v1/games/${game.id}/moves`).send({
        from: first.from,
        to: first.to,
        expectedRevision: 0,
      }),
      api.post(`/api/v1/games/${game.id}/resign`).send({ expectedRevision: 0 }),
      api.post(`/api/v1/games/${game.id}/undo`).send({ expectedRevision: 0 }),
    ]) {
      const refused = await call.set("host", lanHost).expect(403);
      expect(refused.body.error.code).toBe("LOOPBACK_ONLY");
    }
    expect(store.get(game.id)?.revision).toBe(0);
    expect(store.get(game.id)?.status.phase).toBe("active");
  });

  it("默认仅本机模式下拒绝任何局域网 Host", async () => {
    const api = await serve("loopback");
    const refused = await api
      .get("/api/v1/health")
      .set("host", "192.168.1.5:3001")
      .expect(403);
    expect(refused.body.error.code).toBe("HOST_FORBIDDEN");
  });

  it("切换请求先返回响应再重绑，避免掐断确认响应", async () => {
    const setMode = vi.fn(async () => undefined);
    const app = createApp({
      store: new GameStore(),
      aiProvider,
      networkMode: () => "loopback",
      networkController: {
        status: () => ({
          mode: "loopback",
          targetMode: "loopback",
          port: 3001,
          addresses: [],
          error: null,
          pending: false,
          listening: true,
        }),
        setMode,
      },
    });
    server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const accepted = await request(server)
      .post("/api/v1/network")
      .send({ mode: "lan" })
      .expect(200);
    expect(accepted.body).toMatchObject({
      mode: "loopback",
      targetMode: "lan",
      pending: true,
      listening: true,
      local: true,
    });
    // 响应写完之后才切换。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(setMode).toHaveBeenCalledWith("lan");
  });
});
