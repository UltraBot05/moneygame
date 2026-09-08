declare const process: { readonly argv: readonly string[]; exitCode?: number };
declare const console: { log(message: string): void; error(message: string): void };

import { STANDARD_CANDIDATE, GRAND_CANDIDATE, CANDIDATE_SIMULATION_RULES } from "../economy-candidates.ts";
import { PLAYER_COUNT_MATRIX, type EconomyBoard } from "./economy-data.ts";
import { runBaselineMatrix, runConfiguration, type CandidateSimulationRules } from "./economy-simulator.ts";

try {
  const raw = process.argv.slice(2);
  if (raw.some((arg) => !/^--games=\d+$/.test(arg)) || raw.length > 1) throw new Error("Usage: --games=250");
  const games = raw[0] === undefined ? 250 : Number(raw[0].slice(8));
  if (!Number.isInteger(games) || games < 1 || games > 10000) throw new Error("games must be 1..10000");
  const matrix = (rules: CandidateSimulationRules, transform: (board: EconomyBoard) => EconomyBoard = (board) => board) => [STANDARD_CANDIDATE, GRAND_CANDIDATE].flatMap((board) =>
    PLAYER_COUNT_MATRIX[board.kind].map((players) => runConfiguration(transform(board), players, games, rules)),
  );
  console.log(JSON.stringify({
    schema: "ECON-001-reconciliation@1",
    gamesPerConfiguration: games,
    seedBase: "0x5eed0008",
    rules: CANDIDATE_SIMULATION_RULES,
    baseline: runBaselineMatrix(games),
    reconciledOneAction: matrix({ ...CANDIDATE_SIMULATION_RULES, developmentActions: 1 }),
    candidate: matrix(CANDIDATE_SIMULATION_RULES),
    ablations: {
      noLandingBonus: matrix({ ...CANDIDATE_SIMULATION_RULES, startLandingBonus: 0 }),
      noHoldingFee: matrix({ ...CANDIDATE_SIMULATION_RULES, holdingReleaseFee: 0 }),
      historicalUtilityCard: matrix({ ...CANDIDATE_SIMULATION_RULES, utilityCardUsesDice: false }),
      historicalRedemption: matrix(CANDIDATE_SIMULATION_RULES, (board) => ({ ...board,
        sets: board.sets.map((set) => ({ ...set, properties: set.properties.map((p) => ({ ...p, unmortgageCost: Math.ceil(p.mortgageValue * 1.1) })) })),
        transit: { ...board.transit, unmortgageCost: Math.ceil(board.transit.mortgageValue * 1.1) },
      })),
      thirdUtility: matrix(CANDIDATE_SIMULATION_RULES, (board) => board.kind === "standard" ? board : ({ ...board,
        tiles: board.tiles.map((tile) => tile.index === 31 ? { index: 31, type: "utility", name: "Third Utility" } : tile),
        utility: { ...board.utility, rentMultipliers: [4, 10, 15] },
      })),
    },
    grandB: PLAYER_COUNT_MATRIX.grand.map((players) => runConfiguration(GRAND_CANDIDATE, players, games, { ...CANDIDATE_SIMULATION_RULES, movement: "turbo" })),
    grandC: PLAYER_COUNT_MATRIX.grand.map((players) => runConfiguration(GRAND_CANDIDATE, players, games, { ...CANDIDATE_SIMULATION_RULES, movement: "transit" })),
    cashPresets: [1500, 2500].map((startingCash) => ({ startingCash, matrix: [STANDARD_CANDIDATE, GRAND_CANDIDATE].flatMap((board) =>
      PLAYER_COUNT_MATRIX[board.kind].map((players) => runConfiguration({ ...board, startingCash }, players, games, CANDIDATE_SIMULATION_RULES))),
    })),
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Unknown reconciliation error");
  process.exitCode = 1;
}
