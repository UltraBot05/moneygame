import {
  GRAND_ECONOMY,
  PLAYER_COUNT_MATRIX,
  STANDARD_ECONOMY,
  SURPRISE_CARDS,
  TREASURE_CARDS,
  type EconomyBoard,
  type EconomyCard,
  type PropertyEconomy,
  type PropertySetEconomy,
} from "./economy-data.ts";

export interface SimulationPolicy {
  readonly purchaseReserve: number;
  readonly developmentReserve: number;
  readonly auctionPriceFraction: number;
  readonly tradeMarkup: number;
}

export const BASELINE_POLICY: SimulationPolicy = Object.freeze({
  purchaseReserve: 200,
  developmentReserve: 300,
  auctionPriceFraction: 0.75,
  tradeMarkup: 1.25,
});

interface OwnableState {
  readonly tileIndex: number;
  readonly kind: "property" | "transit" | "utility";
  readonly propertyId?: string;
  owner: number | null;
  mortgaged: boolean;
  buildings: number;
}

interface PlayerSimulationState {
  readonly id: number;
  cash: number;
  position: number;
  active: boolean;
  skipTurns: number;
  rentHoliday: boolean;
  laps: number;
  rentCollected: number;
}

export interface PlayerCheckpoint {
  readonly playerId: number;
  readonly cash: number;
  readonly netWorth: number;
  readonly properties: number;
  readonly completeSets: number;
  readonly rentCollected: number;
}

export interface CashCheckpoint {
  readonly round: number;
  readonly cash: readonly number[];
  readonly gini: number;
  readonly players: readonly PlayerCheckpoint[];
}

export interface GameSimulationResult {
  readonly board: "standard" | "grand";
  readonly players: number;
  readonly seed: number;
  readonly turns: number;
  readonly rounds: number;
  readonly naturalWinner: boolean;
  readonly winnerId: number;
  readonly laps: number;
  readonly startIncome: number;
  readonly listedProperties: number;
  readonly auctionedProperties: number;
  readonly auctionSales: number;
  readonly purchases: number;
  readonly trades: number;
  readonly firstSetTurn: number | null;
  readonly firstBuildTurn: number | null;
  readonly holdingDevelopmentActions: number;
  readonly firstBankruptcyTurn: number | null;
  readonly eliminationTurns: readonly number[];
  readonly acquisitionTurns: Readonly<{ quarter: number | null; half: number | null; threeQuarter: number | null }>;
  readonly ownershipSaturation: number;
  readonly rentPaid: number;
  readonly topRentShare: number;
  readonly mortgageEvents: number;
  readonly unmortgageEvents: number;
  readonly liquidityEvents: number;
  readonly taxPaid: number;
  readonly cardBankNet: number;
  readonly bankruptcies: number;
  readonly checkpoints: readonly CashCheckpoint[];
}

export interface SummaryMetric {
  readonly median: number;
  readonly p10: number;
  readonly p90: number;
}

export interface HealthCriterion {
  readonly id: string;
  readonly passed: boolean;
  readonly observed: number;
  readonly comparator: "<=" | ">=";
  readonly threshold: number;
}

export interface SimulationSummary {
  readonly board: "standard" | "grand";
  readonly players: number;
  readonly games: number;
  readonly seedStart: number;
  readonly durationTurns: SummaryMetric;
  readonly durationRounds: SummaryMetric;
  readonly stalledRate: number;
  readonly earlyBankruptcyRate: number;
  readonly bankruptcies: SummaryMetric;
  readonly lapsPerPlayer: SummaryMetric;
  readonly startIncomePerPlayer: SummaryMetric;
  readonly ownershipSaturation: SummaryMetric;
  readonly firstSetRate: number;
  readonly firstBuildRate: number;
  readonly bankruptcyGameRate: number;
  readonly firstSetTurn: SummaryMetric | null;
  readonly firstBuildTurn: SummaryMetric | null;
  readonly firstBankruptcyTurn: SummaryMetric | null;
  readonly acquisitionQuarterTurn: SummaryMetric | null;
  readonly acquisitionHalfTurn: SummaryMetric | null;
  readonly acquisitionThreeQuarterTurn: SummaryMetric | null;
  readonly auctionToListRatio: number;
  readonly auctionSaleRate: number;
  readonly rentToStartIncome: SummaryMetric;
  readonly topRentShare: SummaryMetric;
  readonly mortgageEvents: SummaryMetric;
  readonly unmortgageEvents: SummaryMetric;
  readonly liquidityEvents: SummaryMetric;
  readonly taxPaidPerPlayer: SummaryMetric;
  readonly cardBankNetPerPlayer: SummaryMetric;
  readonly cashAtRounds: Readonly<Record<string, SummaryMetric | null>>;
  readonly cashGiniAtRounds: Readonly<Record<string, SummaryMetric | null>>;
  readonly winnerCorrelationsAtRound10: Readonly<{
    cash: number;
    netWorth: number;
    properties: number;
    rentCollected: number;
  }>;
  readonly round10LeaderWinRate: number;
  readonly criteria: readonly HealthCriterion[];
  readonly decision: "PASS" | "FAIL";
}

export function specialLandingRent(ordinaryRent: number, diceTotal: number, multiplier: number, utilityDiceRent = false): number {
  return (utilityDiceRent ? diceTotal : ordinaryRent) * multiplier;
}

export interface CandidateSimulationRules {
  readonly developmentActions?: number;
  readonly movement?: "core" | "turbo" | "transit";
  readonly startLandingBonus?: number;
  readonly holdingReleaseFee?: number;
  readonly utilityCardUsesDice?: boolean;
}

export interface SimulationConfig extends CandidateSimulationRules {
  readonly board: EconomyBoard;
  readonly players: number;
  readonly seed: number;
  readonly policy?: SimulationPolicy;
  readonly maxRounds?: number;
  readonly rentMultiplier?: number;
  readonly developmentRentMultiplier?: number;
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value |= 0;
    value = (value + 0x6d2b79f5) | 0;
    let mixed = Math.imul(value ^ (value >>> 15), 1 | value);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffle<T>(source: readonly T[], random: () => number): T[] {
  const output = source.slice();
  for (let index = output.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(random() * (index + 1));
    const current = output[index];
    const swap = output[swapIndex];
    if (current === undefined || swap === undefined) throw new Error("shuffle index out of range");
    output[index] = swap;
    output[swapIndex] = current;
  }
  return output;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) return 0;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[middle - 1];
  return lower === undefined ? upper : (lower + upper) / 2;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function metric(values: readonly number[]): SummaryMetric {
  return {
    median: median(values),
    p10: percentile(values, 0.1),
    p90: percentile(values, 0.9),
  };
}

function gini(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const minimum = Math.min(...values);
  const shifted = values.map((value) => value - Math.min(0, minimum));
  const sorted = shifted.sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  if (total === 0) return 0;
  let weighted = 0;
  sorted.forEach((value, index) => {
    weighted += (index + 1) * value;
  });
  return (2 * weighted) / (sorted.length * total) - (sorted.length + 1) / sorted.length;
}

function correlation(xs: readonly number[], ys: readonly number[]): number {
  if (xs.length !== ys.length || xs.length < 2) return 0;
  const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  let numerator = 0;
  let denominatorX = 0;
  let denominatorY = 0;
  for (let index = 0; index < xs.length; index++) {
    const x = (xs[index] ?? 0) - meanX;
    const y = (ys[index] ?? 0) - meanY;
    numerator += x * y;
    denominatorX += x * x;
    denominatorY += y * y;
  }
  const denominator = Math.sqrt(denominatorX * denominatorY);
  return denominator === 0 ? 0 : numerator / denominator;
}

function roundToTen(value: number): number {
  return Math.ceil(value / 10) * 10;
}

function ownablePrice(board: EconomyBoard, ownable: OwnableState, properties: ReadonlyMap<string, PropertyEconomy>): number {
  if (ownable.kind === "transit") return board.transit.price;
  if (ownable.kind === "utility") return board.utility.price;
  const property = ownable.propertyId === undefined ? undefined : properties.get(ownable.propertyId);
  if (property === undefined) throw new Error("missing property economy");
  return property.price;
}

function completeSetCount(
  playerId: number,
  sets: readonly PropertySetEconomy[],
  ownables: readonly OwnableState[],
): number {
  return sets.filter((set) =>
    set.properties.every((property) =>
      ownables.some((ownable) => ownable.propertyId === property.id && ownable.owner === playerId),
    ),
  ).length;
}

function netWorth(
  player: PlayerSimulationState,
  board: EconomyBoard,
  ownables: readonly OwnableState[],
  properties: ReadonlyMap<string, PropertyEconomy>,
): number {
  let total = player.cash;
  for (const ownable of ownables) {
    if (ownable.owner !== player.id) continue;
    total += ownable.mortgaged
      ? ownable.kind === "property"
        ? properties.get(ownable.propertyId ?? "")?.mortgageValue ?? 0
        : ownable.kind === "transit"
          ? board.transit.mortgageValue
          : board.utility.mortgageValue
      : ownablePrice(board, ownable, properties);
    if (ownable.kind === "property") {
      const property = properties.get(ownable.propertyId ?? "");
      total += (property?.buildingCost ?? 0) * ownable.buildings;
    }
  }
  return total;
}

export function simulateGame(config: SimulationConfig): GameSimulationResult {
  const { board } = config;
  if (config.players < board.recommendedPlayers.min || config.players > board.recommendedPlayers.max) {
    throw new Error(`${board.ref} does not support ${config.players} players in SPIKE-008`);
  }
  const policy = config.policy ?? BASELINE_POLICY;
  const maxRounds = config.maxRounds ?? (board.kind === "standard" ? 90 : 80);
  const rentMultiplier = config.rentMultiplier ?? 1;
  const developmentRentMultiplier = config.developmentRentMultiplier ?? 1;
  const random = mulberry32(config.seed);
  const properties = new Map(
    board.sets.flatMap((set) => set.properties).map((property) => [property.id, property] as const),
  );
  const players: PlayerSimulationState[] = Array.from({ length: config.players }, (_, id) => ({
    id,
    cash: board.startingCash,
    position: 0,
    active: true,
    skipTurns: 0,
    rentHoliday: false,
    laps: 0,
    rentCollected: 0,
  }));
  const ownables: OwnableState[] = board.tiles.flatMap<OwnableState>((tile) => {
    if (tile.type === "property") {
      return [{ tileIndex: tile.index, kind: "property" as const, propertyId: tile.propertyId, owner: null, mortgaged: false, buildings: 0 }];
    }
    if (tile.type === "transit" || tile.type === "utility") {
      return [{ tileIndex: tile.index, kind: tile.type, owner: null, mortgaged: false, buildings: 0 }];
    }
    return [];
  });
  const ownableByTile = new Map(ownables.map((ownable) => [ownable.tileIndex, ownable] as const));
  const surprise = shuffle(SURPRISE_CARDS, random);
  const treasure = shuffle(TREASURE_CARDS, random);
  let surprisePointer = 0;
  let treasurePointer = 0;

  let turns = 0;
  let seatSteps = 0;
  let startIncome = 0;
  let listedProperties = 0;
  let auctionedProperties = 0;
  let auctionSales = 0;
  let purchases = 0;
  let trades = 0;
  let firstSetTurn: number | null = null;
  let firstBuildTurn: number | null = null;
  let holdingDevelopmentActions = 0;
  let firstBankruptcyTurn: number | null = null;
  let mortgageEvents = 0;
  let unmortgageEvents = 0;
  let liquidityEvents = 0;
  let taxPaid = 0;
  let cardBankNet = 0;
  let rentPaid = 0;
  let bankruptcies = 0;
  const eliminationTurns: number[] = [];
  const checkpoints: CashCheckpoint[] = [];
  const acquisitionTurns: { quarter: number | null; half: number | null; threeQuarter: number | null } = {
    quarter: null,
    half: null,
    threeQuarter: null,
  };
  const propertyCount = board.sets.reduce((sum, set) => sum + set.properties.length, 0);

  const player = (id: number): PlayerSimulationState => {
    const found = players[id];
    if (found === undefined) throw new Error(`Unknown player ${id}`);
    return found;
  };

  const setOwnables = (set: PropertySetEconomy): OwnableState[] =>
    set.properties.map((property) => {
      const found = ownables.find((ownable) => ownable.propertyId === property.id);
      if (found === undefined) throw new Error(`Missing ownable for ${property.id}`);
      return found;
    });

  const hasCompleteSet = (playerId: number, set: PropertySetEconomy): boolean =>
    setOwnables(set).every((ownable) => ownable.owner === playerId);

  const noteAcquisition = (): void => {
    const owned = ownables.filter((ownable) => ownable.kind === "property" && ownable.owner !== null).length;
    const saturation = owned / propertyCount;
    if (acquisitionTurns.quarter === null && saturation >= 0.25) acquisitionTurns.quarter = turns;
    if (acquisitionTurns.half === null && saturation >= 0.5) acquisitionTurns.half = turns;
    if (acquisitionTurns.threeQuarter === null && saturation >= 0.75) acquisitionTurns.threeQuarter = turns;
    if (
      firstSetTurn === null &&
      players.some((candidate) => candidate.active && completeSetCount(candidate.id, board.sets, ownables) > 0)
    ) {
      firstSetTurn = turns;
    }
  };

  const mortgageValue = (ownable: OwnableState): number => {
    if (ownable.kind === "transit") return board.transit.mortgageValue;
    if (ownable.kind === "utility") return board.utility.mortgageValue;
    return properties.get(ownable.propertyId ?? "")?.mortgageValue ?? 0;
  };

  const unmortgageCost = (ownable: OwnableState): number => {
    if (ownable.kind === "transit") return board.transit.unmortgageCost;
    if (ownable.kind === "utility") return board.utility.unmortgageCost;
    return properties.get(ownable.propertyId ?? "")?.unmortgageCost ?? 0;
  };

  const canMortgage = (ownable: OwnableState): boolean => {
    if (ownable.mortgaged || ownable.owner === null) return false;
    if (ownable.kind !== "property") return true;
    const property = properties.get(ownable.propertyId ?? "");
    const set = board.sets.find((candidate) => candidate.id === property?.setId);
    return set !== undefined && setOwnables(set).every((candidate) => candidate.buildings === 0);
  };

  const liquidate = (debtor: PlayerSimulationState, amount: number): void => {
    while (debtor.cash < amount) {
      const developed = ownables
        .filter((ownable) => ownable.owner === debtor.id && ownable.kind === "property" && ownable.buildings > 0)
        .sort((a, b) => b.buildings - a.buildings || a.tileIndex - b.tileIndex)[0];
      if (developed !== undefined) {
        const property = properties.get(developed.propertyId ?? "");
        developed.buildings -= 1;
        debtor.cash += property?.buildingSellBack ?? 0;
        liquidityEvents += 1;
        continue;
      }
      const mortgage = ownables
        .filter((ownable) => ownable.owner === debtor.id && canMortgage(ownable))
        .sort(
          (a, b) =>
            mortgageValue(b) - mortgageValue(a) ||
            ownablePrice(board, b, properties) - ownablePrice(board, a, properties) ||
            a.tileIndex - b.tileIndex,
        )[0];
      if (mortgage === undefined) break;
      mortgage.mortgaged = true;
      debtor.cash += mortgageValue(mortgage);
      mortgageEvents += 1;
      liquidityEvents += 1;
    }
  };

  const bankrupt = (debtor: PlayerSimulationState, creditorId: number | null): number => {
    const paid = debtor.cash;
    const creditor = creditorId === null ? null : player(creditorId);
    if (creditor?.active === true) creditor.cash += paid;
    debtor.cash = 0;
    debtor.active = false;
    bankruptcies += 1;
    eliminationTurns.push(turns);
    if (firstBankruptcyTurn === null) firstBankruptcyTurn = turns;
    for (const ownable of ownables) {
      if (ownable.owner !== debtor.id) continue;
      if (creditor?.active === true) {
        ownable.owner = creditor.id;
      } else {
        ownable.owner = null;
        ownable.mortgaged = false;
        ownable.buildings = 0;
      }
    }
    noteAcquisition();
    return paid;
  };

  const charge = (debtorId: number, amount: number, creditorId: number | null): number => {
    const debtor = player(debtorId);
    if (!debtor.active || amount <= 0) return 0;
    liquidate(debtor, amount);
    if (debtor.cash < amount) return bankrupt(debtor, creditorId);
    debtor.cash -= amount;
    if (creditorId !== null) player(creditorId).cash += amount;
    return amount;
  };

  const purchase = (buyer: PlayerSimulationState, ownable: OwnableState, price: number): void => {
    buyer.cash -= price;
    ownable.owner = buyer.id;
    purchases += 1;
    noteAcquisition();
  };

  const auction = (landingPlayer: PlayerSimulationState, ownable: OwnableState): void => {
    auctionedProperties += 1;
    const asking = roundToTen(ownablePrice(board, ownable, properties) * policy.auctionPriceFraction);
    const eligible = players
      .filter((candidate) => candidate.active && candidate.cash - asking >= policy.purchaseReserve)
      .sort((a, b) => b.cash - a.cash || ((a.id - landingPlayer.id + players.length) % players.length) - ((b.id - landingPlayer.id + players.length) % players.length));
    const winner = eligible[0];
    if (winner === undefined) return;
    purchase(winner, ownable, asking);
    auctionSales += 1;
  };

  const rentFor = (ownable: OwnableState, diceTotal: number): number => {
    if (ownable.owner === null || ownable.mortgaged) return 0;
    if (ownable.kind === "transit") {
      const count = ownables.filter((candidate) => candidate.kind === "transit" && candidate.owner === ownable.owner && !candidate.mortgaged).length;
      return board.transit.rents[Math.max(0, Math.min(3, count - 1))] ?? 0;
    }
    if (ownable.kind === "utility") {
      const count = ownables.filter((candidate) => candidate.kind === "utility" && candidate.owner === ownable.owner && !candidate.mortgaged).length;
      return diceTotal * (board.utility.rentMultipliers[Math.max(0, count - 1)] ?? 0);
    }
    const property = properties.get(ownable.propertyId ?? "");
    if (property === undefined) throw new Error("missing property rent");
    if (ownable.buildings > 0) {
      return Math.round(
        (property.developmentRents[Math.min(3, ownable.buildings - 1)] ?? 0) *
          developmentRentMultiplier,
      );
    }
    const set = board.sets.find((candidate) => candidate.id === property.setId);
    return set !== undefined && hasCompleteSet(ownable.owner, set) ? property.completeSetRent : property.baseRent;
  };

  function resolveOwnable(
    landingPlayer: PlayerSimulationState,
    ownable: OwnableState,
    diceTotal: number,
    specialRentMultiplier = 1,
    utilityDiceRent = false,
  ): void {
    if (!landingPlayer.active) return;
    if (ownable.owner === null) {
      listedProperties += 1;
      const price = ownablePrice(board, ownable, properties);
      if (landingPlayer.cash - price >= policy.purchaseReserve) purchase(landingPlayer, ownable, price);
      else auction(landingPlayer, ownable);
      return;
    }
    if (ownable.owner === landingPlayer.id || ownable.mortgaged) return;
    if (landingPlayer.rentHoliday) {
      landingPlayer.rentHoliday = false;
      return;
    }
    const owner = player(ownable.owner);
    if (!owner.active) return;
    const due = Math.round(specialLandingRent(rentFor(ownable, diceTotal), diceTotal, specialRentMultiplier, utilityDiceRent) * rentMultiplier);
    const paid = charge(landingPlayer.id, due, owner.id);
    rentPaid += paid;
    owner.rentCollected += paid;
  }

  const moveTo = (movingPlayer: PlayerSimulationState, tileIndex: number, collectStart: boolean): void => {
    if (collectStart && tileIndex <= movingPlayer.position) {
      movingPlayer.cash += board.startSalary;
      movingPlayer.laps += 1;
      startIncome += board.startSalary;
    }
    movingPlayer.position = tileIndex;
  };

  function resolveTile(landingPlayer: PlayerSimulationState, diceTotal: number, depth = 0): void {
    if (!landingPlayer.active || depth > 4) return;
    const tile = board.tiles[landingPlayer.position];
    if (tile === undefined) throw new Error("missing board tile");
    const ownable = ownableByTile.get(tile.index);
    if (ownable !== undefined) {
      resolveOwnable(landingPlayer, ownable, diceTotal);
      return;
    }
    if (tile.type === "tax") {
      taxPaid += charge(landingPlayer.id, tile.amount, null);
      return;
    }
    if (tile.type === "card") {
      const deck = tile.deck === "surprise" ? surprise : treasure;
      const pointer = tile.deck === "surprise" ? surprisePointer++ : treasurePointer++;
      const card = deck[pointer % deck.length];
      if (card === undefined) throw new Error("empty card deck");
      applyCard(landingPlayer, card, diceTotal, depth + 1);
      return;
    }
    if (tile.type === "corner" && tile.name === "GO TO HOLDING") {
      const holding = board.tiles.find((candidate) => candidate.type === "corner" && candidate.name === "HOLDING");
      if (holding !== undefined) landingPlayer.position = holding.index;
      landingPlayer.skipTurns = 1;
    }
  }

  function applyCard(
    cardPlayer: PlayerSimulationState,
    card: EconomyCard,
    diceTotal: number,
    depth: number,
  ): void {
    const effect = card.effect;
    switch (effect.kind) {
      case "bank":
        if (effect.amount >= 0) {
          cardPlayer.cash += effect.amount;
          cardBankNet += effect.amount;
        } else {
          const paid = charge(cardPlayer.id, -effect.amount, null);
          cardBankNet -= paid;
        }
        return;
      case "per-property": {
        const count = ownables.filter((ownable) => ownable.kind === "property" && ownable.owner === cardPlayer.id).length;
        const amount = effect.amount * count;
        if (amount >= 0) {
          cardPlayer.cash += amount;
          cardBankNet += amount;
        } else {
          const paid = charge(cardPlayer.id, -amount, null);
          cardBankNet -= paid;
        }
        return;
      }
      case "per-building": {
        const owned = ownables.filter((ownable) => ownable.kind === "property" && ownable.owner === cardPlayer.id);
        const amount = owned.reduce(
          (sum, ownable) =>
            sum +
            (ownable.buildings === 4
              ? effect.landmarkAmount
              : effect.blockAmount * ownable.buildings),
          0,
        );
        if (amount < 0) {
          const paid = charge(cardPlayer.id, -amount, null);
          cardBankNet -= paid;
        }
        return;
      }
      case "per-developed-property": {
        const count = ownables.filter(
          (ownable) => ownable.kind === "property" && ownable.owner === cardPlayer.id && ownable.buildings > 0,
        ).length;
        const paid = charge(cardPlayer.id, -effect.amount * count, null);
        cardBankNet -= paid;
        return;
      }
      case "per-player": {
        const others = players.filter((candidate) => candidate.active && candidate.id !== cardPlayer.id);
        if (effect.amount > 0) {
          for (const other of others) {
            const paid = charge(other.id, effect.amount, cardPlayer.id);
            if (!cardPlayer.active) break;
            if (paid === 0 && !other.active) continue;
          }
        } else {
          for (const other of others) {
            if (!cardPlayer.active) break;
            charge(cardPlayer.id, -effect.amount, other.id);
          }
        }
        return;
      }
      case "advance-start":
        cardPlayer.position = 0;
        cardPlayer.cash += effect.amount;
        cardPlayer.laps += 1;
        startIncome += effect.amount;
        return;
      case "move-nearest": {
        const targets = board.tiles.filter((candidate) => candidate.type === effect.tileType);
        const next = targets.find((candidate) => candidate.index > cardPlayer.position) ?? targets[0];
        if (next === undefined) return;
        moveTo(cardPlayer, next.index, true);
        const target = ownableByTile.get(next.index);
        if (target !== undefined) {
          const utilityDiceRent = config.utilityCardUsesDice === true && effect.tileType === "utility";
          const cardDice = utilityDiceRent ? 2 + Math.floor(random() * 6) + Math.floor(random() * 6) : diceTotal;
          resolveOwnable(cardPlayer, target, cardDice, effect.rentMultiplier, utilityDiceRent);
        }
        return;
      }
      case "move-back":
        cardPlayer.position = (cardPlayer.position - effect.spaces + board.tileCount) % board.tileCount;
        resolveTile(cardPlayer, diceTotal, depth);
        return;
      case "holding": {
        const holding = board.tiles.find((candidate) => candidate.type === "corner" && candidate.name === "HOLDING");
        if (holding !== undefined) cardPlayer.position = holding.index;
        cardPlayer.skipTurns = 1;
        return;
      }
      case "hold-rent-holiday":
        cardPlayer.rentHoliday = true;
        return;
      case "no-economic-effect":
        return;
    }
  }

  const develop = (developingPlayer: PlayerSimulationState): void => {
    for (const set of board.sets) {
      const setTiles = setOwnables(set);
      if (!hasCompleteSet(developingPlayer.id, set) || setTiles.some((ownable) => ownable.mortgaged)) continue;
      const minimum = Math.min(...setTiles.map((ownable) => ownable.buildings));
      if (minimum >= 4) continue;
      const target = setTiles
        .filter((ownable) => ownable.buildings === minimum)
        .sort((a, b) => a.tileIndex - b.tileIndex)[0];
      const property = properties.get(target?.propertyId ?? "");
      if (target === undefined || property === undefined) continue;
      if (developingPlayer.cash - property.buildingCost < policy.developmentReserve) continue;
      developingPlayer.cash -= property.buildingCost;
      target.buildings += 1;
      if (developingPlayer.skipTurns > 0) holdingDevelopmentActions += 1;
      if (firstBuildTurn === null) firstBuildTurn = turns;
      return;
    }
  };

  const restoreOneMortgage = (restoringPlayer: PlayerSimulationState): void => {
    const target = ownables
      .filter(
        (ownable) =>
          ownable.owner === restoringPlayer.id &&
          ownable.mortgaged &&
          restoringPlayer.cash - unmortgageCost(ownable) >= policy.purchaseReserve,
      )
      .sort((a, b) => unmortgageCost(a) - unmortgageCost(b) || a.tileIndex - b.tileIndex)[0];
    if (target === undefined) return;
    restoringPlayer.cash -= unmortgageCost(target);
    target.mortgaged = false;
    unmortgageEvents += 1;
  };

  const closeOneSetTrade = (): void => {
    for (const buyer of players) {
      if (!buyer.active) continue;
      for (const set of board.sets) {
        const setTiles = setOwnables(set);
        const buyerTiles = setTiles.filter((ownable) => ownable.owner === buyer.id);
        if (buyerTiles.length !== setTiles.length - 1) continue;
        const missing = setTiles.find((ownable) => ownable.owner !== buyer.id);
        if (
          missing === undefined ||
          missing.owner === null ||
          missing.buildings > 0 ||
          missing.mortgaged ||
          !player(missing.owner).active
        ) {
          continue;
        }
        const price = roundToTen(ownablePrice(board, missing, properties) * policy.tradeMarkup);
        if (buyer.cash - price < policy.purchaseReserve) continue;
        const seller = player(missing.owner);
        buyer.cash -= price;
        seller.cash += price;
        missing.owner = buyer.id;
        trades += 1;
        noteAcquisition();
        return;
      }
    }
  };

  const checkpoint = (round: number): void => {
    const rows = players.map((candidate): PlayerCheckpoint => ({
      playerId: candidate.id,
      cash: candidate.cash,
      netWorth: netWorth(candidate, board, ownables, properties),
      properties: ownables.filter((ownable) => ownable.kind === "property" && ownable.owner === candidate.id).length,
      completeSets: completeSetCount(candidate.id, board.sets, ownables),
      rentCollected: candidate.rentCollected,
    }));
    checkpoints.push({
      round,
      cash: Object.freeze(rows.map((row) => row.cash)),
      gini: gini(rows.map((row) => row.netWorth)),
      players: Object.freeze(rows),
    });
  };

  const checkpointRounds = new Set([5, 10, 20, 40]);
  while (seatSteps < maxRounds * config.players && players.filter((candidate) => candidate.active).length > 1) {
    const current = player(seatSteps % config.players);
    seatSteps += 1;
    if (current.active) {
      turns += 1;
      if (current.skipTurns > 0) {
        current.skipTurns -= 1;
        if (config.holdingReleaseFee !== undefined) charge(current.id, config.holdingReleaseFee, null);
      } else {
        // Design behavior says a double rolls again. Cap one turn at three
        // rolls because the future detention rule for repeated doubles is not
        // authored yet; the cap is a simulation circuit breaker, not a rule.
        let rollCount = 0;
        let rollAgain = true;
        while (rollAgain && current.active && current.skipTurns === 0 && rollCount < 3) {
          const dieA = 1 + Math.floor(random() * 6);
          const dieB = 1 + Math.floor(random() * 6);
          const total = dieA + dieB;
          const distance = total + (config.movement === "turbo" ? 1 + Math.floor(random() * 6) : 0);
          const next = (current.position + distance) % board.tileCount;
          moveTo(current, next, next < current.position);
          if (next === 0 && config.startLandingBonus !== undefined) {
            current.cash += config.startLandingBonus;
            startIncome += config.startLandingBonus;
          }
          resolveTile(current, total);
          if (config.movement === "transit" && current.active && board.tiles[current.position]?.type === "transit") {
            const destination = board.tiles.find((tile) => tile.type === "transit" && tile.index > current.position)
              ?? board.tiles.find((tile) => tile.type === "transit");
            if (destination !== undefined) {
              moveTo(current, destination.index, true);
              resolveTile(current, total);
            }
          }
          rollAgain = dieA === dieB;
          rollCount += 1;
        }
        if (current.active && (config.developmentActions === undefined || current.skipTurns === 0)) {
          restoreOneMortgage(current);
          for (let action = 0; action < (config.developmentActions ?? 1); action++) develop(current);
        }
      }
    }
    if (seatSteps % config.players === 0) {
      const round = seatSteps / config.players;
      closeOneSetTrade();
      if (checkpointRounds.has(round)) checkpoint(round);
    }
  }

  const active = players.filter((candidate) => candidate.active);
  const naturalWinner = active.length === 1;
  const winner = naturalWinner
    ? active[0]
    : players
        .slice()
        .sort(
          (a, b) =>
            netWorth(b, board, ownables, properties) - netWorth(a, board, ownables, properties) ||
            a.id - b.id,
        )[0];
  if (winner === undefined) throw new Error("simulation has no winner");
  const ownedProperties = ownables.filter(
    (ownable) => ownable.kind === "property" && ownable.owner !== null,
  ).length;
  const totalRentCollected = players.reduce((sum, candidate) => sum + candidate.rentCollected, 0);
  const topRent = Math.max(...players.map((candidate) => candidate.rentCollected));

  return {
    board: board.kind,
    players: config.players,
    seed: config.seed,
    turns,
    rounds: seatSteps / config.players,
    naturalWinner,
    winnerId: winner.id,
    laps: players.reduce((sum, candidate) => sum + candidate.laps, 0),
    startIncome,
    listedProperties,
    auctionedProperties,
    auctionSales,
    purchases,
    trades,
    firstSetTurn,
    firstBuildTurn,
    holdingDevelopmentActions,
    firstBankruptcyTurn,
    eliminationTurns: Object.freeze(eliminationTurns.slice()),
    acquisitionTurns: Object.freeze({ ...acquisitionTurns }),
    ownershipSaturation: ownedProperties / propertyCount,
    rentPaid,
    topRentShare: totalRentCollected === 0 ? 0 : topRent / totalRentCollected,
    mortgageEvents,
    unmortgageEvents,
    liquidityEvents,
    taxPaid,
    cardBankNet,
    bankruptcies,
    checkpoints: Object.freeze(checkpoints),
  };
}

function optionalMetric(values: readonly (number | null)[]): SummaryMetric | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : metric(present);
}

function checkpointRows(results: readonly GameSimulationResult[], round: number): PlayerCheckpoint[] {
  return results.flatMap(
    (result) => result.checkpoints.find((checkpoint) => checkpoint.round === round)?.players ?? [],
  );
}

function leaderWinRate(results: readonly GameSimulationResult[], round: number): number {
  const eligible = results.flatMap((result) => {
    const checkpoint = result.checkpoints.find((candidate) => candidate.round === round);
    if (checkpoint === undefined) return [];
    const leader = checkpoint.players
      .slice()
      .sort((a, b) => b.netWorth - a.netWorth || a.playerId - b.playerId)[0];
    return leader === undefined ? [] : [leader.playerId === result.winnerId ? 1 : 0];
  });
  return eligible.length === 0 ? 0 : eligible.reduce((sum, value) => sum + value, 0) / eligible.length;
}

function healthCriteria(summary: Omit<SimulationSummary, "criteria" | "decision">): readonly HealthCriterion[] {
  const maxMedianRounds =
    summary.board === "standard"
      ? summary.players <= 3
        ? 70
        : 60
      : summary.players <= 7
        ? 65
        : 55;
  const checks: HealthCriterion[] = [
    { id: "median-rounds-min", passed: summary.durationRounds.median >= 8, observed: summary.durationRounds.median, comparator: ">=", threshold: 8 },
    { id: "median-rounds-max", passed: summary.durationRounds.median <= maxMedianRounds, observed: summary.durationRounds.median, comparator: "<=", threshold: maxMedianRounds },
    { id: "stalled-rate", passed: summary.stalledRate <= 0.2, observed: summary.stalledRate, comparator: "<=", threshold: 0.2 },
    { id: "early-bankruptcy-rate", passed: summary.earlyBankruptcyRate <= 0.15, observed: summary.earlyBankruptcyRate, comparator: "<=", threshold: 0.15 },
    { id: "ownership-saturation", passed: summary.ownershipSaturation.median >= 0.72, observed: summary.ownershipSaturation.median, comparator: ">=", threshold: 0.72 },
    { id: "set-formation-rate", passed: summary.firstSetRate >= 0.75, observed: summary.firstSetRate, comparator: ">=", threshold: 0.75 },
    { id: "rent-vs-start-income-min", passed: summary.rentToStartIncome.median >= 0.15, observed: summary.rentToStartIncome.median, comparator: ">=", threshold: 0.15 },
    { id: "rent-vs-start-income-max", passed: summary.rentToStartIncome.median <= 5, observed: summary.rentToStartIncome.median, comparator: "<=", threshold: 5 },
    { id: "early-leader-win-rate", passed: summary.round10LeaderWinRate <= 0.75, observed: summary.round10LeaderWinRate, comparator: "<=", threshold: 0.75 },
  ];
  return Object.freeze(checks);
}

export function summarizeSimulations(results: readonly GameSimulationResult[]): SimulationSummary {
  const first = results[0];
  if (first === undefined) throw new Error("cannot summarize zero simulations");
  if (results.some((result) => result.board !== first.board || result.players !== first.players)) {
    throw new Error("simulation summary requires one board/player configuration");
  }
  const round10Rows = checkpointRows(results, 10);
  const winnerFlags = results.flatMap((result) => {
    const checkpoint = result.checkpoints.find((candidate) => candidate.round === 10);
    return checkpoint?.players.map((row) => (row.playerId === result.winnerId ? 1 : 0)) ?? [];
  });
  const checkpointMetric = (round: number, select: (checkpoint: CashCheckpoint) => readonly number[]): SummaryMetric | null => {
    const values = results.flatMap((result) => {
      const checkpoint = result.checkpoints.find((candidate) => candidate.round === round);
      return checkpoint === undefined ? [] : select(checkpoint);
    });
    return values.length === 0 ? null : metric(values);
  };
  const base = {
    board: first.board,
    players: first.players,
    games: results.length,
    seedStart: first.seed,
    durationTurns: metric(results.map((result) => result.turns)),
    durationRounds: metric(results.map((result) => result.rounds)),
    stalledRate: results.filter((result) => !result.naturalWinner).length / results.length,
    earlyBankruptcyRate:
      results.filter(
        (result) =>
          result.firstBankruptcyTurn !== null &&
          result.firstBankruptcyTurn <= result.players * 5,
      ).length / results.length,
    bankruptcies: metric(results.map((result) => result.bankruptcies)),
    lapsPerPlayer: metric(results.map((result) => result.laps / result.players)),
    startIncomePerPlayer: metric(results.map((result) => result.startIncome / result.players)),
    ownershipSaturation: metric(results.map((result) => result.ownershipSaturation)),
    firstSetRate: results.filter((result) => result.firstSetTurn !== null).length / results.length,
    firstBuildRate: results.filter((result) => result.firstBuildTurn !== null).length / results.length,
    bankruptcyGameRate: results.filter((result) => result.firstBankruptcyTurn !== null).length / results.length,
    firstSetTurn: optionalMetric(results.map((result) => result.firstSetTurn)),
    firstBuildTurn: optionalMetric(results.map((result) => result.firstBuildTurn)),
    firstBankruptcyTurn: optionalMetric(results.map((result) => result.firstBankruptcyTurn)),
    acquisitionQuarterTurn: optionalMetric(results.map((result) => result.acquisitionTurns.quarter)),
    acquisitionHalfTurn: optionalMetric(results.map((result) => result.acquisitionTurns.half)),
    acquisitionThreeQuarterTurn: optionalMetric(results.map((result) => result.acquisitionTurns.threeQuarter)),
    auctionToListRatio:
      results.reduce((sum, result) => sum + result.auctionedProperties, 0) /
      Math.max(1, results.reduce((sum, result) => sum + result.listedProperties, 0)),
    auctionSaleRate:
      results.reduce((sum, result) => sum + result.auctionSales, 0) /
      Math.max(1, results.reduce((sum, result) => sum + result.auctionedProperties, 0)),
    rentToStartIncome: metric(
      results.map((result) => result.rentPaid / Math.max(1, result.startIncome)),
    ),
    topRentShare: metric(results.map((result) => result.topRentShare)),
    mortgageEvents: metric(results.map((result) => result.mortgageEvents)),
    unmortgageEvents: metric(results.map((result) => result.unmortgageEvents)),
    liquidityEvents: metric(results.map((result) => result.liquidityEvents)),
    taxPaidPerPlayer: metric(results.map((result) => result.taxPaid / result.players)),
    cardBankNetPerPlayer: metric(results.map((result) => result.cardBankNet / result.players)),
    cashAtRounds: Object.freeze({
      "5": checkpointMetric(5, (checkpoint) => checkpoint.cash),
      "10": checkpointMetric(10, (checkpoint) => checkpoint.cash),
      "20": checkpointMetric(20, (checkpoint) => checkpoint.cash),
      "40": checkpointMetric(40, (checkpoint) => checkpoint.cash),
    }),
    cashGiniAtRounds: Object.freeze({
      "5": checkpointMetric(5, (checkpoint) => [checkpoint.gini]),
      "10": checkpointMetric(10, (checkpoint) => [checkpoint.gini]),
      "20": checkpointMetric(20, (checkpoint) => [checkpoint.gini]),
      "40": checkpointMetric(40, (checkpoint) => [checkpoint.gini]),
    }),
    winnerCorrelationsAtRound10: Object.freeze({
      cash: correlation(round10Rows.map((row) => row.cash), winnerFlags),
      netWorth: correlation(round10Rows.map((row) => row.netWorth), winnerFlags),
      properties: correlation(round10Rows.map((row) => row.properties), winnerFlags),
      rentCollected: correlation(round10Rows.map((row) => row.rentCollected), winnerFlags),
    }),
    round10LeaderWinRate: leaderWinRate(results, 10),
  } satisfies Omit<SimulationSummary, "criteria" | "decision">;
  const criteria = healthCriteria(base);
  return Object.freeze({
    ...base,
    criteria,
    decision: criteria.every((criterion) => criterion.passed) ? "PASS" : "FAIL",
  });
}

export function configurationSeed(
  board: "standard" | "grand",
  players: number,
  caseIndex: number,
  seedBase = 0x5eed_0008,
): number {
  const boardSalt = board === "standard" ? 0x40a1 : 0x52b1;
  return (seedBase ^ boardSalt ^ Math.imul(players, 0x9e37) ^ Math.imul(caseIndex + 1, 0x85eb_ca6b)) >>> 0;
}

export function runConfiguration(
  board: EconomyBoard,
  players: number,
  games: number,
  options: Readonly<CandidateSimulationRules & {
    seedBase?: number;
    rentMultiplier?: number;
    developmentRentMultiplier?: number;
    policy?: SimulationPolicy;
  }> = {},
): SimulationSummary {
  const seedBase = options.seedBase ?? 0x5eed_0008;
  const results = Array.from({ length: games }, (_, caseIndex) =>
    simulateGame({
      ...options,
      board,
      players,
      seed: configurationSeed(board.kind, players, caseIndex, seedBase),
      ...(options.rentMultiplier === undefined ? {} : { rentMultiplier: options.rentMultiplier }),
      ...(options.developmentRentMultiplier === undefined
        ? {}
        : { developmentRentMultiplier: options.developmentRentMultiplier }),
      ...(options.policy === undefined ? {} : { policy: options.policy }),
    }),
  );
  return summarizeSimulations(results);
}

export function runBaselineMatrix(gamesPerConfiguration: number): readonly SimulationSummary[] {
  return Object.freeze([
    ...PLAYER_COUNT_MATRIX.standard.map((players) =>
      runConfiguration(STANDARD_ECONOMY, players, gamesPerConfiguration),
    ),
    ...PLAYER_COUNT_MATRIX.grand.map((players) =>
      runConfiguration(GRAND_ECONOMY, players, gamesPerConfiguration),
    ),
  ]);
}
