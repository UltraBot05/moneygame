import { describe, expect, it } from "vitest";
import { CANDIDATE_RULES, validStartingCash } from "./economy.ts";
import { STANDARD_CANDIDATE, GRAND_CANDIDATE, CANDIDATE_SIMULATION_RULES } from "./economy-candidates.ts";
import { STANDARD_ECONOMY, GRAND_ECONOMY } from "./spike-008/economy-data.ts";
import { runConfiguration, simulateGame, specialLandingRent } from "./spike-008/economy-simulator.ts";

const boards = [STANDARD_CANDIDATE, GRAND_CANDIDATE];
describe("frozen authored economy baseline", () => {
  it("keeps fixed counts, contiguous sets, unique property references and two utilities", () => {
    expect(CANDIDATE_RULES.status).toBe("FROZEN_BASELINE");
    expect(CANDIDATE_RULES.developmentActions).toBe(2);
    expect(CANDIDATE_RULES.grandMovement).toBe("core");
    for (const board of boards) {
      const grand = board.kind === "grand";
      const properties = board.sets.flatMap((set) => set.properties);
      expect(board.tiles).toHaveLength(grand ? 52 : 40);
      expect(properties).toHaveLength(grand ? 30 : 22);
      expect(board.sets).toHaveLength(grand ? 12 : 8);
      const references = board.tiles.flatMap((tile) => tile.type === "property" ? [tile.propertyId] : []);
      expect(references.slice().sort()).toEqual(properties.map((p) => p.id).sort());
      expect(new Set(references).size).toBe(properties.length);
      expect(board.tiles.map((t) => t.index)).toEqual(Array.from({ length: board.tileCount }, (_, i) => i));
      expect(board.tiles.filter((t) => t.type === "utility")).toHaveLength(2);
      expect(board.tiles.filter((t) => t.type === "transit")).toHaveLength(4);
      expect(board.tiles.filter((t) => t.type === "tax")).toHaveLength(2);
      expect(board.tiles.filter((t) => t.type === "card" && t.deck === "surprise")).toHaveLength(grand ? 4 : 3);
      expect(board.tiles.filter((t) => t.type === "card" && t.deck === "treasure")).toHaveLength(3);
      expect(board.tiles.filter((t) => t.type === "corner").map((t) => t.index)).toEqual(grand ? [0, 13, 26, 39] : [0, 10, 20, 30]);
      for (const set of board.sets) {
        const indices = board.tiles.filter((t) => t.type === "property" && set.properties.some((p) => p.id === t.propertyId)).map((t) => t.index);
        expect((indices.at(-1) ?? -1) - (indices[0] ?? -1) + 1).toBe(set.properties.length);
      }
      if (grand) {
        expect(board.sets.map((set) => set.properties.length)).toEqual([2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3]);
        for (let side = 0; side < 4; side++) {
          expect(board.sets.filter((set) => board.tiles.slice(side * 13, side * 13 + 13).some((t) => t.type === "property" && t.propertyId === set.properties[0]?.id))).toHaveLength(3);
        }
      }
    }
  });

  it("preserves authored prices/rents/build costs and corrects integer redemption", () => {
    for (const board of boards) {
      const baseline = board.kind === "standard" ? STANDARD_ECONOMY : GRAND_ECONOMY;
      expect(board.sets.map((s) => s.properties.map((p) => ({ ...p, unmortgageCost: 0 })))).toEqual(
        baseline.sets.map((s) => s.properties.map((p) => ({ ...p, unmortgageCost: 0 }))),
      );
      expect(board.startSalary).toBe(200);
      expect(board.startingCash).toBe(2000);
      expect(board.transit.unmortgageCost).toBe(110);
      expect(board.utility.unmortgageCost).toBe(83);
      for (const p of board.sets.flatMap((s) => s.properties)) {
        expect(p.developmentRents).toHaveLength(4);
        expect(p.completeSetRent).toBe(p.baseRent * 2);
        expect(p.mortgageValue).toBe(p.price / 2);
        expect(p.unmortgageCost).toBe(Math.ceil(p.mortgageValue * 110 / 100));
        expect(p.buildingSellBack).toBe(p.buildingCost / 2);
      }
    }
    expect(STANDARD_CANDIDATE.sets[1]?.properties[0]?.unmortgageCost).toBe(55);
    expect(STANDARD_CANDIDATE.sets[4]?.properties[0]?.unmortgageCost).toBe(121);
  });

  it("rejects out-of-bound, fractional and non-finite starting cash", () => {
    expect(CANDIDATE_RULES.startingCashPresets.every(validStartingCash)).toBe(true);
    expect(validStartingCash(1751)).toBe(true);
    for (const cash of [1499, 2501, 2000.5, NaN, Infinity]) expect(validStartingCash(cash)).toBe(false);
  });

  it("freezes nested authored data and remains isolated across simulation/rematch", () => {
    for (const board of boards) {
      expect(Object.isFrozen(board)).toBe(true);
      expect(Object.isFrozen(board.tiles[0])).toBe(true);
      expect(Object.isFrozen(board.sets[0]?.properties[0]?.developmentRents)).toBe(true);
    }
    const before = JSON.stringify(boards);
    const config = { board: GRAND_CANDIDATE, players: 10, seed: 42, ...CANDIDATE_SIMULATION_RULES };
    const first = simulateGame(config);
    simulateGame({ ...config, board: STANDARD_CANDIDATE, players: 6 });
    expect(simulateGame(config)).toEqual(first);
    expect(JSON.stringify(boards)).toBe(before);
  });
});

describe("candidate pacing behavior", () => {
  it("charges special utility cards by dice, not ten times ordinary utility rent", () => {
    expect(specialLandingRent(28, 7, 10, true)).toBe(70);
    expect(specialLandingRent(70, 7, 10, true)).toBe(70);
    expect(specialLandingRent(40, 7, 2)).toBe(80);
  });
  it.each([STANDARD_CANDIDATE, GRAND_CANDIDATE])("repairs the highest-count pacing without changing rents ($kind)", (board) => {
    const players = board.recommendedPlayers.max;
    const before = runConfiguration(board, players, 250, { ...CANDIDATE_SIMULATION_RULES, developmentActions: 1 });
    const after = runConfiguration(board, players, 250, CANDIDATE_SIMULATION_RULES);
    expect(after.decision).toBe("PASS");
    expect(after.durationRounds.median).toBeLessThan(before.durationRounds.median);
    expect(after.stalledRate).toBeLessThan(before.stalledRate);
  }, 20000);

  it.each(["core", "turbo", "transit"] as const)("replays %s independently without mutating the board", (movement) => {
    const config = { board: GRAND_CANDIDATE, players: 10, seed: 1234, ...CANDIDATE_SIMULATION_RULES, movement };
    const first = simulateGame(config);
    expect(first.holdingDevelopmentActions).toBe(0);
    expect(simulateGame(config)).toEqual(first);
    if (movement !== "core") expect(first).not.toEqual(simulateGame({ ...config, movement: "core" }));
  });
});
