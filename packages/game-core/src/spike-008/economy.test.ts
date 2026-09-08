import { describe, expect, it } from "vitest";
import {
  ECONOMY_RULES,
  GRAND_ECONOMY,
  PLAYER_COUNT_MATRIX,
  STANDARD_ECONOMY,
  type EconomyBoard,
} from "./economy-data.ts";
import {
  configurationSeed,
  runConfiguration,
  simulateGame,
  summarizeSimulations,
} from "./economy-simulator.ts";

const BOARDS = [STANDARD_ECONOMY, GRAND_ECONOMY] as const;

function allProperties(board: EconomyBoard) {
  return board.sets.flatMap((set) => set.properties);
}

describe("SPIKE-008 economy fixture", () => {
  it("matches immutable board counts and numbered positions", () => {
    expect(STANDARD_ECONOMY.tiles).toHaveLength(40);
    expect(GRAND_ECONOMY.tiles).toHaveLength(52);
    expect(allProperties(STANDARD_ECONOMY)).toHaveLength(22);
    expect(allProperties(GRAND_ECONOMY)).toHaveLength(30);
    expect(STANDARD_ECONOMY.sets).toHaveLength(8);
    expect(GRAND_ECONOMY.sets).toHaveLength(12);
    expect(GRAND_ECONOMY.sets.map((set) => set.properties.length)).toEqual([
      2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3,
    ]);
    for (const board of BOARDS) {
      expect(board.tiles.map((tile) => tile.index)).toEqual(
        Array.from({ length: board.tileCount }, (_, index) => index),
      );
      expect(board.tiles.filter((tile) => tile.type === "corner")).toHaveLength(4);
      expect(board.tiles.filter((tile) => tile.type === "transit")).toHaveLength(4);
      expect(board.tiles.filter((tile) => tile.type === "tax")).toHaveLength(2);
      expect(board.tiles.filter((tile) => tile.type === "card" && tile.deck === "surprise")).toHaveLength(3);
      expect(board.tiles.filter((tile) => tile.type === "card" && tile.deck === "treasure")).toHaveLength(3);
    }
    expect(STANDARD_ECONOMY.tiles.filter((tile) => tile.type === "utility")).toHaveLength(2);
    expect(GRAND_ECONOMY.tiles.filter((tile) => tile.type === "utility")).toHaveLength(3);
    expect(GRAND_ECONOMY.tiles.filter((tile) => tile.type === "grand-special")).toHaveLength(3);
  });

  it("has exactly one valid tile reference for every property", () => {
    for (const board of BOARDS) {
      const propertyIds = new Set(allProperties(board).map((property) => property.id));
      const tileReferences = board.tiles.flatMap((tile) =>
        tile.type === "property" ? [tile.propertyId] : [],
      );
      expect(new Set(tileReferences)).toEqual(propertyIds);
      expect(tileReferences).toHaveLength(propertyIds.size);
    }
  });

  it("keeps all economy values possible and rent ladders monotonic", () => {
    for (const board of BOARDS) {
      expect(Number.isInteger(board.startingCash)).toBe(true);
      expect(Number.isInteger(board.startSalary)).toBe(true);
      expect(board.startingCash).toBeGreaterThan(0);
      expect(board.startSalary).toBeGreaterThan(0);
      for (const property of allProperties(board)) {
        const ladder = [
          property.baseRent,
          property.completeSetRent,
          ...property.developmentRents,
        ];
        expect([property.price, property.buildingCost, ...ladder].every(Number.isInteger)).toBe(true);
        expect([property.price, property.buildingCost, ...ladder].every((value) => value > 0)).toBe(true);
        for (let index = 1; index < ladder.length; index++) {
          expect(ladder[index]).toBeGreaterThanOrEqual(ladder[index - 1] ?? 0);
        }
      }
    }
  });

  it("applies canonical set, mortgage, unmortgage, and sell-back rules", () => {
    for (const board of BOARDS) {
      expect(board.startSalary).toBe(ECONOMY_RULES.referenceSalary);
      expect(board.startingCash).toBe(ECONOMY_RULES.defaultStartingCash);
      for (const property of allProperties(board)) {
        expect(property.completeSetRent).toBe(property.baseRent * 2);
        expect(property.mortgageValue).toBe(property.price * 0.5);
        expect(property.unmortgageCost).toBe(
          Math.ceil(property.mortgageValue * 1.1),
        );
        expect(property.buildingSellBack).toBe(property.buildingCost * 0.5);
      }
    }
  });

  it("keeps authored values board-specific and isolated", () => {
    expect(STANDARD_ECONOMY).not.toBe(GRAND_ECONOMY);
    expect(STANDARD_ECONOMY.sets).not.toBe(GRAND_ECONOMY.sets);
    expect(STANDARD_ECONOMY.tiles).not.toBe(GRAND_ECONOMY.tiles);
    expect(allProperties(STANDARD_ECONOMY).at(-1)?.price).toBe(400);
    expect(allProperties(GRAND_ECONOMY).at(-1)?.price).toBe(550);
  });
});

describe("SPIKE-008 deterministic simulation", () => {
  it("replays an identical game from the same seed and configuration", () => {
    const config = { board: STANDARD_ECONOMY, players: 4, seed: 0x0080_0042 };
    expect(simulateGame(config)).toEqual(simulateGame(config));
  });

  it("uses the fixed regression seed to reproduce an identical summary", () => {
    const runs = () =>
      Array.from({ length: 12 }, (_, caseIndex) =>
        simulateGame({
          board: GRAND_ECONOMY,
          players: 10,
          seed: configurationSeed("grand", 10, caseIndex, 0x0080_0001),
        }),
      );
    expect(summarizeSimulations(runs())).toEqual(summarizeSimulations(runs()));
  });

  it("runs every required player-count configuration", () => {
    const seen = [
      ...PLAYER_COUNT_MATRIX.standard.map((players) =>
        runConfiguration(STANDARD_ECONOMY, players, 2),
      ),
      ...PLAYER_COUNT_MATRIX.grand.map((players) =>
        runConfiguration(GRAND_ECONOMY, players, 2),
      ),
    ].map((summary) => `${summary.board}-${summary.players}`);
    expect(seen).toEqual([
      "standard-3", "standard-4", "standard-5", "standard-6",
      "grand-6", "grand-7", "grand-8", "grand-9", "grand-10",
    ]);
  });

  it("rejects a clearly broken absurd-rent control economy", () => {
    const broken = runConfiguration(STANDARD_ECONOMY, 4, 40, {
      seedBase: 0xbad0_0008,
      rentMultiplier: 25,
    });
    expect(broken.decision).toBe("FAIL");
    expect(
      broken.criteria.some(
        (criterion) =>
          !criterion.passed &&
          (criterion.id === "median-rounds-min" ||
            criterion.id === "early-bankruptcy-rate" ||
            criterion.id === "rent-vs-start-income-max"),
      ),
    ).toBe(true);
  });
});
