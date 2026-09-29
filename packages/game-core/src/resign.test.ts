import { describe, expect, it } from "vitest";
import { alice, asset, bob, carol, EG1, MA1, ok, player, refused, roundTrip, run, setup } from "./rules.testkit";

describe("RESIGN: leaving a match voluntarily", () => {
  it("returns a non-turn player's cash and deeds to the bank and keeps the current turn", () => {
    const state = setup({ owners: { [EG1]: bob, [MA1]: bob }, mortgaged: [MA1], cash: { [bob]: 900 } });
    const result = run(state, "RESIGN", bob);
    const after = ok(result);
    expect(result).toMatchObject({
      event: { type: "PLAYER_BANKRUPT", fact: { userId: bob, reason: "RESIGNED", creditor: { type: "BANK" }, cashTransferred: 900 }, outcome: null },
    });
    expect(player(after, bob)).toMatchObject({ status: "BANKRUPT", cash: 0 });
    expect(asset(after, EG1).ownerUserId).toBeNull();
    expect(asset(after, MA1)).toMatchObject({ ownerUserId: null, mortgaged: false });
    expect(after.turn?.activePlayerId).toBe(alice);
    roundTrip(after);
    refused(run(after, "RESIGN", bob), "PLAYER_NOT_ELIGIBLE", after);
  });

  it("passes the turn when the turn owner resigns, and ends the match when one player is left", () => {
    const first = ok(run(setup(), "RESIGN", alice));
    expect(first.turn?.activePlayerId).toBe(bob);
    const last = run(first, "RESIGN", carol);
    expect(last).toMatchObject({ event: { outcome: { winnerUserIds: [bob] } } });
    expect(ok(last).phase).toBe("GAME_OVER");
  });

  it("is a declared bankruptcy when the player is in debt, so the creditor is still paid", () => {
    // Alice rolls 1+2 onto Bob's Casablanca (tile 6) with $1 and cannot pay the rent.
    const owing = ok(run(setup({ owners: { [MA1]: bob }, cash: { [alice]: 1 }, positions: { [alice]: 3 } }), "ROLL_DICE", alice, {}, { dice: [1, 2] }));
    expect(owing.pendingResolution?.obligation).toMatchObject({ debtorUserId: alice, creditor: { type: "PLAYER", userId: bob } });
    const result = run(owing, "RESIGN", alice);
    expect(result).toMatchObject({ event: { fact: { userId: alice, reason: "DECLARED", creditor: { type: "PLAYER", userId: bob } } } });
    expect(player(ok(result), bob).cash).toBe(player(owing, bob).cash + 1);
  });

  it("waits for a live auction to end", () => {
    const landed = ok(run(setup({ positions: { [alice]: 38 } }), "ROLL_DICE", alice, {}, { dice: [1, 2] }));
    const auctioning = ok(run(landed, "DECLINE_PROPERTY", alice, { resolutionId: landed.pendingResolution?.resolutionId }));
    expect(auctioning.auction).not.toBeNull();
    refused(run(auctioning, "RESIGN", carol), "RESIGN_BLOCKED_DURING_AUCTION", auctioning);
  });
});
