import { describe, expect, it } from "vitest";
import { fuzzProductionGame } from "./production-fuzz";

describe("QA-011 production rule fuzz", () => {
  it("survives chaos on both boards with every invariant intact", () => {
    for (const [boardRef, players] of [["world-tour-standard@1", 3], ["world-tour-standard@1", 6], ["world-tour-grand@1", 10]] as const) {
      for (const seed of [11, 12, 13, 14]) {
        const result = fuzzProductionGame({ boardRef, players, seed, maxCommands: 1500 });
        expect(result.accepted).toBeGreaterThan(100);
        expect(result.refused + result.malformed).toBeGreaterThan(0);
        expect(result.duplicates).toBeGreaterThan(0);
      }
    }
  }, 120_000);

  it("replays a seed to the identical final state", () => {
    const run = () => fuzzProductionGame({ boardRef: "world-tour-grand@1", players: 7, seed: 99, maxCommands: 800 });
    expect(run()).toEqual(run());
  }, 60_000);
});
