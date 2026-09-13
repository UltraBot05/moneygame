import { randomInteger, type RandomSource } from "./random";

export interface DiceRoll {
  readonly dice: readonly [number, number];
  readonly total: number;
  readonly doubles: boolean;
  readonly consecutiveDoubles: number;
  readonly isThirdConsecutiveDouble: boolean;
}

export function rollDice(
  rng: RandomSource,
  previousConsecutiveDoubles = 0,
): DiceRoll {
  if (!Number.isSafeInteger(previousConsecutiveDoubles) || previousConsecutiveDoubles < 0) {
    throw new RangeError("previous consecutive doubles must be a non-negative safe integer");
  }

  const first = randomInteger(rng, 1, 7);
  const second = randomInteger(rng, 1, 7);
  const doubles = first === second;
  const consecutiveDoubles = doubles ? previousConsecutiveDoubles + 1 : 0;
  if (!Number.isSafeInteger(consecutiveDoubles)) {
    throw new RangeError("consecutive doubles cannot exceed Number.MAX_SAFE_INTEGER");
  }

  const dice: readonly [number, number] = [first, second];
  Object.freeze(dice);
  return Object.freeze({
    dice,
    total: first + second,
    doubles,
    consecutiveDoubles,
    isThirdConsecutiveDouble: doubles && consecutiveDoubles === 3,
  });
}
