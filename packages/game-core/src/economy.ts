export type BoardKind = "standard" | "grand";
export type CardDeck = "surprise" | "treasure";

export interface PropertyEconomy {
  readonly id: string;
  readonly name: string;
  readonly setId: string;
  readonly price: number;
  readonly baseRent: number;
  readonly completeSetRent: number;
  readonly developmentRents: readonly number[];
  readonly buildingCost: number;
  readonly mortgageValue: number;
  readonly unmortgageCost: number;
  readonly buildingSellBack: number;
}

export interface PropertySetEconomy {
  readonly id: string;
  readonly country: string;
  readonly properties: readonly PropertyEconomy[];
}

export type EconomyTile =
  | { readonly index: number; readonly type: "corner"; readonly name: string }
  | { readonly index: number; readonly type: "property"; readonly propertyId: string }
  | { readonly index: number; readonly type: "transit"; readonly name: string }
  | { readonly index: number; readonly type: "utility"; readonly name: string }
  | { readonly index: number; readonly type: "tax"; readonly name: string; readonly amount: number }
  | { readonly index: number; readonly type: "card"; readonly deck: CardDeck }
  | {
      readonly index: number;
      readonly type: "grand-special";
      readonly name: "Auction Hub" | "Gift/Choice" | "Transit Pass";
    };

export interface EconomyBoard {
  readonly kind: BoardKind;
  readonly ref: string;
  readonly tileCount: number;
  readonly recommendedPlayers: Readonly<{ min: number; max: number }>;
  readonly startingCash: number;
  readonly startSalary: number;
  readonly sets: readonly PropertySetEconomy[];
  readonly tiles: readonly EconomyTile[];
  readonly transit: Readonly<{
    price: number;
    rents: readonly number[];
    mortgageValue: number;
    unmortgageCost: number;
  }>;
  readonly utility: Readonly<{
    price: number;
    rentMultipliers: readonly number[];
    mortgageValue: number;
    unmortgageCost: number;
  }>;
}


export const CANDIDATE_RULES = Object.freeze({
  status: "PRE_FREEZE_CANDIDATE",
  referenceSalary: 200,
  defaultStartingCash: 2000,
  startingCashPresets: Object.freeze([1500, 2000, 2500]),
  customStartingCashMin: 1500,
  customStartingCashMax: 2500,
  completeSetRentMultiplier: 2,
  mortgagePercent: 50,
  unmortgagePercent: 110,
  buildingSellBackPercent: 50,
  developmentActions: 2,
  startLandingBonus: 100,
  holdingReleaseFee: 50,
  vacationCash: 0,
  grandSpecialCash: 0,
  grandMovement: "core",
} as const);

export function validStartingCash(value: number): boolean {
  return Number.isSafeInteger(value) && value >= CANDIDATE_RULES.customStartingCashMin
    && value <= CANDIDATE_RULES.customStartingCashMax;
}
