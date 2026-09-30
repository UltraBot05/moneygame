import { test, expect, type Page } from "@playwright/test";

/**
 * Browser smoke for the production UI (Section F). The landing page runs without a Worker
 * (signed-out state). Board screens use the dev-only hot-seat preview, which renders the real
 * game screen over game-core in the browser; full client-server E2E stays with QA-012.
 */

async function noDocumentScroll(page: Page): Promise<void> {
  const size = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight,
    viewWidth: innerWidth, viewHeight: innerHeight,
  }));
  expect(size.width).toBeLessThanOrEqual(size.viewWidth);
  expect(size.height).toBeLessThanOrEqual(size.viewHeight);
}

test("landing offers room creation and joining", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Money·Game");
  await expect(page.locator("h1")).toContainText("Money");
  await expect(page.getByRole("button", { name: "Create a private room" })).toBeVisible();
  await page.getByLabel("Room code").fill("abc123");
  await page.getByRole("button", { name: "Join with a code" }).click();
  await expect(page).toHaveURL(/\/r\/ABC123$/);
  await expect(page.getByRole("link", { name: "Sign in with Google" }).first()).toBeVisible();
});

for (const [width, height] of [[1920, 1080], [1440, 900]] as const) {
  test(`standard board fits ${width}x${height} and a turn plays`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/dev/preview?scene=start");
    await expect(page.getByRole("group", { name: "World Tour Standard board" })).toBeVisible();
    await expect(page.locator(".board-grid > .tile")).toHaveCount(40);
    await noDocumentScroll(page);
    await page.getByRole("button", { name: "Roll dice" }).first().click();
    await expect(page.locator(".turn-dice")).toContainText("rolled");
    await page.getByRole("tab", { name: /Game log/ }).click();
    await expect(page.locator(".log-line").first()).toContainText("rolled");
  });
}

test("grand board seats ten players without page scroll", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/dev/preview?board=grand&players=10");
  await expect(page.locator(".board-grid > .tile")).toHaveCount(52);
  await expect(page.locator(".player-row")).toHaveCount(10);
  await noDocumentScroll(page);
  await page.getByRole("button", { name: /^Cairo/ }).click();
  await expect(page.getByRole("dialog", { name: "Cairo deed" })).toContainText("Landmark");
});

test("keyboard: dialogs take focus and Escape closes panels", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/dev/preview?board=grand&players=8");
  await page.getByRole("button", { name: /^Cairo/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Cairo deed" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Cairo deed" })).toHaveCount(0);
  await page.getByRole("button", { name: "Trade", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Trade" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Trade" })).toHaveCount(0);
});

test("trade dialog keeps its actions on screen with a long deed list", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/dev/preview?board=grand&players=3&scene=debt");
  await page.getByRole("button", { name: "Trade", exact: true }).click();
  await page.locator(".dialog .trade-item").last().click();
  expect(await page.locator(".trade-columns .trade-side").nth(1).locator(".trade-item").count()).toBeGreaterThan(10);
  await expect(page.getByRole("button", { name: "Send offer" })).toBeInViewport();
});

test("a player can resign mid-match and the turn moves on", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/dev/preview?scene=start");
  await page.getByRole("button", { name: "Resign from match" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Resign" }).click();
  await expect(page.locator(".player-row.out")).toHaveCount(1);
  await page.getByRole("tab", { name: /Game log/ }).click();
  await expect(page.locator(".log-line").first()).toContainText("resigned");
});

test("hovering or focusing a player lights up their deeds and pawn", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/dev/preview?scene=mid");
  const board = page.getByRole("group", { name: "World Tour Standard board" });
  const row = page.locator(".player-row").nth(1);
  const name = (await row.locator(".player-name").innerText()).split(" · ")[0] as string;
  const owned = board.getByRole("button", { name: new RegExp(", owned by " + name + "(,|$)") });
  expect(await owned.count()).toBeGreaterThan(0);
  await row.hover();
  await expect(board).toHaveClass(/spotlit/);
  for (const tile of await owned.all()) await expect(tile).toHaveClass(/tile-lit/);
  await expect(board.locator(".tile-lit .token[title='" + name + "']")).toHaveCount(1);
  await page.mouse.move(5, 5);
  await expect(board).not.toHaveClass(/spotlit/);
  await row.focus();
  await expect(board).toHaveClass(/spotlit/);
});
