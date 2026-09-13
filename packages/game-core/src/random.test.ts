import { describe, expect, it } from "vitest";
import { createSeededRandom, randomInteger, shuffle } from "./random";

describe("CORE-003 injected deterministic randomness", () => {
  it("produces identical sequences and shuffles for the same seed", () => {
    const first = createSeededRandom(12345);
    const second = createSeededRandom(12345);
    expect(Array.from({ length: 12 }, () => first())).toEqual(
      Array.from({ length: 12 }, () => second()),
    );

    const input = ["a", "b", "c", "d", "e", "f"];
    const firstShuffle = shuffle(input, createSeededRandom(77));
    const replayedShuffle = shuffle(input, createSeededRandom(77));
    const differentSeedShuffle = shuffle(input, createSeededRandom(78));
    expect(firstShuffle).toEqual(replayedShuffle);
    expect(firstShuffle).not.toEqual(differentSeedShuffle);
    expect(input).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("uses the injected source for bounded integer outcomes", () => {
    expect(randomInteger(() => 0, 2, 8)).toBe(2);
    expect(randomInteger(() => 0.999999, 2, 8)).toBe(7);
  });

  it("rejects invalid seeds, sources, and bounds", () => {
    expect(() => createSeededRandom(1.5)).toThrow(RangeError);
    expect(() => randomInteger(() => 1, 0, 6)).toThrow(RangeError);
    expect(() => randomInteger(() => 0.5, 6, 6)).toThrow(RangeError);
  });
});
