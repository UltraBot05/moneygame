import { describe, expect, it } from "vitest";
import {
  applyCommand,
  checkInvariants,
  initWorld,
  runFuzz,
  FuzzViolation,
  type FuzzWorld,
} from "./fuzz.testkit";

/**
 * SPIKE-007 — seeded fuzz harness over the real transition + seat logic. Fixed
 * CI seeds keep runtime trivial; a developer can pin a seed with FUZZ_SEED. A
 * negative control proves the invariant registry actually detects a violation.
 */

const CI_SEEDS = [1, 7, 42, 1234, 99999];
const STEPS = 400;

const envSeed = process.env["FUZZ_SEED"];
const seeds = envSeed !== undefined ? [Number(envSeed)] : CI_SEEDS;

describe("SPIKE-007 seeded fuzz harness", () => {
  for (const seed of seeds) {
    it(`seed ${seed}: ${STEPS} steps hold every invariant`, () => {
      // Throws a FuzzViolation (with seed/step/command) on any invariant break.
      expect(() => runFuzz(seed, STEPS)).not.toThrow();
    });
  }

  it("is deterministic: same seed → identical command log and final world hash", () => {
    const a = runFuzz(3, STEPS);
    const b = runFuzz(3, STEPS);
    expect(b.log).toEqual(a.log);
    expect(b.hash).toEqual(a.hash);
  });

  it("a different seed produces a different run", () => {
    expect(runFuzz(3, STEPS).hash).not.toEqual(runFuzz(4, STEPS).hash);
  });

  it("negative control: the registry detects a corrupted retired game", () => {
    // Build a world with a genuinely retired game, then corrupt it behind the
    // registry's back and confirm the registry throws. This proves the harness
    // can actually fail (it is not trivially green).
    const world: FuzzWorld = initWorld();
    applyCommand(world, { kind: "INCREMENT", gameId: world.currentGameId, actionId: "a0" });
    const retired = world.currentGameId;
    applyCommand(world, { kind: "REMATCH", gameId: world.currentGameId, board: "grand" });
    expect(world.retired.has(retired)).toBe(true);
    // Sanity: clean world passes.
    expect(() => checkInvariants(world)).not.toThrow();
    // Corrupt: mutate the retired game through the real API, skipping every guard.
    applyCommand(world, { kind: "INCREMENT", gameId: retired, actionId: "sneak" }, { injectDefect: true });
    expect(() => checkInvariants(world)).toThrow(/retired-game-frozen/);
  });

  it("negative control: an injected defect is caught somewhere across the CI seeds", () => {
    // Running the whole generator with the stale-guard bypass must surface a
    // FuzzViolation on at least one seed (stale increments now mutate).
    const violations = CI_SEEDS.map((seed) => {
      try {
        runFuzz(seed, STEPS, { injectDefect: true });
        return null;
      } catch (e) {
        return e instanceof FuzzViolation ? e.invariant : "non-fuzz-error";
      }
    }).filter((v): v is string => v !== null);
    expect(violations.length).toBeGreaterThan(0);
  });
});
