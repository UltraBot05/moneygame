import { describe, expect, it } from "vitest";
import { rollDice } from "./dice";
import { createSeededRandom } from "./random";

describe("CORE-007 authoritative deterministic dice", () => {
  it("returns two d6 values, their total, and exact doubles detection", () => {
    const values = [0, 0.999999, 0.4, 0.4];
    let index = 0;
    const first = rollDice(() => values[index++] as number);
    const second = rollDice(() => values[index++] as number);

    expect(first).toMatchObject({ dice: [1, 6], total: 7, doubles: false });
    expect(second).toMatchObject({ dice: [3, 3], total: 6, doubles: true });
    for (const die of [...first.dice, ...second.dice]) {
      expect(die).toBeGreaterThanOrEqual(1);
      expect(die).toBeLessThanOrEqual(6);
    }
  });

  it("replays the same sequence for the same seed and can vary by seed", () => {
    const sequence = (seed: number) => {
      const rng = createSeededRandom(seed);
      return Array.from({ length: 12 }, () => rollDice(rng));
    };

    expect(sequence(9182)).toEqual(sequence(9182));
    expect(sequence(9182)).not.toEqual(sequence(9183));
  });

  it("tracks consecutive doubles without implementing Holding behavior", () => {
    const double = () => 0;
    expect(rollDice(double, 0)).toMatchObject({
      consecutiveDoubles: 1,
      isThirdConsecutiveDouble: false,
    });
    expect(rollDice(double, 2)).toMatchObject({
      consecutiveDoubles: 3,
      isThirdConsecutiveDouble: true,
    });
    const nonDoubleValues = [0, 0.5];
    let index = 0;
    expect(rollDice(() => nonDoubleValues[index++] as number, 2)).toMatchObject({
      consecutiveDoubles: 0,
      isThirdConsecutiveDouble: false,
    });
  });

  it("rejects invalid prior state and invalid injected randomness", () => {
    expect(() => rollDice(() => 0, -1)).toThrow(RangeError);
    expect(() => rollDice(() => 1)).toThrow(RangeError);
  });
});
