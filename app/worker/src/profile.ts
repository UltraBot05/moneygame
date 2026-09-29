import { COSMETICS, type CosmeticKind, type HistoryEntry, type ProfileActionResult, type ProfileView } from "@moneygame/shared";
import type { UserRecord } from "./identity";

/**
 * META-001..006: the profile read model. Everything except cosmetic ownership is derived from
 * finalized history on read, so a retried or duplicated finalization can never double-award
 * (history rows are unique by game_id and user_id). Players the Collusion Guard removed earn
 * nothing from that match. Only rooms write history: there is no sandbox path into it.
 */

export const XP_PER_GAME = 100;
export const XP_PER_PLACE_BEATEN = 20;
export const XP_WIN_BONUS = 100;
export const COINS_PER_GAME = 10;
export const COINS_PER_PLACE_BEATEN = 5;
export const COINS_WIN_BONUS = 20;
const LEVEL_STEP_XP = 250;
const HISTORY_LIMIT = 20;

/** Level L starts at 250 x (L-1)^2 XP: 250, 1000, 2250, ... */
export function levelFor(xp: number): Readonly<{ level: number; levelStartXp: number; nextLevelXp: number }> {
  const level = 1 + Math.floor(Math.sqrt(xp / LEVEL_STEP_XP));
  return { level, levelStartXp: LEVEL_STEP_XP * (level - 1) ** 2, nextLevelXp: LEVEL_STEP_XP * level ** 2 };
}

export interface Progress {
  readonly xp: number;
  readonly coinsEarned: number;
  readonly gamesPlayed: number;
  readonly wins: number;
  readonly achievements: readonly string[];
}

/** Pure progression from a player's finalized matches. */
export function deriveProgress(history: readonly HistoryEntry[]): Progress {
  let xp = 0;
  let coinsEarned = 0;
  const counted = history.filter((entry) => !entry.removed);
  for (const entry of counted) {
    const beaten = Math.max(0, entry.players - entry.placement);
    xp += XP_PER_GAME + XP_PER_PLACE_BEATEN * beaten + (entry.winner ? XP_WIN_BONUS : 0);
    coinsEarned += COINS_PER_GAME + COINS_PER_PLACE_BEATEN * beaten + (entry.winner ? COINS_WIN_BONUS : 0);
  }
  const wins = counted.filter((entry) => entry.winner).length;
  const earned: [string, boolean][] = [
    ["FIRST_GAME", counted.length >= 1],
    ["FIRST_WIN", wins >= 1],
    ["FIVE_WINS", wins >= 5],
    ["VETERAN", counted.length >= 25],
    ["GRAND_TOUR", counted.some((entry) => entry.boardRef.includes("grand"))],
    ["FULL_TABLE", counted.some((entry) => entry.players >= 10)],
    ["TEAM_VICTORY", counted.some((entry) => entry.winner && entry.matchMode === "TEAMS")],
  ];
  return {
    xp, coinsEarned, gamesPlayed: counted.length, wins,
    achievements: earned.filter(([, done]) => done).map(([id]) => id),
  };
}

interface HistoryRow extends Record<string, unknown> {
  game_id: string;
  board_ref: string;
  match_mode: string;
  ended_at: number;
  eliminations_json: string;
  placement: number;
  winner: number;
  players: number;
}

function removedIn(eliminationsJson: string, userId: string): boolean {
  try {
    const facts = JSON.parse(eliminationsJson) as readonly { userId?: unknown; reason?: unknown }[];
    return facts.some((fact) => fact.userId === userId && fact.reason === "REMOVED");
  } catch {
    return false;
  }
}

async function historyOf(db: D1Database, userId: string): Promise<HistoryEntry[]> {
  const { results } = await db.prepare(
    `SELECT g.game_id, g.board_ref, g.match_mode, g.ended_at, g.eliminations_json, p.placement, p.winner,
            (SELECT COUNT(*) FROM finished_game_players AS q WHERE q.game_id = g.game_id) AS players
       FROM finished_game_players AS p JOIN finished_games AS g ON g.game_id = p.game_id
      WHERE p.user_id = ?
      ORDER BY g.ended_at DESC, g.game_id DESC`,
  ).bind(userId).all<HistoryRow>();
  return results.map((row) => {
    const removed = removedIn(row.eliminations_json, userId);
    return {
      gameId: row.game_id, boardRef: row.board_ref, matchMode: row.match_mode === "TEAMS" ? "TEAMS" : "FFA",
      endedAt: Number(row.ended_at), players: Number(row.players), placement: Number(row.placement),
      winner: Number(row.winner) === 1, removed,
    };
  });
}

async function spent(db: D1Database, userId: string): Promise<number> {
  const row = await db.prepare(`SELECT COALESCE(SUM(price), 0) AS total FROM cosmetic_purchases WHERE user_id = ?`)
    .bind(userId).first<{ total: number }>();
  return Number(row?.total ?? 0);
}

/** The colour of the user's equipped ring, for display in rooms; null when none. */
export async function equippedRing(db: D1Database, userId: string): Promise<string | null> {
  const row = await db.prepare(`SELECT item_id FROM cosmetic_equipped WHERE user_id = ? AND kind = 'RING'`).bind(userId).first<{ item_id: string }>();
  return COSMETICS.find((item) => item.itemId === row?.item_id)?.value ?? null;
}

export async function loadProfile(db: D1Database, user: UserRecord): Promise<ProfileView> {
  const history = await historyOf(db, user.userId);
  const progress = deriveProgress(history);
  const owned = await db.prepare(`SELECT item_id FROM cosmetic_purchases WHERE user_id = ? ORDER BY purchased_at, item_id`)
    .bind(user.userId).all<{ item_id: string }>();
  const equippedRows = await db.prepare(`SELECT kind, item_id FROM cosmetic_equipped WHERE user_id = ?`)
    .bind(user.userId).all<{ kind: string; item_id: string }>();
  const equipped: Record<CosmeticKind, string | null> = { RING: null, TITLE: null };
  for (const row of equippedRows.results) if (row.kind === "RING" || row.kind === "TITLE") equipped[row.kind] = row.item_id;
  return {
    userId: user.userId,
    displayName: user.displayName,
    ...levelFor(progress.xp),
    xp: progress.xp,
    coins: progress.coinsEarned - await spent(db, user.userId),
    gamesPlayed: progress.gamesPlayed,
    wins: progress.wins,
    achievements: progress.achievements,
    history: history.slice(0, HISTORY_LIMIT),
    inventory: owned.results.map((row) => row.item_id),
    equipped,
  };
}

/**
 * Buys a cosmetic once. The balance check and insert are one SQL statement, so two concurrent
 * purchases cannot overspend (coins earned only grow between the read and the write).
 */
export async function purchaseCosmetic(db: D1Database, user: UserRecord, itemId: string, now: number): Promise<ProfileActionResult> {
  const item = COSMETICS.find((candidate) => candidate.itemId === itemId);
  if (item === undefined) return { ok: false, error: "UNKNOWN_ITEM" };
  const earned = deriveProgress(await historyOf(db, user.userId)).coinsEarned;
  const result = await db.prepare(
    `INSERT OR IGNORE INTO cosmetic_purchases (user_id, item_id, price, purchased_at)
     SELECT ?, ?, ?, ? WHERE (SELECT COALESCE(SUM(price), 0) FROM cosmetic_purchases WHERE user_id = ?) + ? <= ?`,
  ).bind(user.userId, item.itemId, item.price, now, user.userId, item.price, earned).run();
  const owned = await db.prepare(`SELECT 1 AS owned FROM cosmetic_purchases WHERE user_id = ? AND item_id = ?`)
    .bind(user.userId, item.itemId).first();
  if (Number(result.meta.changes ?? 0) === 0 && owned === null) return { ok: false, error: "NOT_ENOUGH_COINS" };
  return { ok: true, profile: await loadProfile(db, user) };
}

/** Equips an owned cosmetic, or clears the slot for `kind` when itemId is null. */
export async function equipCosmetic(db: D1Database, user: UserRecord, kind: CosmeticKind, itemId: string | null): Promise<ProfileActionResult> {
  if (itemId === null) {
    await db.prepare(`DELETE FROM cosmetic_equipped WHERE user_id = ? AND kind = ?`).bind(user.userId, kind).run();
    return { ok: true, profile: await loadProfile(db, user) };
  }
  const item = COSMETICS.find((candidate) => candidate.itemId === itemId);
  if (item === undefined || item.kind !== kind) return { ok: false, error: "UNKNOWN_ITEM" };
  const owned = await db.prepare(`SELECT 1 AS owned FROM cosmetic_purchases WHERE user_id = ? AND item_id = ?`)
    .bind(user.userId, itemId).first();
  if (owned === null) return { ok: false, error: "NOT_OWNED" };
  await db.prepare(
    `INSERT INTO cosmetic_equipped (user_id, kind, item_id) VALUES (?, ?, ?)
     ON CONFLICT (user_id, kind) DO UPDATE SET item_id = excluded.item_id`,
  ).bind(user.userId, kind, itemId).run();
  return { ok: true, profile: await loadProfile(db, user) };
}
