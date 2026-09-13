import { describe, expect, it } from "vitest";
import grandFixture from "../../../boards/world-tour/grand.json";
import standardFixture from "../../../boards/world-tour/standard.json";
import { parseBoardDefinition } from "./board";
import { calculateMovement } from "./movement";

const standard = parseBoardDefinition(standardFixture);
const grand = parseBoardDefinition(grandFixture);

describe("CORE-008 movement and Start accounting", () => {
  it("moves without wrap on both immutable board sizes", () => {
    expect(calculateMovement(standard, 3, 7)).toMatchObject({
      from: 3,
      to: 10,
      startCrossings: 0,
      startAward: 0,
    });
    expect(calculateMovement(grand, 41, 7)).toMatchObject({
      from: 41,
      to: 48,
      startCrossings: 0,
      startAward: 0,
    });
  });

  it("handles the Standard 39 to 0 and Grand 51 to 0 boundaries exactly", () => {
    expect(calculateMovement(standard, 39, 1)).toEqual({
      from: 39,
      distance: 1,
      to: 0,
      startCrossings: 1,
      startPasses: 0,
      passedStart: false,
      landedOnStart: true,
      startAward: 300,
    });
    expect(calculateMovement(grand, 51, 1)).toMatchObject({
      to: 0,
      startCrossings: 1,
      startPasses: 0,
      landedOnStart: true,
      startAward: 300,
    });
  });

  it("distinguishes passing Start from landing exactly on Start", () => {
    expect(calculateMovement(standard, 39, 2)).toMatchObject({
      to: 1,
      startCrossings: 1,
      startPasses: 1,
      passedStart: true,
      landedOnStart: false,
      startAward: 200,
    });
    expect(calculateMovement(grand, 47, 5)).toMatchObject({
      to: 0,
      startCrossings: 1,
      startPasses: 0,
      passedStart: false,
      landedOnStart: true,
      startAward: 300,
    });
  });

  it("counts every crossing over multiple laps, including an exact final landing", () => {
    expect(calculateMovement(standard, 39, 81)).toMatchObject({
      to: 0,
      startCrossings: 3,
      startPasses: 2,
      startAward: 700,
    });
    expect(calculateMovement(grand, 51, 106)).toMatchObject({
      to: 1,
      startCrossings: 3,
      startPasses: 3,
      startAward: 600,
    });
  });

  it.each([
    [-1, 1],
    [40, 1],
    [0, 0],
    [0, -1],
    [0, 1.5],
  ])("rejects invalid Standard movement from %s by %s", (from, distance) => {
    expect(() => calculateMovement(standard, from, distance)).toThrow(RangeError);
  });
});
