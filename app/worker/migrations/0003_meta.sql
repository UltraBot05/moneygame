-- Section H: cosmetic ownership is the only stored progression. XP, levels, coins earned and
-- achievements are derived from finished_game_players, which is idempotent by (game_id, user_id).
CREATE TABLE cosmetic_purchases (
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  price INTEGER NOT NULL,
  purchased_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id)
);

CREATE TABLE cosmetic_equipped (
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  item_id TEXT NOT NULL,
  PRIMARY KEY (user_id, kind)
);
