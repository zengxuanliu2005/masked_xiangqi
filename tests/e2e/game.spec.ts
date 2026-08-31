import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type {
  AgentSessionState,
  AgentSessionStatus,
  FinishReason,
  PublicGameState,
} from "../../shared/contracts";

const storageKey = "masked-xiangqi:last-game-id";

const fixtureGame = (
  overrides: Partial<PublicGameState> = {},
): PublicGameState => ({
  id: "browser-fixture",
  seed: null,
  mode: "standard",
  allowDraw: true,
  allowUndo: true,
  canUndo: false,
  matchType: "human-human",
  aiModel: null,
  revision: 0,
  turn: "red",
  moveNumber: 0,
  players: { player1: "red", player2: "black" },
  status: { phase: "active", winner: null, reason: null },
  check: null,
  board: [
    {
      id: "black-general",
      position: { x: 4, y: 0 },
      faceUp: true,
      publicIdentity: { color: "black", type: "general" },
      identity: { color: "black", type: "general" },
      controller: "black",
    },
    {
      id: "covered-pawn",
      position: { x: 0, y: 6 },
      faceUp: false,
      publicIdentity: { color: "red", type: "pawn" },
      controller: "red",
    },
    {
      id: "red-general",
      position: { x: 4, y: 9 },
      faceUp: true,
      publicIdentity: { color: "red", type: "general" },
      identity: { color: "red", type: "general" },
      controller: "red",
    },
  ],
  captured: { red: [], black: [] },
  lastMove: null,
  createdAt: "2026-08-31T00:00:00.000Z",
  ...overrides,
});

const sessionFixture = (
  gameId: string,
  status: AgentSessionStatus,
  overrides: Partial<AgentSessionState> = {},
): AgentSessionState => ({
  sessionId: "00000000-0000-4000-8000-000000000001",
  gameId,
  status,
  terminal: "terminal",
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z",
  lastActivityAt: "2026-08-31T00:00:00.000Z",
  error: null,
  logPath: ".local/agent-logs/browser-fixture.jsonl",
  ...overrides,
});

const installGameRoutes = async (
  page: import("@playwright/test").Page,
  game: PublicGameState,
  getSession?: () => AgentSessionState,
) => {
  await page.route(`**/api/v1/games/${game.id}/legal-moves*`, (route) =>
    route.fulfill({
      json: {
        gameId: game.id,
        revision: game.revision,
        turn: game.turn,
        moves: [],
      },
    }),
  );
  if (getSession) {
    await page.route(`**/api/v1/games/${game.id}/agent-session`, (route) =>
      route.fulfill({ json: getSession() }),
    );
  }
  await page.route(`**/api/v1/games/${game.id}`, (route) =>
    route.fulfill({ json: game }),
  );
};

const resumeFixtureGame = async (
  page: import("@playwright/test").Page,
  gameId: string,
) => {
  await page.goto("/");
  await page.evaluate(
    ([key, id]) => window.localStorage.setItem(key, id),
    [storageKey, gameId],
  );
  await page.reload();
  await page.getByRole("button", { name: "恢复上局" }).click();
  await expect(page.getByRole("region", { name: "象棋棋盘" })).toBeVisible();
};

const startHumanGame = async (page: import("@playwright/test").Page) => {
  const start = page.getByRole("button", { name: /开始游戏/ });
  if (await start.isVisible()) await start.click();
  await page.getByRole("button", { name: /选择双人对战/ }).click();
  await expect(page.getByRole("dialog", { name: "设置这一局" })).toBeVisible();
  await page.getByRole("button", { name: /确认开局/ }).click();
  await expect(page.getByRole("region", { name: "象棋棋盘" })).toBeVisible();
};

test("首页、设置、键盘棋盘与结算流程可访问", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /一步以前/ })).toBeVisible();
  await expect(page.getByText("9×10")).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.getByRole("button", { name: /开始游戏/ }).click();
  const chooseHuman = page.getByRole("button", { name: /选择双人对战/ });
  await chooseHuman.click();
  const setup = page.getByRole("dialog", { name: "设置这一局" });
  await expect(setup).toBeVisible();
  await expect(
    page.getByRole("button", { name: "关闭本局设置" }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: /确认开局/ })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(setup).toBeHidden();
  await expect(chooseHuman).toBeFocused();

  await startHumanGame(page);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  const roving = page.locator('.board-hit[tabindex="0"]');
  await roving.focus();
  const before = await page.evaluate(() =>
    document.activeElement?.getAttribute("data-testid"),
  );
  await page.keyboard.press("ArrowLeft");
  const after = await page.evaluate(() =>
    document.activeElement?.getAttribute("data-testid"),
  );
  expect(after).not.toBe(before);

  await page.getByRole("button", { name: "当前方认输" }).click();
  await page.getByRole("button", { name: /确认红方认输/ }).click();
  const result = page.getByRole("dialog", { name: /胜|和棋/ });
  await expect(result).toBeVisible();
  await expect(result.getByText(/^MX-[A-F0-9]{12}$/)).toBeVisible();
  await expect(
    result.getByRole("button", { name: "同 Seed 再来" }),
  ).toBeFocused();
  expect(
    (await new AxeBuilder({ page }).include(".result-dialog").analyze())
      .violations,
  ).toEqual([]);

  await result.getByRole("button", { name: "查看最终棋盘" }).click();
  await expect(
    page.getByRole("button", { name: "重新打开结算" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "重新打开结算" }).click();
  await expect(result).toBeVisible();
  await result.getByRole("button", { name: "同 Seed 再来" }).click();
  await expect(result).toBeHidden();
  await expect(page.getByText("进行中保密 · 终局后公开")).toBeVisible();
});

test("新手教学可亲手完成选中、合法落点与揭面", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "新手教学" }).click();
  await expect(
    page.getByRole("heading", { name: "暗子是怎么翻面的？" }),
  ).toBeVisible();

  await page.getByTestId("square-4-6").click();
  await expect(page.getByText("再点棋盘上的绿色落点")).toBeVisible();
  await expect(page.getByTestId("square-4-5")).toHaveAttribute(
    "aria-label",
    /合法落点/,
  );
  await page.getByTestId("square-4-5").click();
  await expect(page.getByText("它真正的身份是黑車")).toBeVisible();
  await expect(page.getByTestId("square-4-5")).toHaveAttribute(
    "aria-label",
    /黑方車/,
  );
  await page.getByRole("button", { name: /我明白了，开始游戏/ }).click();
  await expect(
    page.getByRole("heading", { name: "这局，和谁下？" }),
  ).toBeVisible();
});

test("真实合法落子可提交和悔棋，reduced-motion 下不创建移动层", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "真实 API 落子回归固定在 Chromium");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await startHumanGame(page);
  const gameId = await page.evaluate(
    (key) => localStorage.getItem(key),
    storageKey,
  );
  expect(gameId).toBeTruthy();
  const move = await page.evaluate(async (id) => {
    const response = await fetch(`/api/v1/games/${id}/legal-moves`);
    return (await response.json()).moves[0] as {
      from: { x: number; y: number };
      to: { x: number; y: number };
    };
  }, gameId!);

  await page.getByTestId(`square-${move.from.x}-${move.from.y}`).click();
  await page.getByTestId(`square-${move.to.x}-${move.to.y}`).click();
  await expect(page.getByTestId("motion-piece")).toHaveCount(0);
  await expect
    .poll(async () =>
      page.evaluate(async (id) => {
        const response = await fetch(`/api/v1/games/${id}`);
        return (await response.json()).revision as number;
      }, gameId!),
    )
    .toBe(1);
  await expect(page.getByRole("button", { name: "悔棋" })).toBeEnabled();
  await page.getByRole("button", { name: "悔棋" }).click();
  await expect
    .poll(async () =>
      page.evaluate(async (id) => {
        const response = await fetch(`/api/v1/games/${id}`);
        const game = await response.json();
        return [game.revision, game.moveNumber];
      }, gameId!),
    )
    .toEqual([2, 0]);
});

test("慢网络下重复确认开局只创建一局", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "重复提交竞态固定在 Chromium");
  let createCalls = 0;
  await page.route("**/api/v1/games", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    createCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fallback();
  });
  await page.goto("/");
  await page.getByRole("button", { name: /开始游戏/ }).click();
  await page.getByRole("button", { name: /选择双人对战/ }).click();
  const confirm = page.getByRole("button", { name: /确认开局/ });

  await confirm.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });

  await expect(page.getByRole("region", { name: "象棋棋盘" })).toBeVisible();
  expect(createCalls).toBe(1);
});

test("刷新恢复时玩家执红或执黑都位于棋盘下方", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "棋盘方向矩阵固定在 Chromium");
  for (const side of ["red", "black"] as const) {
    await page.goto("/");
    const id = await page.evaluate(async (player1Side) => {
      const response = await fetch("/api/v1/games", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ matchType: "human-human", player1Side }),
      });
      const game = await response.json();
      localStorage.setItem("masked-xiangqi:last-game-id", game.id);
      return game.id as string;
    }, side);
    await page.reload();
    await page.getByRole("button", { name: "恢复上局" }).click();
    await expect(
      page.getByRole("region", { name: "象棋棋盘" }),
    ).toHaveAttribute("data-bottom-side", side);
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "覆子 MASKED XIANGQI" }).click();
    await expect(page.getByRole("heading", { name: /一步以前/ })).toBeVisible();
    expect(id).toBeTruthy();
  }
});

test("五种终局原因都显示完整结算，复制拒绝有回退提示", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "终局语义矩阵固定在 Chromium");
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("denied")) },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: () => false,
    });
  });
  const labels: Record<FinishReason, string> = {
    checkmate: "将死",
    stalemate: "困毙",
    "general-captured": "主帅被吃",
    resignation: "认输",
    "threefold-repetition": "三次重复，和棋",
  };
  let currentReason: FinishReason = "checkmate";
  const game = fixtureGame({
    id: "finished-fixture",
    seed: "MX-E2E-FINISHED",
    revision: 9,
    status: { phase: "finished", winner: "red", reason: currentReason },
  });
  await page.route(`**/api/v1/games/${game.id}`, (route) =>
    route.fulfill({
      json: {
        ...game,
        status: {
          phase: "finished",
          winner: currentReason === "threefold-repetition" ? null : "red",
          reason: currentReason,
        },
      },
    }),
  );

  for (const reason of Object.keys(labels) as FinishReason[]) {
    currentReason = reason;
    await page.goto("/");
    await page.evaluate(
      ([key, id]) => localStorage.setItem(key, id),
      [storageKey, game.id],
    );
    await page.reload();
    await page.getByRole("button", { name: "恢复上局" }).click();
    const result = page.getByRole("dialog", {
      name: reason === "threefold-repetition" ? "和棋" : "红方胜",
    });
    await expect(result).toBeVisible();
    await expect(
      result.getByText(labels[reason], { exact: true }).first(),
    ).toBeVisible();
    if (reason === "checkmate") {
      await result.getByRole("button", { name: "查看最终棋盘" }).click();
      await page.getByRole("button", { name: "复制 Seed" }).click();
      await expect(
        page.getByRole("alert").filter({ hasText: "复制失败" }).first(),
      ).toBeVisible();
      await page.getByRole("button", { name: "重新打开结算" }).click();
    }
    await result.getByRole("button", { name: "回到首页" }).click();
  }
});

test("控制器八种状态按轮询更新且活动局离开会停止 Runner", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "控制器状态矩阵固定在 Chromium");
  const statuses: AgentSessionStatus[] = [
    "starting",
    "waiting-human",
    "thinking",
    "submitting",
    "paused",
    "finished",
    "stopped",
    "exited",
  ];
  const labels = [
    "启动中",
    "等待人类",
    "思考中",
    "提交中",
    "已暂停",
    "已结束",
    "已停止",
    "已退出",
  ];
  let statusIndex = 0;
  let stopCalls = 0;
  const game = fixtureGame({
    id: "controller-fixture",
    matchType: "human-ai",
    aiModel: "local-model",
    players: { player1: "red", player2: "black" },
  });
  await installGameRoutes(page, game, () =>
    sessionFixture(
      game.id,
      statuses[Math.min(statusIndex++, statuses.length - 1)],
    ),
  );
  await page.route(
    `**/api/v1/games/${game.id}/agent-session`,
    async (route) => {
      if (route.request().method() === "DELETE") {
        stopCalls += 1;
        await route.fulfill({ json: sessionFixture(game.id, "stopped") });
        return;
      }
      await route.fallback();
    },
  );
  await resumeFixtureGame(page, game.id);
  const card = page.locator(".agent-controller-card");
  for (const label of labels) {
    await expect(card.getByRole("status")).toContainText(label, {
      timeout: 3_000,
    });
  }

  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "← 返回" }).click();
  await expect(
    page.getByRole("heading", { name: "这局，和谁下？" }),
  ).toBeVisible();
  await expect.poll(() => stopCalls).toBe(1);
});

test("终端失败显示恢复操作，复制拒绝、重启与停止均可恢复状态", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "控制器恢复交互固定在 Chromium");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("denied")) },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: () => false,
    });
  });
  const game = fixtureGame({
    id: "paused-controller",
    matchType: "human-ai",
    aiModel: "local-model",
  });
  let current = sessionFixture(game.id, "paused", {
    terminal: null,
    error: "终端启动失败",
    manualCommand:
      "MASKED_XIANGQI_AGENT_SESSION_FILE='/path with spaces/session.json' node runner",
  });
  await installGameRoutes(page, game, () => current);
  await page.route(
    `**/api/v1/games/${game.id}/agent-session/restart`,
    async (route) => {
      current = sessionFixture(game.id, "starting");
      await route.fulfill({ status: 201, json: current });
    },
  );
  await page.route(
    `**/api/v1/games/${game.id}/agent-session`,
    async (route) => {
      if (route.request().method() === "DELETE") {
        current = sessionFixture(game.id, "stopped");
        await route.fulfill({ json: current });
        return;
      }
      await route.fallback();
    },
  );
  await resumeFixtureGame(page, game.id);
  await expect(
    page.getByRole("alert").filter({ hasText: "终端启动失败" }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "复制命令" }).click();
  await expect(page.getByText("复制失败，请手动选中。")).toBeVisible();
  await page.getByRole("button", { name: "恢复控制器" }).click();
  await expect(
    page.locator(".agent-controller-card").getByRole("status"),
  ).toContainText("启动中");
  await page.getByRole("button", { name: "停止控制器" }).click();
  await expect(
    page.locator(".agent-controller-card").getByRole("status"),
  ).toContainText("已停止");
});

test("固定视口均无横向页面溢出", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "布局矩阵在稳定 Chromium 基线上执行");
  const viewports = [
    [1440, 900],
    [1366, 768],
    [1024, 768],
    [901, 700],
    [900, 700],
    [899, 700],
    [768, 1024],
    [390, 844],
    [375, 667],
    [320, 568],
    [844, 390],
    [667, 375],
    [568, 320],
  ] as const;
  for (const [width, height] of viewports) {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow, `${width}×${height}`).toBeLessThanOrEqual(1);
  }
});

test("568×320 横屏结算内容可滚动到全部操作", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "短横屏在 Chromium 布局基线上执行");
  await page.setViewportSize({ width: 568, height: 320 });
  await page.goto("/");
  await startHumanGame(page);
  await page.getByRole("button", { name: "当前方认输" }).click();
  await page.getByRole("button", { name: /确认红方认输/ }).click();
  const result = page.getByRole("dialog", { name: /胜|和棋/ });
  await expect(result).toBeVisible();
  await result
    .getByRole("button", { name: "回到首页" })
    .scrollIntoViewIfNeeded();
  await expect(result.getByRole("button", { name: "回到首页" })).toBeVisible();
});
