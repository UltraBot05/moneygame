import { describe, expect, it } from "vitest";
import { runProductionConfiguration, simulateProductionGame } from "./production-simulator";

describe("production-path simulator", () => {
  it("plays whole Standard and Grand games through the real rules without a refused command", () => {
    for (const [boardRef, players] of [["world-tour-standard@1", 4], ["world-tour-grand@1", 10]] as const) {
      for (const seed of [1, 2, 3]) {
        const result = simulateProductionGame({ boardRef, players, seed });
        expect(result.turns).toBeGreaterThan(players * 5);
        expect(result.purchases).toBeGreaterThan(0);
        expect(result.laps).toBeGreaterThan(0);
        if (result.naturalWinner) expect(result.bankruptcies).toBe(players - 1);
      }
    }
  }, 60_000);

  it("is deterministic per seed", () => {
    const run = () => simulateProductionGame({ boardRef: "world-tour-standard@1", players: 3, seed: 42 });
    expect(run()).toEqual(run());
  }, 30_000);

  it("summarizes with the unchanged SPIKE-008 bands", () => {
    const summary = runProductionConfiguration("world-tour-standard@1", 3, 4);
    expect(summary.games).toBe(4);
    expect(summary.criteria.map((criterion) => criterion.id)).toContain("stalled-rate");
  }, 30_000);
});
