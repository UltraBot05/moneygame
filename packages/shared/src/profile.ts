/**
 * Section H profile contract shared by the worker (`/api/profile`) and the web client.
 * Progression is server-derived from finalized games only; the client never authors it.
 */

export type CosmeticKind = "RING" | "TITLE";

export interface CosmeticItem {
  readonly itemId: string;
  readonly kind: CosmeticKind;
  readonly name: string;
  readonly price: number;
  /** Ring colour or title text. Purely visual: no gameplay effect anywhere. */
  readonly value: string;
}

export const COSMETICS: readonly CosmeticItem[] = Object.freeze([
  { itemId: "ring-brass", kind: "RING", name: "Brass ring", price: 60, value: "#E3BC63" },
  { itemId: "ring-paper", kind: "RING", name: "Paper ring", price: 60, value: "#F9F6EE" },
  { itemId: "ring-jade", kind: "RING", name: "Jade ring", price: 120, value: "#7BC49B" },
  { itemId: "ring-signal", kind: "RING", name: "Signal ring", price: 200, value: "#EC3013" },
  { itemId: "title-dealer", kind: "TITLE", name: "Dealer", price: 100, value: "Dealer" },
  { itemId: "title-landlord", kind: "TITLE", name: "Landlord", price: 250, value: "Landlord" },
  { itemId: "title-tycoon", kind: "TITLE", name: "Tycoon", price: 500, value: "Tycoon" },
]);

export interface AchievementDefinition {
  readonly achievementId: string;
  readonly name: string;
  readonly description: string;
}

export const ACHIEVEMENTS: readonly AchievementDefinition[] = Object.freeze([
  { achievementId: "FIRST_GAME", name: "First table", description: "Finish a match." },
  { achievementId: "FIRST_WIN", name: "First win", description: "Win a match." },
  { achievementId: "FIVE_WINS", name: "Regular winner", description: "Win five matches." },
  { achievementId: "VETERAN", name: "Veteran", description: "Finish 25 matches." },
  { achievementId: "GRAND_TOUR", name: "Grand tour", description: "Finish a match on the Grand board." },
  { achievementId: "FULL_TABLE", name: "Full table", description: "Finish a ten-player match." },
  { achievementId: "TEAM_VICTORY", name: "Team victory", description: "Win a Teams match." },
]);

export interface HistoryEntry {
  readonly gameId: string;
  readonly boardRef: string;
  readonly matchMode: "FFA" | "TEAMS";
  readonly endedAt: number;
  readonly players: number;
  readonly placement: number;
  readonly winner: boolean;
  /** Removed by the Collusion Guard: the match earned nothing. */
  readonly removed: boolean;
}

export interface ProfileView {
  readonly userId: string;
  readonly displayName: string;
  readonly level: number;
  readonly xp: number;
  readonly levelStartXp: number;
  readonly nextLevelXp: number;
  readonly coins: number;
  readonly gamesPlayed: number;
  readonly wins: number;
  readonly achievements: readonly string[];
  /** Most recent first, capped. */
  readonly history: readonly HistoryEntry[];
  readonly inventory: readonly string[];
  readonly equipped: Readonly<Record<CosmeticKind, string | null>>;
}

export type ProfileActionResult =
  | { readonly ok: true; readonly profile: ProfileView }
  | { readonly ok: false; readonly error: "UNKNOWN_ITEM" | "NOT_ENOUGH_COINS" | "NOT_OWNED" };
