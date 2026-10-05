// ponytail: each Phosphor icon ships all six weights (~4 kB); vendor just the duotone paths if bundle size ever matters.
import {
  AirplaneTilt, ArrowFatRight, ArrowsLeftRight, Drop, Gavel, Gift, Island, Lightning, LockKey, PoliceCar,
  SealQuestion, Stamp, Ticket, Train, TreasureChest, type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import type { TileModel } from "./view-model";

/** Board icons from Phosphor (MIT), drawn in its duotone weight. */
export type IconName =
  | "AIRPORT" | "RAILWAY" | "WATER" | "POWER" | "CUSTOMS" | "TREASURE" | "SURPRISE" | "EXCHANGE"
  | "GAVEL" | "GIFT" | "TICKET" | "START" | "VACATION" | "POLICE" | "LOCK";

const ICONS: Readonly<Record<IconName, PhosphorIcon>> = {
  AIRPORT: AirplaneTilt, RAILWAY: Train, WATER: Drop, POWER: Lightning, CUSTOMS: Stamp, TREASURE: TreasureChest,
  SURPRISE: SealQuestion, EXCHANGE: ArrowsLeftRight, GAVEL: Gavel, GIFT: Gift, TICKET: Ticket, START: ArrowFatRight,
  VACATION: Island, POLICE: PoliceCar, LOCK: LockKey,
};

/** Each icon's own colour on the dark board (all at least 7:1 against the tile). */
export const ICON_COLOR: Readonly<Record<IconName, string>> = {
  AIRPORT: "#8EC5FF", RAILWAY: "#C9D3DD", WATER: "#5BB8F5", POWER: "#FFD24A", CUSTOMS: "#FF8A75",
  TREASURE: "#E9C46A", SURPRISE: "#F4A64A", EXCHANGE: "#C3A3F0", GAVEL: "#C3A3F0", GIFT: "#C3A3F0",
  TICKET: "#C3A3F0", START: "#E3BC63", VACATION: "#E3BC63", POLICE: "#E3BC63", LOCK: "#E3BC63",
};

const SPECIALS: Readonly<Record<string, IconName>> = { "Auction Hub": "GAVEL", "Gift / Choice": "GIFT", "Transit Pass": "TICKET" };

/** The icon for a non-property tile, from its band code (and name, for Grand specials). */
export function tileIcon(tile: TileModel, code: string): IconName | null {
  if (tile.kind === "special") return SPECIALS[tile.name] ?? "EXCHANGE";
  return code in ICON_COLOR ? (code as IconName) : null;
}

export function Icon({ name, className }: { name: IconName; className?: string }) {
  const Glyph = ICONS[name];
  return <Glyph weight="duotone" className={className} aria-hidden="true" focusable="false" />;
}
