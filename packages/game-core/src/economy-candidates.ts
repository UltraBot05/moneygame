import standard from "../../../boards/world-tour/standard.json" with { type: "json" };
import grand from "../../../boards/world-tour/grand.json" with { type: "json" };
import { CANDIDATE_RULES, type BoardKind, type EconomyBoard, type EconomyTile } from "./economy.ts";

function freeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

type AuthoredProfile = typeof standard.economyProfile | typeof grand.economyProfile;
function load(kind: BoardKind, profile: AuthoredProfile): EconomyBoard {
  const tiles = profile.tiles.map((tile): EconomyTile => {
    const { index, type } = tile;
    if (type === "property" && tile.propertyId !== undefined) return { index, type, propertyId: tile.propertyId };
    if (type === "card" && (tile.deck === "surprise" || tile.deck === "treasure")) return { index, type, deck: tile.deck };
    if (tile.name !== undefined) {
      if (type === "corner" || type === "utility" || type === "transit") return { index, type, name: tile.name };
      if (type === "tax" && tile.amount !== undefined) return { index, type, name: tile.name, amount: tile.amount };
      if (type === "grand-special" && (tile.name === "Auction Hub" || tile.name === "Gift/Choice" || tile.name === "Transit Pass")) {
        return { index, type, name: tile.name };
      }
    }
    throw new Error(`Invalid authored ${kind} tile ${index}`);
  });
  return freeze({ ...profile, kind, tiles });
}

export const STANDARD_CANDIDATE = load("standard", standard.economyProfile);
export const GRAND_CANDIDATE = load("grand", grand.economyProfile);
export const CANDIDATE_SIMULATION_RULES = Object.freeze({
  developmentActions: CANDIDATE_RULES.developmentActions,
  startLandingBonus: CANDIDATE_RULES.startLandingBonus,
  holdingReleaseFee: CANDIDATE_RULES.holdingReleaseFee,
  movement: CANDIDATE_RULES.grandMovement,
  utilityCardUsesDice: true,
});
