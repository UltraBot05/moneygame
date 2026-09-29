import { describe, expect, it } from "vitest";
import { memoryD1 } from "./d1.testkit";
import { deliverFinalization } from "./finalization";
import { deriveProgress, equipCosmetic, levelFor, loadProfile, purchaseCosmetic } from "./profile";
import { admit, roomView, type FinalizedGame } from "./room-runtime";
import { BEN, fresh, HOST, T0 } from "./room.testkit";

const ANA = { userId: "u-ana", displayName: "Ana" };

function finished(gameId: string, order: readonly string[], options: Partial<Pick<FinalizedGame, "boardRef" | "matchMode" | "eliminations">> = {}): FinalizedGame {
  return {
    gameId, roomCode: "ROOM42", boardRef: options.boardRef ?? "world-tour-standard@1", matchMode: options.matchMode ?? "FFA",
    endedAt: 1_000 + Number(gameId.replace(/\D/g, "") || 0),
    outcome: { reason: "LAST_STANDING", winnerUserIds: [order[0] as string], winningTeamId: null, placements: order, endedGameVersion: 50 },
    players: order.map((userId, index) => ({ userId, displayName: userId, placement: index + 1, winner: index === 0 })),
    eliminations: options.eliminations ?? [],
    incidents: [],
  };
}

describe("META-001..006 profile read model", () => {
  it("derives XP, level, coins and achievements from finalized history, duplicate-safe", async () => {
    const db = memoryD1();
    const win = finished("g1", ["u-ana", "u-ben", "u-cy"]);
    await deliverFinalization(db, win);
    await deliverFinalization(db, win);
    await deliverFinalization(db, finished("g2", ["u-ben", "u-cy", "u-ana"], { boardRef: "world-tour-grand@1" }));
    const profile = await loadProfile(db, ANA);
    // Win of 3: 100 + 2x20 + 100 = 240 XP, 10 + 2x5 + 20 = 40 coins. Third of 3: 100 XP, 10 coins.
    expect(profile).toMatchObject({ gamesPlayed: 2, wins: 1, xp: 340, level: 2, coins: 50 });
    expect(profile.achievements).toEqual(["FIRST_GAME", "FIRST_WIN", "GRAND_TOUR"]);
    expect(profile.history.map((entry) => entry.gameId)).toEqual(["g2", "g1"]);
    expect(levelFor(0)).toEqual({ level: 1, levelStartXp: 0, nextLevelXp: 250 });
    expect(levelFor(1000).level).toBe(3);
  });

  it("gives a Collusion Guard removal nothing for that match", () => {
    const progress = deriveProgress([
      { gameId: "g1", boardRef: "world-tour-standard@1", matchMode: "FFA", endedAt: 1, players: 4, placement: 4, winner: false, removed: true },
    ]);
    expect(progress).toMatchObject({ xp: 0, coinsEarned: 0, gamesPlayed: 0, achievements: [] });
  });

  it("reads removals from the finalized elimination facts", async () => {
    const db = memoryD1();
    await deliverFinalization(db, finished("g1", ["u-ben", "u-cy", "u-ana"], {
      eliminations: [{ userId: "u-ana", reason: "REMOVED", resolutionId: null, creditor: { type: "BANK" }, obligationAmount: 0, cashTransferred: 0, assetIds: [], gameVersion: 9, actionId: "x" }],
    }));
    const profile = await loadProfile(db, ANA);
    expect(profile).toMatchObject({ xp: 0, coins: 0, gamesPlayed: 0 });
    expect(profile.history[0]?.removed).toBe(true);
  });

  it("sells cosmetics once, only with enough coins, and equips only owned items", async () => {
    const db = memoryD1();
    expect(await purchaseCosmetic(db, ANA, "ring-brass", 5)).toEqual({ ok: false, error: "NOT_ENOUGH_COINS" });
    for (let index = 1; index <= 2; index += 1) await deliverFinalization(db, finished("g" + index, ["u-ana", "u-ben", "u-cy"]));
    expect(await equipCosmetic(db, ANA, "RING", "ring-brass")).toEqual({ ok: false, error: "NOT_OWNED" });
    const bought = await purchaseCosmetic(db, ANA, "ring-brass", 5);
    expect(bought).toMatchObject({ ok: true, profile: { coins: 20, inventory: ["ring-brass"] } });
    expect(await purchaseCosmetic(db, ANA, "ring-brass", 6)).toMatchObject({ ok: true, profile: { coins: 20 } });
    expect(await purchaseCosmetic(db, ANA, "ring-jade", 7)).toEqual({ ok: false, error: "NOT_ENOUGH_COINS" });
    expect(await purchaseCosmetic(db, ANA, "nope", 7)).toEqual({ ok: false, error: "UNKNOWN_ITEM" });
    expect(await equipCosmetic(db, ANA, "TITLE", "ring-brass")).toEqual({ ok: false, error: "UNKNOWN_ITEM" });
    expect(await equipCosmetic(db, ANA, "RING", "ring-brass")).toMatchObject({ ok: true, profile: { equipped: { RING: "ring-brass", TITLE: null } } });
    expect(await equipCosmetic(db, ANA, "RING", null)).toMatchObject({ ok: true, profile: { equipped: { RING: null } } });
  });

  it("shows only catalog rings in rooms, so a forged header value is dropped", () => {
    const { sql } = fresh();
    admit(sql, { ...HOST, ring: "#E3BC63" }, T0);
    admit(sql, { ...BEN, ring: "url(javascript:alert(1))" }, T0);
    expect(roomView(sql, T0)?.members.map((member) => member.ring)).toEqual(["#E3BC63", null]);
    admit(sql, { ...HOST, ring: null }, T0);
    expect(roomView(sql, T0)?.members[0]?.ring).toBeNull();
  });
});
