import type { FinalizedGame } from "./room-runtime";

/**
 * RT-012: writes one finished game to D1. Idempotent by game_id (and (game_id, user_id)), so a
 * retry after an unknown outcome can never duplicate history; the batch is one D1 transaction.
 */
export async function deliverFinalization(db: D1Database, game: FinalizedGame): Promise<void> {
  await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO finished_games
         (game_id, room_code, board_ref, match_mode, ended_at, outcome_json, eliminations_json, incidents_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      game.gameId, game.roomCode, game.boardRef, game.matchMode, game.endedAt,
      JSON.stringify(game.outcome), JSON.stringify(game.eliminations), JSON.stringify(game.incidents),
    ),
    ...game.players.map((player) => db.prepare(
      `INSERT OR IGNORE INTO finished_game_players (game_id, user_id, display_name, placement, winner)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(game.gameId, player.userId, player.displayName, player.placement, player.winner ? 1 : 0)),
  ]);
}

const ROOMS_PER_HOUR = 10;
const HOUR_MS = 60 * 60 * 1000;

/** RT-015: records a room creation unless the user already created ten in the last hour. */
export async function reserveRoomCreation(db: D1Database, userId: string, now: number): Promise<boolean> {
  const recent = await db.prepare(`SELECT COUNT(*) AS count FROM room_creations WHERE user_id = ? AND created_at > ?`)
    .bind(userId, now - HOUR_MS).first<{ count: number }>();
  if ((recent?.count ?? 0) >= ROOMS_PER_HOUR) return false;
  await db.batch([
    db.prepare(`DELETE FROM room_creations WHERE created_at <= ?`).bind(now - HOUR_MS),
    db.prepare(`INSERT INTO room_creations (user_id, created_at) VALUES (?, ?)`).bind(userId, now),
  ]);
  return true;
}
