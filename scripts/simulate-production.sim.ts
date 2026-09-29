import { readFileSync, writeFileSync } from "node:fs";
import { test } from "vitest";
import { PRODUCTION_MATRIX, productionSeeds, simulateProductionGame } from "../packages/game-core/src/simulation/production-simulator";
import { summarizeSimulations, type GameSimulationResult, type SimulationSummary } from "../packages/game-core/src/spike-008/economy-simulator";

/**
 * `pnpm simulate:production` (SIM_GAMES=250 by default): the production rule path over the
 * SPIKE-008 seed schedule, written to docs/architecture/PRODUCTION-SIMULATION.json and compared
 * with the frozen ECON-001 candidate matrix.
 */
const games = Number(process.env.SIM_GAMES ?? 250);
const output = "docs/architecture/PRODUCTION-SIMULATION.json";

test("production economy matrix", async () => {
  const frozen = JSON.parse(readFileSync("docs/architecture/ECON-001-simulation.json", "utf8")) as { candidate: SimulationSummary[] };
  const summaries: SimulationSummary[] = [];
  for (const { boardRef, players } of PRODUCTION_MATRIX) {
    for (const count of players) {
      const results: GameSimulationResult[] = [];
      for (const seed of productionSeeds(boardRef, count, games)) {
        results.push(simulateProductionGame({ boardRef, players: count, seed }));
        // Yield so the test runner's worker RPC stays responsive during long runs.
        await new Promise((resolve) => setImmediate(resolve));
      }
      summaries.push(summarizeSimulations(results));
    }
  }
  writeFileSync(output, JSON.stringify({ schema: "production-simulation/1", gamesPerConfiguration: games, seedBase: 0x5eed0008, summaries }, null, 2) + "\n");
  const rows = summaries.map((summary) => {
    const before = frozen.candidate.find((candidate) => candidate.board === summary.board && candidate.players === summary.players);
    const failed = summary.criteria.filter((criterion) => !criterion.passed).map((criterion) => criterion.id + "=" + criterion.observed.toFixed(3)).join(",");
    return [summary.board + " " + summary.players,
      before === undefined ? "-" : before.durationRounds.median.toFixed(1) + " / " + (before.stalledRate * 100).toFixed(1) + "%",
      summary.durationRounds.median.toFixed(1) + " / " + (summary.stalledRate * 100).toFixed(1) + "%",
      summary.decision + (failed === "" ? "" : " (" + failed + ")")].join(" | ");
  });
  console.log(["config | ECON-001 rounds/stalls | production rounds/stalls | decision", ...rows].join("\n"));
});
