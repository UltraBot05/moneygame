import { parseBoardDefinition, type BoardDefinition } from "./board";
import type { PropertyEconomy } from "./economy";
import type { AssetState, GameState } from "./state";

export type TaxChargeRule =
  | { readonly type: "FIXED"; readonly amount: number }
  | {
      readonly type: "PERCENT";
      readonly basis: "CASH" | "NET_WORTH";
      readonly numerator: number;
      readonly denominator: number;
      readonly rounding: "FLOOR" | "CEIL";
    };

export type TaxRule = TaxChargeRule | {
  readonly type: "CHOICE";
  readonly options: readonly TaxChargeRule[];
};

export type TaxEvaluation =
  | { readonly type: "AMOUNT"; readonly amount: number }
  | { readonly type: "CHOICE_REQUIRED"; readonly amounts: readonly number[] };

function taxObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(field + " must be an object");
  }
  return value as Record<string, unknown>;
}

function exactTaxKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new TypeError(field + "." + key + " is not supported");
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new TypeError(field + "." + key + " is required");
    }
  }
}

function safeNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError(field + " must be a non-negative safe integer");
  }
  return value as number;
}

function parseTaxChargeRule(value: unknown, field: string): TaxChargeRule {
  const object = taxObject(value, field);
  if (object.type === "FIXED") {
    exactTaxKeys(object, ["type", "amount"], field);
    return Object.freeze({
      type: "FIXED",
      amount: safeNonNegativeInteger(object.amount, field + ".amount"),
    });
  }
  if (object.type !== "PERCENT") throw new TypeError(field + ".type is not supported");
  exactTaxKeys(
    object,
    ["type", "basis", "numerator", "denominator", "rounding"],
    field,
  );
  if (object.basis !== "CASH" && object.basis !== "NET_WORTH") {
    throw new TypeError(field + ".basis must be CASH or NET_WORTH");
  }
  if (object.rounding !== "FLOOR" && object.rounding !== "CEIL") {
    throw new TypeError(field + ".rounding must be FLOOR or CEIL");
  }
  const denominator = safeNonNegativeInteger(object.denominator, field + ".denominator");
  if (denominator === 0) throw new RangeError(field + ".denominator must be positive");
  return Object.freeze({
    type: "PERCENT",
    basis: object.basis,
    numerator: safeNonNegativeInteger(object.numerator, field + ".numerator"),
    denominator,
    rounding: object.rounding,
  });
}

export function parseTaxRule(value: unknown): TaxRule {
  const object = taxObject(value, "tax rule");
  if (object.type !== "CHOICE") return parseTaxChargeRule(object, "tax rule");
  exactTaxKeys(object, ["type", "options"], "tax rule");
  if (!Array.isArray(object.options) || object.options.length < 2) {
    throw new RangeError("tax rule.options must contain at least two choices");
  }
  const options = object.options.map((option, index) =>
    parseTaxChargeRule(option, "tax rule.options[" + index + "]"),
  );
  Object.freeze(options);
  return Object.freeze({ type: "CHOICE", options });
}

function evaluateCharge(
  rule: TaxChargeRule,
  context: Readonly<{ cash: number; netWorth: number }>,
): number {
  if (rule.type === "FIXED") return safeNonNegativeInteger(rule.amount, "tax amount");
  const basis = safeNonNegativeInteger(
    rule.basis === "CASH" ? context.cash : context.netWorth,
    "tax basis",
  );
  const numerator = safeNonNegativeInteger(rule.numerator, "tax numerator");
  const denominator = safeNonNegativeInteger(rule.denominator, "tax denominator");
  if (denominator === 0) throw new RangeError("tax denominator must be positive");
  const product = basis * numerator;
  if (!Number.isSafeInteger(product)) throw new RangeError("tax calculation exceeds safe integer range");
  return rule.rounding === "CEIL"
    ? Math.ceil(product / denominator)
    : Math.floor(product / denominator);
}

export function evaluateTaxRule(
  ruleInput: TaxRule,
  context: Readonly<{ cash: number; netWorth: number }>,
): TaxEvaluation {
  const rule = parseTaxRule(ruleInput);
  if (rule.type !== "CHOICE") {
    return Object.freeze({ type: "AMOUNT", amount: evaluateCharge(rule, context) });
  }
  if (!Array.isArray(rule.options) || rule.options.length < 2) {
    throw new RangeError("tax choice must contain at least two options");
  }
  const amounts = rule.options.map((option) => evaluateCharge(option, context));
  Object.freeze(amounts);
  return Object.freeze({ type: "CHOICE_REQUIRED", amounts });
}

export function propertyForAsset(
  boardInput: BoardDefinition,
  asset: AssetState,
): PropertyEconomy | null {
  if (asset.kind !== "PROPERTY") return null;
  const board = parseBoardDefinition(boardInput);
  const tile = board.economyProfile.tiles[asset.tileIndex];
  if (tile?.type !== "property") throw new RangeError("property asset has no canonical property tile");
  for (const set of board.economyProfile.sets) {
    const property = set.properties.find((candidate) => candidate.id === tile.propertyId);
    if (property !== undefined) return property;
  }
  throw new RangeError("property asset has no canonical economy definition");
}

export function purchasePrice(board: BoardDefinition, asset: AssetState): number {
  const property = propertyForAsset(board, asset);
  if (property !== null) return property.price;
  return asset.kind === "TRANSIT"
    ? board.economyProfile.transit.price
    : board.economyProfile.utility.price;
}

export function mortgageValue(board: BoardDefinition, asset: AssetState): number {
  const property = propertyForAsset(board, asset);
  if (property !== null) return property.mortgageValue;
  return asset.kind === "TRANSIT"
    ? board.economyProfile.transit.mortgageValue
    : board.economyProfile.utility.mortgageValue;
}

export function unmortgageCost(board: BoardDefinition, asset: AssetState): number {
  const property = propertyForAsset(board, asset);
  if (property !== null) return property.unmortgageCost;
  return asset.kind === "TRANSIT"
    ? board.economyProfile.transit.unmortgageCost
    : board.economyProfile.utility.unmortgageCost;
}

export function propertySetAssets(
  state: GameState,
  board: BoardDefinition,
  asset: Extract<AssetState, { readonly kind: "PROPERTY" }>,
): readonly Extract<AssetState, { readonly kind: "PROPERTY" }>[] {
  const property = propertyForAsset(board, asset);
  if (property === null) throw new RangeError("expected property asset");
  const set = board.economyProfile.sets.find((candidate) => candidate.id === property.setId);
  if (set === undefined) throw new RangeError("property has no canonical set");
  const propertyIds = new Set(set.properties.map((candidate) => candidate.id));
  return state.assets.filter((candidate): candidate is Extract<AssetState, { kind: "PROPERTY" }> => {
    if (candidate.kind !== "PROPERTY") return false;
    const tile = board.economyProfile.tiles[candidate.tileIndex];
    return tile?.type === "property" && propertyIds.has(tile.propertyId);
  });
}

export function rentForAsset(
  state: GameState,
  board: BoardDefinition,
  asset: AssetState,
  authoritativeDiceTotal: number,
): number {
  if (asset.ownerUserId === null || asset.mortgaged) return 0;
  if (asset.kind === "TRANSIT") {
    const count = state.assets.filter((candidate) =>
      candidate.kind === "TRANSIT"
      && candidate.ownerUserId === asset.ownerUserId
      && !candidate.mortgaged
    ).length;
    return board.economyProfile.transit.rents[count - 1] ?? 0;
  }
  if (asset.kind === "UTILITY") {
    const count = state.assets.filter((candidate) =>
      candidate.kind === "UTILITY"
      && candidate.ownerUserId === asset.ownerUserId
      && !candidate.mortgaged
    ).length;
    const multiplier = board.economyProfile.utility.rentMultipliers[count - 1] ?? 0;
    const rent = authoritativeDiceTotal * multiplier;
    if (!Number.isSafeInteger(rent)) throw new RangeError("utility rent exceeds safe integer range");
    return rent;
  }
  if (asset.kind !== "PROPERTY") throw new RangeError("unknown ownable kind");

  const property = propertyForAsset(board, asset);
  if (property === null) throw new RangeError("expected property economy");
  if (asset.developmentLevel > 0) {
    return property.developmentRents[asset.developmentLevel - 1] ?? 0;
  }
  const setAssets = propertySetAssets(state, board, asset);
  const completeUnimprovedSet = setAssets.length > 0 && setAssets.every((candidate) =>
    candidate.ownerUserId === asset.ownerUserId && candidate.developmentLevel === 0
  );
  return completeUnimprovedSet ? property.completeSetRent : property.baseRent;
}
