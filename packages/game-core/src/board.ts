import type {
  CardDeck,
  EconomyBoard,
  EconomyTile,
  PropertyEconomy,
  PropertySetEconomy,
} from "./economy";

export interface RecommendedPlayers {
  readonly min: number;
  readonly max: number;
}

export interface BoardDefinition {
  readonly ref: string;
  readonly boardId: string;
  readonly boardVersion: number;
  readonly tileCount: number;
  readonly recommendedPlayers: RecommendedPlayers;
  readonly status: "FROZEN_BASELINE";
  readonly economyProfile: EconomyBoard;
}

interface FrozenBoardMetadata {
  readonly boardId: string;
  readonly ref: string;
  readonly kind: EconomyBoard["kind"];
  readonly tileCount: number;
  readonly recommendedPlayers: RecommendedPlayers;
  readonly propertyCount: number;
  readonly setSizes: readonly number[];
  readonly tileTypeCounts: Readonly<Record<EconomyTile["type"], number>>;
  readonly deckCounts: Readonly<Record<CardDeck, number>>;
}

const FROZEN_BOARD_METADATA: readonly FrozenBoardMetadata[] = [
  {
    boardId: "world-tour-standard",
    ref: "world-tour-standard@1",
    kind: "standard",
    tileCount: 40,
    recommendedPlayers: { min: 3, max: 6 },
    propertyCount: 22,
    setSizes: [2, 2, 3, 3, 3, 3, 3, 3],
    deckCounts: { surprise: 3, treasure: 3 },
    tileTypeCounts: {
      corner: 4,
      property: 22,
      transit: 4,
      utility: 2,
      tax: 2,
      card: 6,
      "grand-special": 0,
    },
  },
  {
    boardId: "world-tour-grand",
    ref: "world-tour-grand@1",
    kind: "grand",
    tileCount: 52,
    recommendedPlayers: { min: 6, max: 10 },
    propertyCount: 30,
    setSizes: [2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3],
    deckCounts: { surprise: 4, treasure: 3 },
    tileTypeCounts: {
      corner: 4,
      property: 30,
      transit: 4,
      utility: 2,
      tax: 2,
      card: 7,
      "grand-special": 3,
    },
  },
];

const BOARD_KEYS = [
  "ref",
  "boardId",
  "boardVersion",
  "tileCount",
  "recommendedPlayers",
  "status",
  "economyProfile",
] as const;
const ECONOMY_KEYS = [
  "kind",
  "ref",
  "tileCount",
  "recommendedPlayers",
  "startingCash",
  "startSalary",
  "sets",
  "tiles",
  "transit",
  "utility",
] as const;
const PROPERTY_KEYS = [
  "id",
  "name",
  "setId",
  "price",
  "baseRent",
  "completeSetRent",
  "developmentRents",
  "buildingCost",
  "mortgageValue",
  "unmortgageCost",
  "buildingSellBack",
] as const;

export class BoardValidationError extends Error {
  constructor(readonly path: string, message: string) {
    super(path + ": " + message);
    this.name = "BoardValidationError";
  }
}

function fail(path: string, message: string): never {
  throw new BoardValidationError(path, message);
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function arrayAt(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(path, "expected an array");
  return value;
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(path, "expected a non-empty string");
  }
  return value;
}

function integerAt(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail(path, "expected a safe integer >= " + minimum);
  }
  return value as number;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const expectedSet = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) fail(path + "." + key, "unexpected field");
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail(path + "." + key, "missing field");
    }
  }
}

function recommendedPlayersAt(value: unknown, path: string): RecommendedPlayers {
  const object = objectAt(value, path);
  exactKeys(object, ["min", "max"], path);
  const min = integerAt(object.min, path + ".min", 1);
  const max = integerAt(object.max, path + ".max", min);
  return { min, max };
}

function moneyAt(value: unknown, path: string, allowZero = true): number {
  return integerAt(value, path, allowZero ? 0 : 1);
}

function validateProperty(value: unknown, path: string, setId: string): PropertyEconomy {
  const object = objectAt(value, path);
  exactKeys(object, PROPERTY_KEYS, path);
  const propertyId = stringAt(object.id, path + ".id");
  const propertySetId = stringAt(object.setId, path + ".setId");
  if (propertySetId !== setId) {
    fail(path + ".setId", "must match containing set id " + setId);
  }

  const rents = arrayAt(object.developmentRents, path + ".developmentRents");
  if (rents.length !== 4) fail(path + ".developmentRents", "expected exactly four levels");
  rents.forEach((rent, index) => moneyAt(rent, path + ".developmentRents[" + index + "]"));

  moneyAt(object.price, path + ".price", false);
  moneyAt(object.baseRent, path + ".baseRent");
  moneyAt(object.completeSetRent, path + ".completeSetRent");
  moneyAt(object.buildingCost, path + ".buildingCost", false);
  moneyAt(object.mortgageValue, path + ".mortgageValue");
  moneyAt(object.unmortgageCost, path + ".unmortgageCost");
  moneyAt(object.buildingSellBack, path + ".buildingSellBack");

  return {
    id: propertyId,
    name: stringAt(object.name, path + ".name"),
    setId: propertySetId,
    price: object.price as number,
    baseRent: object.baseRent as number,
    completeSetRent: object.completeSetRent as number,
    developmentRents: rents as readonly number[],
    buildingCost: object.buildingCost as number,
    mortgageValue: object.mortgageValue as number,
    unmortgageCost: object.unmortgageCost as number,
    buildingSellBack: object.buildingSellBack as number,
  };
}

function validateSet(value: unknown, path: string): PropertySetEconomy {
  const object = objectAt(value, path);
  exactKeys(object, ["id", "country", "properties"], path);
  const id = stringAt(object.id, path + ".id");
  const properties = arrayAt(object.properties, path + ".properties");
  if (properties.length === 0) fail(path + ".properties", "must not be empty");
  return {
    id,
    country: stringAt(object.country, path + ".country"),
    properties: properties.map((property, index) =>
      validateProperty(property, path + ".properties[" + index + "]", id),
    ),
  };
}

function validateTile(value: unknown, path: string, expectedIndex: number): EconomyTile {
  const object = objectAt(value, path);
  const index = integerAt(object.index, path + ".index");
  if (index !== expectedIndex) {
    fail(path + ".index", "expected ordered position " + expectedIndex);
  }
  const type = stringAt(object.type, path + ".type");

  switch (type) {
    case "corner":
    case "transit":
    case "utility": {
      exactKeys(object, ["index", "type", "name"], path);
      return { index, type, name: stringAt(object.name, path + ".name") };
    }
    case "property":
      exactKeys(object, ["index", "type", "propertyId"], path);
      return { index, type, propertyId: stringAt(object.propertyId, path + ".propertyId") };
    case "tax":
      exactKeys(object, ["index", "type", "name", "amount"], path);
      return {
        index,
        type,
        name: stringAt(object.name, path + ".name"),
        amount: moneyAt(object.amount, path + ".amount", false),
      };
    case "card": {
      exactKeys(object, ["index", "type", "deck"], path);
      const deck = stringAt(object.deck, path + ".deck");
      if (deck !== "surprise" && deck !== "treasure") {
        fail(path + ".deck", "unknown deck reference " + deck);
      }
      return { index, type, deck: deck as CardDeck };
    }
    case "grand-special": {
      exactKeys(object, ["index", "type", "name"], path);
      const name = stringAt(object.name, path + ".name");
      if (name !== "Auction Hub" && name !== "Gift/Choice" && name !== "Transit Pass") {
        fail(path + ".name", "unknown Grand special");
      }
      return { index, type, name };
    }
    default:
      return fail(path + ".type", "unknown tile type " + type);
  }
}

function validateTransit(value: unknown, path: string): EconomyBoard["transit"] {
  const object = objectAt(value, path);
  exactKeys(object, ["price", "rents", "mortgageValue", "unmortgageCost"], path);
  const rents = arrayAt(object.rents, path + ".rents");
  if (rents.length !== 4) fail(path + ".rents", "expected exactly four rent levels");
  rents.forEach((rent, index) => moneyAt(rent, path + ".rents[" + index + "]"));
  return {
    price: moneyAt(object.price, path + ".price", false),
    rents: rents as readonly number[],
    mortgageValue: moneyAt(object.mortgageValue, path + ".mortgageValue"),
    unmortgageCost: moneyAt(object.unmortgageCost, path + ".unmortgageCost"),
  };
}

function validateUtility(value: unknown, path: string): EconomyBoard["utility"] {
  const object = objectAt(value, path);
  exactKeys(object, ["price", "rentMultipliers", "mortgageValue", "unmortgageCost"], path);
  const multipliers = arrayAt(object.rentMultipliers, path + ".rentMultipliers");
  if (multipliers.length !== 2) {
    fail(path + ".rentMultipliers", "expected exactly two multipliers");
  }
  multipliers.forEach((multiplier, index) =>
    integerAt(multiplier, path + ".rentMultipliers[" + index + "]", 1),
  );
  return {
    price: moneyAt(object.price, path + ".price", false),
    rentMultipliers: multipliers as readonly number[],
    mortgageValue: moneyAt(object.mortgageValue, path + ".mortgageValue"),
    unmortgageCost: moneyAt(object.unmortgageCost, path + ".unmortgageCost"),
  };
}

function sameRange(left: RecommendedPlayers, right: RecommendedPlayers): boolean {
  return left.min === right.min && left.max === right.max;
}

function frozenMetadataFor(boardId: string, path: string): FrozenBoardMetadata {
  const metadata = FROZEN_BOARD_METADATA.find((candidate) => candidate.boardId === boardId);
  if (metadata === undefined) fail(path, "unsupported frozen board identity " + boardId);
  return metadata;
}

function validateFrozenRelationships(
  board: Omit<BoardDefinition, "economyProfile">,
  economy: EconomyBoard,
  metadata: FrozenBoardMetadata,
): void {
  if (board.ref !== metadata.ref || board.boardVersion !== 1) {
    fail("$.ref", "board identity/version does not match the frozen baseline");
  }
  if (board.tileCount !== metadata.tileCount || economy.tileCount !== board.tileCount) {
    fail("$.tileCount", "board and economy tile counts must match the frozen baseline");
  }
  if (
    !sameRange(board.recommendedPlayers, metadata.recommendedPlayers)
    || !sameRange(economy.recommendedPlayers, board.recommendedPlayers)
  ) {
    fail("$.recommendedPlayers", "board and economy ranges must match the frozen baseline");
  }
  if (economy.ref !== board.ref || economy.kind !== metadata.kind) {
    fail("$.economyProfile", "economy identity must match its frozen board");
  }
  if (economy.startingCash !== 2000 || economy.startSalary !== 200) {
    fail("$.economyProfile", "launch cash metadata must match the frozen baseline");
  }

  const setSizes = economy.sets.map((set) => set.properties.length).sort((a, b) => a - b);
  if (setSizes.join(",") !== metadata.setSizes.join(",")) {
    fail("$.economyProfile.sets", "set-size distribution does not match the frozen baseline");
  }

  const typeCounts: Record<EconomyTile["type"], number> = {
    corner: 0,
    property: 0,
    transit: 0,
    utility: 0,
    tax: 0,
    card: 0,
    "grand-special": 0,
  };
  const deckCounts: Record<CardDeck, number> = { surprise: 0, treasure: 0 };
  for (const tile of economy.tiles) {
    typeCounts[tile.type] += 1;
    if (tile.type === "card") deckCounts[tile.deck] += 1;
  }
  if (deckCounts.surprise !== metadata.deckCounts.surprise
    || deckCounts.treasure !== metadata.deckCounts.treasure) {
    fail("$.economyProfile.tiles", "deck counts do not match the frozen baseline");
  }
  for (const [type, expected] of Object.entries(metadata.tileTypeCounts)) {
    if (typeCounts[type as EconomyTile["type"]] !== expected) {
      fail("$.economyProfile.tiles", type + " count does not match the frozen baseline");
    }
  }
}

function cloneFrozen(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(cloneFrozen));
  if (typeof value === "object" && value !== null) {
    const clone: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) clone[key] = cloneFrozen(child);
    return Object.freeze(clone);
  }
  return value;
}

export function parseBoardDefinition(input: unknown): BoardDefinition {
  const root = objectAt(input, "$");
  exactKeys(root, BOARD_KEYS, "$");

  const boardId = stringAt(root.boardId, "$.boardId");
  const board: Omit<BoardDefinition, "economyProfile"> = {
    ref: stringAt(root.ref, "$.ref"),
    boardId,
    boardVersion: integerAt(root.boardVersion, "$.boardVersion", 1),
    tileCount: integerAt(root.tileCount, "$.tileCount", 1),
    recommendedPlayers: recommendedPlayersAt(root.recommendedPlayers, "$.recommendedPlayers"),
    status:
      root.status === "FROZEN_BASELINE"
        ? root.status
        : fail("$.status", "expected FROZEN_BASELINE"),
  };
  const metadata = frozenMetadataFor(boardId, "$.boardId");

  const economyObject = objectAt(root.economyProfile, "$.economyProfile");
  exactKeys(economyObject, ECONOMY_KEYS, "$.economyProfile");
  const kind =
    economyObject.kind === "standard" || economyObject.kind === "grand"
      ? economyObject.kind
      : fail("$.economyProfile.kind", "expected standard or grand");

  const sets = arrayAt(economyObject.sets, "$.economyProfile.sets").map((set, index) =>
    validateSet(set, "$.economyProfile.sets[" + index + "]"),
  );
  const setIds = new Set<string>();
  const propertyIds = new Set<string>();
  for (const set of sets) {
    if (setIds.has(set.id)) fail("$.economyProfile.sets", "duplicate set id " + set.id);
    setIds.add(set.id);
    for (const property of set.properties) {
      if (propertyIds.has(property.id)) {
        fail("$.economyProfile.sets", "duplicate property id " + property.id);
      }
      propertyIds.add(property.id);
    }
  }

  const tiles = arrayAt(economyObject.tiles, "$.economyProfile.tiles").map((tile, index) =>
    validateTile(tile, "$.economyProfile.tiles[" + index + "]", index),
  );
  const referencedPropertyIds = new Set<string>();
  for (const tile of tiles) {
    if (tile.type !== "property") continue;
    if (!propertyIds.has(tile.propertyId)) {
      fail("$.economyProfile.tiles[" + tile.index + "].propertyId", "unknown property reference");
    }
    if (referencedPropertyIds.has(tile.propertyId)) {
      fail(
        "$.economyProfile.tiles[" + tile.index + "].propertyId",
        "duplicate property tile reference " + tile.propertyId,
      );
    }
    referencedPropertyIds.add(tile.propertyId);
  }
  for (const propertyId of propertyIds) {
    if (!referencedPropertyIds.has(propertyId)) {
      fail("$.economyProfile.tiles", "property has no tile reference " + propertyId);
    }
  }

  const economy: EconomyBoard = {
    kind,
    ref: stringAt(economyObject.ref, "$.economyProfile.ref"),
    tileCount: integerAt(economyObject.tileCount, "$.economyProfile.tileCount", 1),
    recommendedPlayers: recommendedPlayersAt(
      economyObject.recommendedPlayers,
      "$.economyProfile.recommendedPlayers",
    ),
    startingCash: moneyAt(economyObject.startingCash, "$.economyProfile.startingCash", false),
    startSalary: moneyAt(economyObject.startSalary, "$.economyProfile.startSalary", false),
    sets,
    tiles,
    transit: validateTransit(economyObject.transit, "$.economyProfile.transit"),
    utility: validateUtility(economyObject.utility, "$.economyProfile.utility"),
  };

  if (tiles.length !== board.tileCount) {
    fail("$.economyProfile.tiles", "length must equal board tileCount");
  }
  if (propertyIds.size !== metadata.propertyCount) {
    fail("$.economyProfile.sets", "property count does not match the frozen baseline");
  }
  validateFrozenRelationships(board, economy, metadata);

  return cloneFrozen({ ...board, economyProfile: economy }) as BoardDefinition;
}

export type BoardValidationResult =
  | { readonly ok: true; readonly board: BoardDefinition }
  | { readonly ok: false; readonly error: BoardValidationError };

export function validateBoardDefinition(input: unknown): BoardValidationResult {
  try {
    return { ok: true, board: parseBoardDefinition(input) };
  } catch (error) {
    if (error instanceof BoardValidationError) return { ok: false, error };
    throw error;
  }
}
