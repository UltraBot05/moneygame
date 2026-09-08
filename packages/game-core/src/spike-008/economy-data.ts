/**
 * SPIKE-008 simulation-only economy fixture.
 *
 * Candidate names, price tiers, rent/build formulas, transit price, utility
 * price, and card cash effects were transcribed from the approved local design
 * source. This is not yet the production board source (CORE-001/GRAND-001 own
 * that). Where the design conflicts with the immutable board counts, the
 * reconciliation is explicit below and covered by tests.
 */

import type { BoardKind, CardDeck, PropertyEconomy, PropertySetEconomy, EconomyTile, EconomyBoard } from "../economy.ts";
export type { BoardKind, CardDeck, PropertyEconomy, PropertySetEconomy, EconomyTile, EconomyBoard } from "../economy.ts";

export type CardEffect =
  | { readonly kind: "bank"; readonly amount: number }
  | { readonly kind: "per-property"; readonly amount: number }
  | { readonly kind: "per-building"; readonly blockAmount: number; readonly landmarkAmount: number }
  | { readonly kind: "per-developed-property"; readonly amount: number }
  | { readonly kind: "per-player"; readonly amount: number }
  | { readonly kind: "advance-start"; readonly amount: number }
  | { readonly kind: "move-nearest"; readonly tileType: "transit" | "utility"; readonly rentMultiplier: number }
  | { readonly kind: "move-back"; readonly spaces: number }
  | { readonly kind: "holding" }
  | { readonly kind: "hold-rent-holiday" }
  | { readonly kind: "no-economic-effect" };

export interface EconomyCard {
  readonly id: string;
  readonly title: string;
  readonly effect: CardEffect;
}

export const ECONOMY_RULES = Object.freeze({
  referenceSalary: 200,
  defaultStartingCash: 2_000,
  completeSetRentMultiplier: 2,
  mortgageFraction: 0.5,
  unmortgageInterest: 0.1,
  buildingSellBackFraction: 0.5,
});

function roundToTen(value: number): number {
  return Math.round(value / 10) * 10;
}

function makeProperty(
  setId: string,
  ordinal: number,
  name: string,
  price: number,
): PropertyEconomy {
  const baseRent = Math.max(2, Math.round(price / 20) * 2);
  const buildingCost = roundToTen(price * 0.6);
  const mortgageValue = price * ECONOMY_RULES.mortgageFraction;
  return Object.freeze({
    id: `${setId}-${ordinal + 1}`,
    name,
    setId,
    price,
    baseRent,
    completeSetRent: baseRent * ECONOMY_RULES.completeSetRentMultiplier,
    developmentRents: Object.freeze([
      roundToTen(price * 0.5),
      roundToTen(price * 1.5),
      roundToTen(price * 3.6),
      roundToTen(price * 5.2),
    ]) as readonly [number, number, number, number],
    buildingCost,
    mortgageValue,
    // Canonical money is integer; half-dollar interest is rounded up once.
    unmortgageCost: Math.ceil(mortgageValue * (1 + ECONOMY_RULES.unmortgageInterest)),
    buildingSellBack: buildingCost * ECONOMY_RULES.buildingSellBackFraction,
  });
}

interface SetInput {
  readonly id: string;
  readonly country: string;
  readonly cities: readonly (readonly [string, number])[];
}

function makeSets(inputs: readonly SetInput[]): readonly PropertySetEconomy[] {
  return Object.freeze(
    inputs.map((input) =>
      Object.freeze({
        id: input.id,
        country: input.country,
        properties: Object.freeze(
          input.cities.map(([name, price], ordinal) => makeProperty(input.id, ordinal, name, price)),
        ),
      }),
    ),
  );
}

/**
 * The design supplies eight 3-city tiers (24 properties), but ADR-004 fixes
 * Standard at 22 properties. The smallest reconciliation keeps all six middle
 * triples and uses the low/high candidate cities from the first and last tiers
 * as pairs. No price is invented or rescaled.
 */
const STANDARD_SETS = makeSets([
  { id: "EG", country: "Egypt", cities: [["Cairo", 60], ["Giza", 90]] },
  { id: "MA", country: "Morocco", cities: [["Casablanca", 100], ["Marrakesh", 110], ["Rabat", 130]] },
  { id: "SA", country: "South Africa", cities: [["Cape Town", 140], ["Johannesburg", 150], ["Durban", 170]] },
  { id: "IN", country: "India", cities: [["Mumbai", 180], ["Delhi", 190], ["Jaipur", 210]] },
  { id: "JP", country: "Japan", cities: [["Tokyo", 220], ["Osaka", 230], ["Kyoto", 250]] },
  { id: "AU", country: "Australia", cities: [["Sydney", 260], ["Melbourne", 270], ["Perth", 290]] },
  { id: "IT", country: "Italy", cities: [["Rome", 300], ["Milan", 320], ["Venice", 340]] },
  { id: "FR", country: "France", cities: [["Paris", 350], ["Lyon", 400]] },
] as const);

/**
 * ADR-004 fixes Grand at six pairs plus six triples (30 properties), while the
 * design supplies twelve triples. The first six tiers use their low/high cities
 * as pairs; the final six retain all authored cities. All retained prices are
 * exact design values.
 */
const GRAND_SETS = makeSets([
  { id: "EG", country: "Egypt", cities: [["Cairo", 60], ["Giza", 90]] },
  { id: "MA", country: "Morocco", cities: [["Casablanca", 100], ["Rabat", 130]] },
  { id: "SA", country: "South Africa", cities: [["Cape Town", 140], ["Durban", 170]] },
  { id: "IN", country: "India", cities: [["Mumbai", 180], ["Jaipur", 210]] },
  { id: "JP", country: "Japan", cities: [["Tokyo", 220], ["Kyoto", 250]] },
  { id: "AU", country: "Australia", cities: [["Sydney", 260], ["Perth", 290]] },
  { id: "IT", country: "Italy", cities: [["Rome", 300], ["Milan", 310], ["Venice", 330]] },
  { id: "FR", country: "France", cities: [["Paris", 340], ["Nice", 350], ["Lyon", 370]] },
  { id: "ES", country: "Spain", cities: [["Madrid", 380], ["Barcelona", 390], ["Seville", 410]] },
  { id: "BR", country: "Brazil", cities: [["Rio de Janeiro", 420], ["Sao Paulo", 430], ["Brasilia", 450]] },
  { id: "MX", country: "Mexico", cities: [["Mexico City", 460], ["Cancun", 470], ["Guadalajara", 490]] },
  { id: "CA", country: "Canada", cities: [["Toronto", 500], ["Vancouver", 520], ["Montreal", 550]] },
] as const);

type TileSpec =
  | readonly ["corner", string]
  | readonly ["property", string, number]
  | readonly ["transit", string]
  | readonly ["utility", string]
  | readonly ["tax", string]
  | readonly ["card", CardDeck]
  | readonly ["grand-special", "Auction Hub" | "Gift/Choice" | "Transit Pass"];

function propertyAt(sets: readonly PropertySetEconomy[], setId: string, ordinal: number): PropertyEconomy {
  const set = sets.find((candidate) => candidate.id === setId);
  const property = set?.properties[ordinal];
  if (property === undefined) throw new Error(`Unknown property ${setId}[${ordinal}]`);
  return property;
}

function makeTiles(sets: readonly PropertySetEconomy[], specs: readonly TileSpec[]): readonly EconomyTile[] {
  return Object.freeze(
    specs.map((spec, index): EconomyTile => {
      switch (spec[0]) {
        case "corner":
          return Object.freeze({ index, type: "corner", name: spec[1] });
        case "property":
          return Object.freeze({ index, type: "property", propertyId: propertyAt(sets, spec[1], spec[2]).id });
        case "transit":
          return Object.freeze({ index, type: "transit", name: spec[1] });
        case "utility":
          return Object.freeze({ index, type: "utility", name: spec[1] });
        case "tax":
          // The design names Customs but authors no amount. 0.5S is the
          // smallest explicit fixed simulation assumption.
          return Object.freeze({ index, type: "tax", name: spec[1], amount: 100 });
        case "card":
          return Object.freeze({ index, type: "card", deck: spec[1] });
        case "grand-special":
          return Object.freeze({ index, type: "grand-special", name: spec[1] });
      }
    }),
  );
}

const STANDARD_TILES = makeTiles(STANDARD_SETS, [
  ["corner", "START"],
  ["property", "EG", 0], ["property", "EG", 1], ["card", "surprise"], ["utility", "Power Grid"],
  ["transit", "Heathrow"], ["property", "MA", 0], ["property", "MA", 1], ["property", "MA", 2], ["card", "treasure"],
  ["corner", "HOLDING"],
  ["property", "SA", 0], ["property", "SA", 1], ["property", "SA", 2], ["tax", "Customs"],
  ["transit", "Gare du Nord"], ["property", "IN", 0], ["property", "IN", 1], ["property", "IN", 2], ["card", "surprise"],
  ["corner", "VACATION"],
  ["property", "JP", 0], ["property", "JP", 1], ["property", "JP", 2], ["card", "treasure"],
  ["transit", "Changi"], ["property", "AU", 0], ["property", "AU", 1], ["property", "AU", 2], ["utility", "Water Works"],
  ["corner", "GO TO HOLDING"],
  ["property", "IT", 0], ["property", "IT", 1], ["property", "IT", 2], ["card", "surprise"],
  ["transit", "Grand Central"], ["property", "FR", 0], ["property", "FR", 1], ["card", "treasure"], ["tax", "Customs"],
] as const);

const GRAND_TILES = makeTiles(GRAND_SETS, [
  ["corner", "START"],
  ["property", "EG", 0], ["property", "EG", 1], ["card", "surprise"], ["property", "MA", 0], ["property", "MA", 1],
  ["transit", "Heathrow"], ["utility", "Power Grid"], ["card", "treasure"], ["property", "SA", 0], ["property", "SA", 1],
  ["grand-special", "Auction Hub"], ["tax", "Customs"],
  ["corner", "HOLDING"],
  ["property", "IN", 0], ["property", "IN", 1], ["card", "surprise"], ["property", "JP", 0], ["property", "JP", 1],
  ["transit", "Gare du Nord"], ["utility", "Water Works"], ["card", "treasure"], ["property", "AU", 0], ["property", "AU", 1],
  ["grand-special", "Gift/Choice"], ["grand-special", "Transit Pass"],
  ["corner", "VACATION"],
  ["property", "IT", 0], ["property", "IT", 1], ["property", "IT", 2], ["card", "surprise"], ["utility", "Third Utility"],
  ["transit", "Changi"], ["property", "FR", 0], ["property", "FR", 1], ["property", "FR", 2],
  ["property", "ES", 0], ["property", "ES", 1], ["property", "ES", 2],
  ["corner", "GO TO HOLDING"],
  ["property", "BR", 0], ["property", "BR", 1], ["property", "BR", 2], ["card", "treasure"], ["tax", "Customs"],
  ["transit", "Grand Central"], ["property", "MX", 0], ["property", "MX", 1], ["property", "MX", 2],
  ["property", "CA", 0], ["property", "CA", 1], ["property", "CA", 2],
] as const);

function board(
  kind: BoardKind,
  ref: string,
  tileCount: number,
  recommendedPlayers: Readonly<{ min: number; max: number }>,
  sets: readonly PropertySetEconomy[],
  tiles: readonly EconomyTile[],
  utilityMultipliers: readonly number[],
): EconomyBoard {
  const transitMortgage = 200 * ECONOMY_RULES.mortgageFraction;
  const utilityMortgage = 150 * ECONOMY_RULES.mortgageFraction;
  return Object.freeze({
    kind,
    ref,
    tileCount,
    recommendedPlayers,
    startingCash: ECONOMY_RULES.defaultStartingCash,
    startSalary: ECONOMY_RULES.referenceSalary,
    sets,
    tiles,
    transit: Object.freeze({
      price: 200,
      // The design authors the $200 price but no fare table. Linear 10%-of-price
      // scaling is an explicit simulation assumption, not a production rule.
      rents: Object.freeze([20, 40, 60, 80]) as readonly [number, number, number, number],
      mortgageValue: transitMortgage,
      unmortgageCost: Math.ceil(transitMortgage * 1.1),
    }),
    utility: Object.freeze({
      price: 150,
      // Design copy establishes dice-scaled rent and a 10x special-card fare;
      // ordinary scaling is otherwise absent. The third Grand step is likewise
      // a labeled gap required by Grand's immutable three-utility count.
      rentMultipliers: Object.freeze(utilityMultipliers.slice()),
      mortgageValue: utilityMortgage,
      unmortgageCost: Math.ceil(utilityMortgage * 1.1),
    }),
  });
}

export const STANDARD_ECONOMY = board(
  "standard",
  "world-tour-standard@1",
  40,
  Object.freeze({ min: 3, max: 6 }),
  STANDARD_SETS,
  STANDARD_TILES,
  [4, 10],
);

export const GRAND_ECONOMY = board(
  "grand",
  "world-tour-grand@1",
  52,
  Object.freeze({ min: 6, max: 10 }),
  GRAND_SETS,
  GRAND_TILES,
  [4, 10, 15],
);

export const SURPRISE_CARDS: readonly EconomyCard[] = Object.freeze([
  { id: "surprise-01", title: "Advance to START", effect: { kind: "advance-start", amount: 300 } },
  { id: "surprise-02", title: "Go to Holding", effect: { kind: "holding" } },
  { id: "surprise-03", title: "Take the next flight", effect: { kind: "move-nearest", tileType: "transit", rentMultiplier: 2 } },
  { id: "surprise-04", title: "Board the next train", effect: { kind: "move-nearest", tileType: "transit", rentMultiplier: 2 } },
  { id: "surprise-05", title: "Customs inspection", effect: { kind: "bank", amount: -150 } },
  { id: "surprise-06", title: "Overbooked", effect: { kind: "move-back", spaces: 3 } },
  { id: "surprise-07", title: "Currency slide", effect: { kind: "per-property", amount: -40 } },
  { id: "surprise-08", title: "Street repairs", effect: { kind: "per-building", blockAmount: -40, landmarkAmount: -115 } },
  { id: "surprise-09", title: "Visa denied", effect: { kind: "no-economic-effect" } },
  { id: "surprise-10", title: "Speeding fine", effect: { kind: "bank", amount: -100 } },
  { id: "surprise-11", title: "Hotel levy", effect: { kind: "per-developed-property", amount: -50 } },
  { id: "surprise-12", title: "Sponsor a festival", effect: { kind: "per-player", amount: -50 } },
  { id: "surprise-13", title: "Reroute", effect: { kind: "no-economic-effect" } },
  { id: "surprise-14", title: "Lost luggage", effect: { kind: "bank", amount: -80 } },
  { id: "surprise-15", title: "Diplomatic pass", effect: { kind: "no-economic-effect" } },
  { id: "surprise-16", title: "Emergency landing", effect: { kind: "move-nearest", tileType: "utility", rentMultiplier: 10 } },
]);

export const TREASURE_CARDS: readonly EconomyCard[] = Object.freeze([
  { id: "treasure-01", title: "Tourism board grant", effect: { kind: "bank", amount: 200 } },
  { id: "treasure-02", title: "Bank error in your favour", effect: { kind: "bank", amount: 150 } },
  { id: "treasure-03", title: "Sale of a landmark", effect: { kind: "bank", amount: 300 } },
  { id: "treasure-04", title: "Annual dividend", effect: { kind: "per-property", amount: 30 } },
  { id: "treasure-05", title: "Rail concession", effect: { kind: "bank", amount: 120 } },
  { id: "treasure-06", title: "Insurance payout", effect: { kind: "bank", amount: 100 } },
  { id: "treasure-07", title: "Duty refund", effect: { kind: "bank", amount: 150 } },
  { id: "treasure-08", title: "Consulate letter", effect: { kind: "no-economic-effect" } },
  { id: "treasure-09", title: "Birthday", effect: { kind: "per-player", amount: 50 } },
  { id: "treasure-10", title: "Won a design prize", effect: { kind: "bank", amount: 80 } },
  { id: "treasure-11", title: "Mature bond", effect: { kind: "bank", amount: 250 } },
  { id: "treasure-12", title: "Sponsorship deal", effect: { kind: "bank", amount: 180 } },
  { id: "treasure-13", title: "Rent holiday", effect: { kind: "hold-rent-holiday" } },
  { id: "treasure-14", title: "Property tax rebate", effect: { kind: "bank", amount: 90 } },
  { id: "treasure-15", title: "Baggage handler's tip", effect: { kind: "bank", amount: 70 } },
  { id: "treasure-16", title: "Advance to START", effect: { kind: "advance-start", amount: 300 } },
]);

export const PLAYER_COUNT_MATRIX = Object.freeze({
  standard: Object.freeze([3, 4, 5, 6] as const),
  grand: Object.freeze([6, 7, 8, 9, 10] as const),
});
