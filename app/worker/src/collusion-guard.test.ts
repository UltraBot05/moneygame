import { describe, expect, it } from "vitest";
import { handleCommand, viewerGame } from "./room-runtime";
import { BEN, command, CY, deps, game, HOST, patchState, startedRoom, T0 } from "./room.testkit";
import type { SqlDb } from "./transition";

/**
 * QA-013 Collusion Guard adversarial suite, through the real room command path (persisted
 * state reloaded and revalidated on every command). Policy: INT-001.
 */
const ROME = 31;
const MILAN = 32;
const VENICE = 33;
const PARIS = 36;
const LYON = 37;
let clock = T0;

function giveHost(sql: SqlDb, tiles: readonly number[]): void {
  patchState(sql, (state) => {
    const assets = state.assets as Record<string, unknown>[];
    state.assets = assets.map((asset) => tiles.includes(asset.tileIndex as number) ? { ...asset, ownerUserId: HOST.userId } : asset);
  });
}

function assetAt(sql: SqlDb, tileIndex: number): string {
  return game(sql).assets.find((asset) => asset.tileIndex === tileIndex)?.assetId as string;
}

/** Host proposes; the recipient accepts. Returns the acceptance command for replay tests. */
function trade(sql: SqlDb, recipient: typeof BEN, offered: { cash: number; assetIds: string[] }, requested: { cash: number; assetIds: string[] }) {
  clock += 3_000;
  expect(handleCommand(sql, HOST.userId, command(sql, "PROPOSE_TRADE", { recipientUserId: recipient.userId, offered, requested }, "p-" + clock), deps(clock)))
    .toMatchObject({ kind: "COMMITTED" });
  const tradeId = game(sql).ruleState.trades.at(-1)?.tradeId;
  const accept = command(sql, "ACCEPT_TRADE", { tradeId }, "a-" + clock);
  expect(handleCommand(sql, recipient.userId, accept, deps(clock + 1))).toMatchObject({ kind: "COMMITTED" });
  return accept;
}

const gift = (assetId: string) => ({ offered: { cash: 0, assetIds: [assetId] }, requested: { cash: 0, assetIds: [] } });

describe("QA-013 Collusion Guard adversarial suite", () => {
  it("warns privately, ignores a retried acceptance, then removes the pair publicly", () => {
    const { sql } = startedRoom();
    giveHost(sql, [ROME, MILAN, VENICE]);
    trade(sql, BEN, gift(assetAt(sql, ROME)).offered, gift("").requested);
    expect(game(sql).ruleState.fairPlay.incidents).toEqual([]);

    const second = trade(sql, BEN, gift(assetAt(sql, MILAN)).offered, gift("").requested);
    expect(handleCommand(sql, BEN.userId, second, deps(clock + 2))).toMatchObject({ kind: "DUPLICATE" });
    const warned = viewerGame(sql, HOST.userId)?.game.ruleState.fairPlay.incidents ?? [];
    expect(warned).toMatchObject([{ kind: "PATTERN", consequence: "WARNING" }]);
    expect(viewerGame(sql, BEN.userId)?.game.ruleState.fairPlay.incidents).toHaveLength(1);
    expect(viewerGame(sql, CY.userId)?.game.ruleState.fairPlay.incidents).toEqual([]);
    expect(viewerGame(sql, null)?.game.ruleState.fairPlay.incidents).toEqual([]);

    trade(sql, BEN, gift(assetAt(sql, VENICE)).offered, gift("").requested);
    const after = game(sql);
    expect(after.ruleState.fairPlay.incidents.filter((incident) => incident.consequence === "REMOVAL")).toHaveLength(1);
    expect(after.players.filter((player) => player.status === "BANKRUPT").map((player) => player.userId).sort()).toEqual([BEN.userId, HOST.userId].sort());
    expect(after.phase).toBe("GAME_OVER");
    expect(after.ruleState.outcome?.winnerUserIds).toEqual([CY.userId]);
    // Removals are public; the earlier warning stays private to the pair.
    expect(viewerGame(sql, CY.userId)?.game.ruleState.fairPlay.incidents.map((incident) => incident.consequence)).toEqual(["REMOVAL"]);
    // Removed players' assets return to the bank, unowned.
    expect(after.assets.filter((asset) => asset.ownerUserId === HOST.userId || asset.ownerUserId === BEN.userId)).toEqual([]);
  });

  it("never flags fair trades, however many, or gifts under the $300 floor", () => {
    const { sql } = startedRoom();
    giveHost(sql, [ROME, MILAN, VENICE, PARIS, LYON]);
    // Fair: each deed sold for 125% of its price.
    for (const [tile, price] of [[ROME, 300], [MILAN, 320], [VENICE, 340]] as const) {
      trade(sql, BEN, { cash: 0, assetIds: [assetAt(sql, tile)] }, { cash: Math.ceil(price * 1.25 / 10) * 10, assetIds: [] });
    }
    // Below the floor: repeated $290 cash gifts to one player.
    for (let index = 0; index < 4; index += 1) trade(sql, CY, { cash: 290, assetIds: [] }, { cash: 0, assetIds: [] });
    // Lyon ($400) for $110: $290 net is under the floor, and 27.5% is over the 25% line.
    trade(sql, CY, { cash: 0, assetIds: [assetAt(sql, LYON)] }, { cash: 110, assetIds: [] });
    expect(game(sql).ruleState.fairPlay.incidents).toEqual([]);
    expect(game(sql).players.every((player) => player.status === "ACTIVE")).toBe(true);
  });

  it("counts lopsided trades in either direction within the same pair", () => {
    const { sql } = startedRoom();
    giveHost(sql, [ROME, PARIS]);
    trade(sql, BEN, gift(assetAt(sql, ROME)).offered, gift("").requested);
    // Ben gives Rome back for nothing: second lopsided trade in the pair, the other way round.
    clock += 3_000;
    const rome = assetAt(sql, ROME);
    expect(handleCommand(sql, BEN.userId, command(sql, "PROPOSE_TRADE", { recipientUserId: HOST.userId, offered: { cash: 0, assetIds: [rome] }, requested: { cash: 0, assetIds: [] } }, "b-" + clock), deps(clock)))
      .toMatchObject({ kind: "COMMITTED" });
    const tradeId = game(sql).ruleState.trades.at(-1)?.tradeId;
    expect(handleCommand(sql, HOST.userId, command(sql, "ACCEPT_TRADE", { tradeId }, "h-" + clock), deps(clock + 1))).toMatchObject({ kind: "COMMITTED" });
    expect(game(sql).ruleState.fairPlay.incidents).toMatchObject([{ consequence: "WARNING", giverUserId: BEN.userId, receiverUserId: HOST.userId }]);
  });
});
