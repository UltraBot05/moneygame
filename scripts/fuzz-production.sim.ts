import { writeFileSync } from "node:fs";
import { test } from "vitest";
import { FuzzInvariantError, fuzzProductionGame } from "../packages/game-core/src/simulation/production-fuzz";
import { PRODUCTION_MATRIX } from "../packages/game-core/src/simulation/production-simulator";

/**
 * `pnpm fuzz:production` (FUZZ_SEEDS per configuration, default 120): QA-005 large seeded fuzz
 * over every supported board/player configuration. Writes docs/architecture/PRODUCTION-FUZZ.json;
 * any failure is recorded with its seed so `fuzzProductionGame` can replay it exactly.
 */
const seedsPerConfiguration = Number(process.env.FUZZ_SEEDS ?? 120);

test("production fuzz matrix", async () => {
  const configurations: unknown[] = [];
  const failures: { boardRef: string; players: number; seed: number; message: string }[] = [];
  for (const { boardRef, players } of PRODUCTION_MATRIX) {
    for (const count of players) {
      let accepted = 0;
      let refused = 0;
      let malformed = 0;
      let duplicates = 0;
      let finished = 0;
      for (let index = 0; index < seedsPerConfiguration; index += 1) {
        const seed = 1_000 + count * 10_000 + index;
        try {
          const result = fuzzProductionGame({ boardRef, players: count, seed });
          accepted += result.accepted;
          refused += result.refused;
          malformed += result.malformed;
          duplicates += result.duplicates;
          if (result.finished) finished += 1;
        } catch (error) {
          failures.push({ boardRef, players: count, seed, message: error instanceof FuzzInvariantError || error instanceof Error ? error.message : String(error) });
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
      configurations.push({ boardRef, players: count, seeds: seedsPerConfiguration, finished, accepted, refused, malformed, duplicates });
    }
  }
  writeFileSync("docs/architecture/PRODUCTION-FUZZ.json", JSON.stringify({ schema: "production-fuzz/1", seedsPerConfiguration, configurations, failures }, null, 2) + "\n");
  console.log(JSON.stringify({ configurations, failures }, null, 1));
  if (failures.length > 0) throw new Error(failures.length + " fuzz failures; see PRODUCTION-FUZZ.json");
});
