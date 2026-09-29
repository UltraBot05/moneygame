import { readFileSync } from "node:fs";
import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * QA-001/002/012: several real browsers play one live match against the Worker. Every client
 * must converge on the same authoritative version and state fingerprint after each action.
 * LIVE_PLAYERS (default 4, up to 10) sets the table size; LIVE_FULL=1 plays until the match
 * ends instead of a fixed number of actions. Full runs with six or more players use Grand (the
 * recommended board for 6-10), and the players develop and make set-completion trades, like the
 * simulation bots: a table that never trades rarely completes a set, so it never bankrupts anyone.
 */
const PLAYERS = Math.min(10, Math.max(3, Number(process.env.LIVE_PLAYERS ?? 4)));
const FULL = process.env.LIVE_FULL === "1";
const ACTIONS = FULL ? 50_000 : 60;
const GRAND = FULL && PLAYERS >= 6;

interface SetDeeds {
  readonly deeds: readonly Readonly<{ name: string; price: number }>[];
}

const SETS: readonly SetDeeds[] = (JSON.parse(readFileSync("boards/world-tour/" + (GRAND ? "grand" : "standard") + ".json", "utf8")) as {
  economyProfile: { sets: { properties: { name: string; price: number }[] }[] };
}).economyProfile.sets.map((set) => ({ deeds: set.properties.map(({ name, price }) => ({ name, price })) }));

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

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const exactly = (text: string) => new RegExp("^" + escape(text) + "$");

/** Builds once on one of this player's deeds if the rules allow it; true when it did. */
async function build(page: Page, name: string): Promise<boolean> {
  const mine = page.getByRole("button", { name: new RegExp(", owned by " + escape(name) + "(,|$)") });
  for (let index = 0; index < await mine.count(); index += 1) {
    await mine.nth(index).click();
    const button = page.getByRole("dialog", { name: /deed$/ }).getByRole("button", { name: /^Build/ });
    const canBuild = await button.isVisible() && await button.isEnabled();
    if (canBuild) await button.click();
    // Close the deed panel before the next tile: it sits over the board's top-left corner.
    await page.keyboard.press("Escape");
    if (canBuild) return true;
  }
  return false;
}

/** Deed name -> owner name (and mortgage flag), read from the board's tile labels. */
async function owners(page: Page): Promise<Map<string, { owner: string; mortgaged: boolean }>> {
  const labels = await page.locator(".board-grid > button.tile").evaluateAll((tiles) => tiles.map((tile) => tile.getAttribute("aria-label") ?? ""));
  const map = new Map<string, { owner: string; mortgaged: boolean }>();
  for (const label of labels) {
    const match = /^(.*?), owned by (.*?)(, mortgaged)?$/.exec(label);
    if (match !== null) map.set(match[1] as string, { owner: match[2] as string, mortgaged: match[3] !== undefined });
  }
  return map;
}

async function cashOf(page: Page, name: string): Promise<number> {
  const row = page.locator(".player-row").filter({ has: page.locator(".player-name", { hasText: new RegExp("^" + escape(name) + "( ·|$)") }) });
  return Number((await row.locator(".player-money b").innerText()).replace(/[^0-9]/g, "")) || 0;
}

const attempted = new Map<string, number>();

/**
 * One set-completion purchase through the real trade UI: the buyer owns all but one deed of a
 * set and offers 125% of its price; the owner accepts in their own browser.
 */
async function trade(pages: readonly Page[], names: readonly string[], buyerIndex: number, actions: number): Promise<boolean> {
  const page = pages[buyerIndex] as Page;
  const buyer = names[buyerIndex] as string;
  const owned = await owners(page);
  const cash = await cashOf(page, buyer);
  for (const set of SETS) {
    const missing = set.deeds.filter((deed) => owned.get(deed.name)?.owner !== buyer);
    const target = missing[0];
    if (missing.length !== 1 || target === undefined) continue;
    const holder = owned.get(target.name);
    const sellerIndex = holder === undefined ? -1 : names.indexOf(holder.owner);
    if (holder === undefined || holder.mortgaged || sellerIndex < 0) continue;
    const offer = Math.ceil((target.price * 1.25) / 10) * 10;
    const key = buyer + ">" + target.name;
    if (cash - offer < 200 || actions - (attempted.get(key) ?? -1_000) < 300) continue;
    attempted.set(key, actions);
    await page.getByRole("region", { name: "Turn" }).getByRole("button", { name: "Trade", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Trade" });
    await dialog.locator(".trade-item").filter({ has: page.locator("span", { hasText: exactly(holder.owner) }) }).first().click();
    const deed = dialog.locator(".trade-side").nth(1).locator(".trade-item").filter({ has: page.locator("span", { hasText: exactly(target.name) }) });
    if (!(await deed.isEnabled())) {
      await page.keyboard.press("Escape");
      continue;
    }
    await dialog.getByLabel("Cash you give").fill(String(offer));
    await deed.click();
    await dialog.getByRole("button", { name: "Send offer" }).click();
    await converge(pages);
    const seller = pages[sellerIndex] as Page;
    const review = seller.getByRole("region", { name: "Trades" }).getByRole("button", { name: "Review" }).first();
    if (!(await review.isVisible())) return true;
    await review.click();
    await seller.getByRole("dialog", { name: "Trade" }).getByRole("button", { name: "Accept" }).click();
    return true;
  }
  return false;
}

/** One legal action by whichever client the rules are waiting on. */
async function act(pages: readonly Page[], names: readonly string[], actions: number): Promise<boolean> {
  for (const [index, page] of pages.entries()) {
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
        await page.keyboard.press("Escape");
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
      // Trade and develop before ending the turn, so rents grow and a full match can finish.
      if (FULL && (await primary.innerText()).trim() === "End turn") {
        if (await trade(pages, names, index, actions)) return true;
        if (await build(page, names[index] as string)) return true;
      }
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
  // A complete 10-player match is thousands of clicks; give full runs room to finish.
  test.setTimeout(FULL ? 180 * 60_000 : 10 * 60_000);
  const host = await signIn(browser, "Host", null);
  await host.getByRole("button", { name: "Create a private room" }).click();
  await expect(host).toHaveURL(/\/r\/[A-Z0-9]+$/);
  const code = host.url().split("/r/")[1] as string;
  const pages = [host];
  const names = ["Host"];
  for (let index = 1; index < PLAYERS; index += 1) {
    names.push("Player " + index);
    pages.push(await signIn(browser, "Player " + index, code));
  }
  for (const page of pages) await expect(page.getByText("Room settings")).toBeVisible();
  await expect(host.locator(".player-row")).toHaveCount(PLAYERS);
  if (GRAND) await host.getByRole("button", { name: "Grand", exact: true }).click();

  // Chat reaches everyone.
  await pages[1]?.getByPlaceholder("Message the room…").fill("good luck all");
  await pages[1]?.getByRole("button", { name: "Send" }).click();
  for (const page of pages) await expect(page.getByText("good luck all")).toBeVisible();

  for (const page of pages) await page.getByRole("button", { name: "I'm ready" }).click();
  await expect(host.getByRole("button", { name: "Start the match" })).toBeEnabled();
  await host.getByRole("button", { name: "Start the match" }).click();
  const boardName = GRAND ? "World Tour Grand board" : "World Tour Standard board";
  for (const page of pages) await expect(page.getByRole("group", { name: boardName })).toBeVisible();
  let print = await converge(pages);

  let actions = 0;
  let idle = 0;
  while (actions < ACTIONS) {
    if (await host.getByRole("dialog", { name: "Final standings" }).isVisible()) break;
    if (await act(pages, names, actions)) {
      actions += 1;
      idle = 0;
      print = await converge(pages);
      if (actions % 100 === 0) {
        const out = await host.locator(".player-row.out").count();
        console.log("live: " + actions + " actions, " + out + " players out, all clients at " + print);
      }
    } else {
      idle += 1;
      expect(idle, "no client could act at " + print).toBeLessThan(40);
      await host.waitForTimeout(250);
    }
  }
  expect(actions).toBeGreaterThan(10);
  if (FULL) {
    for (const page of pages) await expect(page.getByRole("dialog", { name: "Final standings" })).toBeVisible();
    console.log("live: match finished after " + actions + " actions at " + print);
  }

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
