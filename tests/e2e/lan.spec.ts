import { expect, test, type Page } from "@playwright/test";

/**
 * Seat semantics only. Both contexts talk to the loopback listener, because
 * which interface the server is bound to is independent of seat behaviour —
 * the Host/rebinding rules are covered by the supertest suites instead.
 */
test.describe("局域网双人对战", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "双上下文矩阵固定在 Chromium，避免三倍浏览器开销",
  );

  const createRoom = async (page: Page) => {
    await page.goto("/");
    await page.getByRole("button", { name: /开始游戏/ }).click();
    await page.getByRole("button", { name: /创建房间/ }).click();
    await page.getByRole("button", { name: /确认开局/ }).click();
    await expect(page.getByRole("region", { name: "象棋棋盘" })).toBeVisible();
    return (await page.getByTestId("lan-room-code").textContent())!.trim();
  };

  const joinRoom = async (page: Page, code: string) => {
    await page.goto("/");
    await page.getByRole("button", { name: /开始游戏/ }).click();
    await page.getByRole("button", { name: /我有房间码/ }).click();
    await page.getByLabel("房间码").fill(code);
    await page.getByRole("button", { name: "加入对局", exact: true }).click();
    await expect(page.getByRole("region", { name: "象棋棋盘" })).toBeVisible();
  };

  test("邀请链接直达预填加入框并清除地址栏房间码", async ({ page }) => {
    await page.goto("/?room=abc-234");
    await expect(
      page.getByRole("dialog", { name: "加入局域网对局" }),
    ).toBeVisible();
    await expect(page.getByLabel("房间码")).toHaveValue("ABC234");
    await expect(page).toHaveURL(/\/$/);
  });

  /** Picks a genuinely legal move the way the existing regression test does. */
  const playFirstLegalMove = async (page: Page) => {
    const gameId = await page.evaluate(() =>
      localStorage.getItem("masked-xiangqi:last-game-id"),
    );
    const move = await page.evaluate(async (id) => {
      const response = await fetch(`/api/v1/games/${id}/legal-moves`);
      return (await response.json()).moves[0] as {
        from: { x: number; y: number };
        to: { x: number; y: number };
      };
    }, gameId!);
    await page.getByTestId(`square-${move.from.x}-${move.from.y}`).click();
    await page.getByTestId(`square-${move.to.x}-${move.to.y}`).click();
  };

  test("各自视角、只能走自己一方，落子会同步到对面设备", async ({
    browser,
  }) => {
    // Separate contexts are essential: a shared one would share the seat
    // record in localStorage and both pages would hold the same seat.
    const hostCtx = await browser.newContext();
    const guestCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const guest = await guestCtx.newPage();

    const code = await createRoom(host);
    expect(code).toMatch(/^[23456789A-HJ-NP-Z]{6}$/);
    await expect(host.locator(".lan-block strong")).toHaveText("等待对手加入");

    await joinRoom(guest, code);
    // Joining changes no revision, so this only appears if the poll picks up
    // room-state changes as well as moves.
    await expect(host.locator(".lan-presence")).toHaveText("对手在线", {
      timeout: 4_000,
    });
    await expect(host.locator(".lan-block")).toHaveCount(0);

    // Each device puts its own side at the bottom.
    const hostBottom = await host
      .locator("[data-bottom-side]")
      .getAttribute("data-bottom-side");
    const guestBottom = await guest
      .locator("[data-bottom-side]")
      .getAttribute("data-bottom-side");
    expect(hostBottom).not.toBe(guestBottom);

    // The room code is the host's to share; the guest never receives it.
    await expect(guest.locator(".lan-code-row")).toHaveCount(0);

    const red = hostBottom === "red" ? host : guest;
    const black = red === host ? guest : host;

    // Black cannot move on red's turn: every square is marked disabled.
    await expect(black.locator(".board-hit").first()).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await expect(red.locator(".board-hit").first()).toHaveAttribute(
      "aria-disabled",
      "false",
    );

    await playFirstLegalMove(red);

    // The opponent's device picks the move up through the existing poll.
    await expect(black.locator(".last-move-card")).not.toContainText(
      "尚未行棋",
      { timeout: 4_000 },
    );
    await expect(black.locator(".board-hit").first()).toHaveAttribute(
      "aria-disabled",
      "false",
      { timeout: 4_000 },
    );
  });

  test("悔棋需要对方同意，拒绝后局面不变", async ({ browser }) => {
    const hostCtx = await browser.newContext();
    const guestCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const guest = await guestCtx.newPage();

    const code = await createRoom(host);
    await joinRoom(guest, code);
    await expect(host.locator(".lan-presence")).toHaveText("对手在线", {
      timeout: 4_000,
    });

    const hostBottom = await host
      .locator("[data-bottom-side]")
      .getAttribute("data-bottom-side");
    const red = hostBottom === "red" ? host : guest;
    const black = red === host ? guest : host;

    await playFirstLegalMove(red);
    await expect(black.locator(".last-move-card")).not.toContainText(
      "尚未行棋",
      {
        timeout: 4_000,
      },
    );

    // Only the side that just moved may ask for it back.
    await expect(
      black.getByRole("button", { name: "请求悔棋" }),
    ).toBeDisabled();
    await red.getByRole("button", { name: "请求悔棋" }).click();

    await expect(black.locator(".lan-undo-prompt")).toContainText(
      "对手请求撤回",
      { timeout: 4_000 },
    );
    await black.getByRole("button", { name: "拒绝" }).click();

    // Declining clears the prompt on both devices and leaves the board alone.
    await expect(black.locator(".lan-undo-prompt")).toHaveCount(0);
    await expect(red.locator(".lan-undo-prompt")).toHaveCount(0, {
      timeout: 4_000,
    });
    await expect(black.locator(".last-move-card")).not.toContainText(
      "尚未行棋",
    );
  });

  test("多网卡邀请卡展示全部候选链接", async ({ page }) => {
    await page.route("**/api/v1/network", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          mode: "lan",
          targetMode: "lan",
          port: 3001,
          addresses: ["10.0.0.5", "192.168.1.5"],
          error: null,
          pending: false,
          listening: true,
          local: true,
        }),
      });
    });

    const code = await createRoom(page);
    await expect(
      page.getByText("请选择与对手处在同一网段的地址："),
    ).toBeVisible();
    for (const address of ["10.0.0.5", "192.168.1.5"]) {
      await expect(
        page.getByText(`http://${address}:3001/?room=${code}`),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: `复制 ${address} 邀请链接` }),
      ).toBeVisible();
    }
  });
});
