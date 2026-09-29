import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * QA-001/002/012: several real browsers play one live match against the Worker. Every client
 * must converge on the same authoritative version and state fingerprint after each action.
 * LIVE_PLAYERS (default 4, up to 10) sets the table size; LIVE_FULL=1 plays until the match
 * ends instead of a fixed number of actions.
 */
const PLAYERS = Math.min(10, Math.max(3, Number(process.env.LIVE_PLAYERS ?? 4)));
const FULL = process.env.LIVE_FULL === "1";
const ACTIONS = FULL ? 20_000 : 60;

async function signIn(browser: Browser, name: string, room: string | null): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto("/auth/test-login?name=" + encodeURIComponent(name) + (room === null ? "" : "&room=" + room));
  return page;
}

/** "v12 · 1a2b3c4d" from the top bar diagnostics, or "" outside a game. */
async function fingerprint(page: Page): Promise<string> {
  const diag = page.locator(".diag");
  return (await diag.count()) === 0 ? "" : (await diag.innerText()).trim();
}

async function converge(pages: readonly Page[]): Promise<string> {
  let agreed = "";
  await expect.poll(async () => {
    const prints = await Promise.all(pages.map(fingerprint));
    agreed = prints[0] ?? "";
    return prints.every((print) => print !== "" && print === agreed);
  }, { timeout: 15_000 }).toBe(true);
  return agreed;
}

/** One legal action by whichever client the rules are waiting on. */
async function act(pages: readonly Page[]): Promise<boolean> {
  for (const page of pages) {
    const confirm = page.getByRole("alertdialog").getByRole("button", { name: "Declare bankruptcy" });
    if (await confirm.isVisible()) {
      await confirm.click();
      return true;
    }
    const debt = page.getByRole("region", { name: "Payment due" });
    if (await debt.isVisible()) {
      const option = debt.locator(".debt-option").first();
      if (await option.isVisible()) {
        await option.click();
        const deed = page.getByRole("dialog", { name: /deed$/ });
        const button = deed.locator(".deed-actions button:not([disabled])").first();
        if (await button.isVisible()) {
          await button.click();
          await page.keyboard.press("Escape");
          return true;
        }
      }
      await debt.getByRole("button", { name: "Declare bankruptcy" }).click();
      return true;
    }
    const pass = page.locator(".stage").getByRole("button", { name: "Pass", exact: true });
    if (await pass.isVisible() && await pass.isEnabled()) {
      await pass.click();
      return true;
    }
    const turn = page.getByRole("region", { name: "Turn" });
    const primary = turn.locator(".btn-primary");
    if (await primary.isVisible() && await primary.isEnabled()) {
      await primary.click();
      return true;
    }
    const secondary = turn.locator(".btn-paper:not([disabled])", { hasText: /Decline|Pay/ }).first();
    if (await secondary.isVisible()) {
      await secondary.click();
      return true;
    }
  }
  return false;
}

test(`${PLAYERS} browsers play one live match and stay converged`, async ({ browser }) => {
  // A complete 10-player match is 1,000+ turns of clicking; give full runs room to finish.
  test.setTimeout(FULL ? 120 * 60_000 : 10 * 60_000);
  const host = await signIn(browser, "Host", null);
  await host.getByRole("button", { name: "Create a private room" }).click();
  await expect(host).toHaveURL(/\/r\/[A-Z0-9]+$/);
  const code = host.url().split("/r/")[1] as string;
  const pages = [host];
  for (let index = 1; index < PLAYERS; index += 1) pages.push(await signIn(browser, "Player " + index, code));
  for (const page of pages) await expect(page.getByText("Room settings")).toBeVisible();
  await expect(host.locator(".player-row")).toHaveCount(PLAYERS);

  // Chat reaches everyone.
  await pages[1]?.getByPlaceholder("Message the room…").fill("good luck all");
  await pages[1]?.getByRole("button", { name: "Send" }).click();
  for (const page of pages) await expect(page.getByText("good luck all")).toBeVisible();

  for (const page of pages) await page.getByRole("button", { name: "I'm ready" }).click();
  await expect(host.getByRole("button", { name: "Start the match" })).toBeEnabled();
  await host.getByRole("button", { name: "Start the match" }).click();
  for (const page of pages) await expect(page.getByRole("group", { name: "World Tour Standard board" })).toBeVisible();
  let print = await converge(pages);

  let actions = 0;
  let idle = 0;
  while (actions < ACTIONS) {
    if (await host.getByRole("dialog", { name: "Final standings" }).isVisible()) break;
    if (await act(pages)) {
      actions += 1;
      idle = 0;
      const next = await converge(pages);
      print = next;
    } else {
      idle += 1;
      expect(idle, "no client could act at " + print).toBeLessThan(40);
      await host.waitForTimeout(250);
    }
  }
  expect(actions).toBeGreaterThan(10);
  if (FULL) for (const page of pages) await expect(page.getByRole("dialog", { name: "Final standings" })).toBeVisible();

  // QA-002: a player drops and rejoins in a fresh tab, then a second tab replaces the first.
  const dropped = pages[2] as Page;
  const context = dropped.context();
  await dropped.close();
  const rejoined = await context.newPage();
  await rejoined.goto("/r/" + code);
  pages[2] = rejoined;
  await converge(pages);
  const duplicate = await context.newPage();
  await duplicate.goto("/r/" + code);
  await expect(rejoined.getByText("Opened somewhere else")).toBeVisible();
  pages[2] = duplicate;
  await converge(pages);
});
