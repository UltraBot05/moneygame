import { parseBoardDefinition, type BoardDefinition } from "./board";
import { CANDIDATE_RULES } from "./economy";

export interface MovementResult {
  readonly from: number;
  readonly distance: number;
  readonly to: number;
  readonly startCrossings: number;
  readonly startPasses: number;
  readonly passedStart: boolean;
  readonly landedOnStart: boolean;
  readonly startAward: number;
}

function safeIntegerInRange(
  value: number,
  name: string,
  minimum: number,
  maximum?: number,
): void {
  if (
    !Number.isSafeInteger(value)
    || value < minimum
    || (maximum !== undefined && value > maximum)
  ) {
    throw new RangeError(
      name + " must be a safe integer"
        + (maximum === undefined
          ? " >= " + minimum
          : " from " + minimum + " through " + maximum),
    );
  }
}

export function calculateMovement(
  boardInput: BoardDefinition,
  from: number,
  distance: number,
): MovementResult {
  const board = parseBoardDefinition(boardInput);
  safeIntegerInRange(from, "from", 0, board.tileCount - 1);
  safeIntegerInRange(distance, "distance", 1);

  const fullLaps = Math.floor(distance / board.tileCount);
  const remainder = distance % board.tileCount;
  const partialCrossing = from + remainder >= board.tileCount ? 1 : 0;
  const startCrossings = fullLaps + partialCrossing;
  const to = (from + remainder) % board.tileCount;
  const landedOnStart = to === 0;
  const startPasses = startCrossings - (landedOnStart ? 1 : 0);
  const startAward =
    startCrossings * board.economyProfile.startSalary
    + (landedOnStart ? CANDIDATE_RULES.startLandingBonus : 0);

  if (!Number.isSafeInteger(startAward)) {
    throw new RangeError("movement produces a Start award outside the safe integer range");
  }

  return Object.freeze({
    from,
    distance,
    to,
    startCrossings,
    startPasses,
    passedStart: startPasses > 0,
    landedOnStart,
    startAward,
  });
}
