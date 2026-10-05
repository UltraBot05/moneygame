import { test } from "vitest";
import { productionSeeds, simulateProductionGame } from "../packages/game-core/src/simulation/production-simulator";

/**
 * `pnpm simulate:seats` (SIM_GAMES=1000 by default): win rate by seat, seat 1 moving first, through
 * the production rules and bots. Evidence for the random-first-player decision (QA-EVIDENCE.md).
 */
test("seat fairness", { timeout: 3_600_000 }, async () => {
  const games = Number(process.env.SIM_GAMES ?? 1000);
  const rows: string[] = [];
  for (const [boardRef, players] of [["world-tour-standard@1", 4], ["world-tour-standard@1", 6], ["world-tour-grand@1", 8], ["world-tour-grand@1", 10]] as const) {
    const wins = new Array<number>(players).fill(0);
    let natural = 0;
    for (const seed of productionSeeds(boardRef, players, games, 0x5eed_5ea7)) {
      const result = simulateProductionGame({ boardRef, players, seed });
      wins[result.winnerId] = (wins[result.winnerId] ?? 0) + 1;
      if (result.naturalWinner) natural += 1;
      await new Promise((resolve) => setImmediate(resolve));
    }
    rows.push(boardRef + " " + players + "p (" + games + " games, " + natural + " natural): " + wins.map((count, seat) => "S" + (seat + 1) + "=" + (count / games * 100).toFixed(1) + "%").join(" ") + " | fair=" + (100 / players).toFixed(1) + "%");
    console.log(rows.at(-1));
  }
});
