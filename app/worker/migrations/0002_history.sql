-- RT-012: finalized games, delivered idempotently by game_id from the room.
CREATE TABLE finished_games (
  game_id TEXT PRIMARY KEY,
  room_code TEXT NOT NULL,
  board_ref TEXT NOT NULL,
  match_mode TEXT NOT NULL,
  ended_at INTEGER NOT NULL,
  outcome_json TEXT NOT NULL,
  eliminations_json TEXT NOT NULL,
  incidents_json TEXT NOT NULL
);

CREATE TABLE finished_game_players (
  game_id TEXT NOT NULL REFERENCES finished_games (game_id),
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  placement INTEGER NOT NULL,
  winner INTEGER NOT NULL,
  PRIMARY KEY (game_id, user_id)
);

CREATE INDEX finished_game_players_by_user ON finished_game_players (user_id, game_id);

-- RT-015: room creation rate limit (10 per user per hour).
CREATE TABLE room_creations (
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX room_creations_by_user ON room_creations (user_id, created_at);
