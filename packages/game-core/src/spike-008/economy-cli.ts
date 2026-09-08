declare const process: { readonly argv: readonly string[]; exitCode?: number };
declare const console: { log(message: string): void; error(message: string): void };

import { GRAND_ECONOMY, STANDARD_ECONOMY } from "./economy-data.ts";
import {
  BASELINE_POLICY,
  runBaselineMatrix,
  runConfiguration,
  type SimulationPolicy,
} from "./economy-simulator.ts";

function gamesArgument(args: readonly string[]): number {
  const raw = args.find((argument) => argument.startsWith("--games="))?.slice("--games=".length);
  const games = raw === undefined ? 250 : Number(raw);
  if (!Number.isInteger(games) || games < 1 || games > 10_000) {
    throw new Error("--games must be an integer from 1 through 10000");
  }
  return games;
}

try {
  const gamesPerConfiguration = gamesArgument(process.argv.slice(2));
  const startedAt = Date.now();
  const baseline = runBaselineMatrix(gamesPerConfiguration);
  const sensitivityGames = Math.min(100, gamesPerConfiguration);
  const failingPacingConfigurations = [
    { board: STANDARD_ECONOMY, players: 5 },
    { board: STANDARD_ECONOMY, players: 6 },
    { board: GRAND_ECONOMY, players: 8 },
    { board: GRAND_ECONOMY, players: 9 },
    { board: GRAND_ECONOMY, players: 10 },
  ] as const;
  const developmentRentSensitivity = [1.1, 1.2].flatMap((factor) =>
    failingPacingConfigurations.map(({ board, players }) => ({
      factor,
      summary: runConfiguration(board, players, sensitivityGames, {
        developmentRentMultiplier: factor,
      }),
    })),
  );
  const policySensitivity: readonly { name: string; policy: SimulationPolicy }[] = [
    {
      name: "aggressive-liquidity",
      policy: { ...BASELINE_POLICY, purchaseReserve: 100, developmentReserve: 200 },
    },
    {
      name: "cautious-liquidity",
      policy: { ...BASELINE_POLICY, purchaseReserve: 400, developmentReserve: 500 },
    },
  ];
  const purchasePolicySensitivity = policySensitivity.flatMap(({ name, policy }) =>
    failingPacingConfigurations.map(({ board, players }) => ({
      name,
      summary: runConfiguration(board, players, sensitivityGames, { policy }),
    })),
  );
  const negativeProof = runConfiguration(STANDARD_ECONOMY, 4, Math.min(100, gamesPerConfiguration), {
    seedBase: 0xbad0_0008,
    rentMultiplier: 25,
  });
  console.log(
    JSON.stringify(
      {
        schema: "SPIKE-008-economy-report@1",
        gamesPerConfiguration,
        seedPolicy: "configurationSeed(board, players, caseIndex, 0x5eed0008)",
        baseline,
        sensitivityGames,
        developmentRentSensitivity,
        purchasePolicySensitivity,
        negativeProof,
        runtimeMs: Date.now() - startedAt,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Unknown simulation error");
  process.exitCode = 1;
}
