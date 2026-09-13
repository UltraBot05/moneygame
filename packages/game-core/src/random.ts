export type RandomSource = () => number;

export function createSeededRandom(seed: number): RandomSource {
  if (!Number.isSafeInteger(seed)) {
    throw new RangeError("seed must be a safe integer");
  }

  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function sample(rng: RandomSource): number {
  const value = rng();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError("random source must return a value in [0, 1)");
  }
  return value;
}

export function randomInteger(
  rng: RandomSource,
  minimumInclusive: number,
  maximumExclusive: number,
): number {
  if (
    !Number.isSafeInteger(minimumInclusive)
    || !Number.isSafeInteger(maximumExclusive)
    || maximumExclusive <= minimumInclusive
  ) {
    throw new RangeError("random integer bounds must be safe integers with max > min");
  }
  return minimumInclusive + Math.floor(sample(rng) * (maximumExclusive - minimumInclusive));
}

export function shuffle<T>(items: readonly T[], rng: RandomSource): T[] {
  const shuffled = items.slice();
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInteger(rng, 0, index + 1);
    const current = shuffled[index];
    shuffled[index] = shuffled[swapIndex] as T;
    shuffled[swapIndex] = current as T;
  }
  return shuffled;
}
