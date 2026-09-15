import { test, expect } from "@playwright/test";

/**
 * GOV-004 — Minimal browser smoke test against the real web app shell.
 * Proves the E2E harness runs and the Vite app renders. Does not claim
 * production gameplay E2E coverage; QA-012 extends this foundation.
 */
test("web app shell loads and renders the board", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("moneygame");
  await expect(page.locator("h1")).toContainText("Money");
  await expect(page.locator(".board-frame")).toBeVisible();
});
