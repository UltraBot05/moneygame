-- DATA-001: stable internal identity. Google `sub` is only the lookup key; email is never stored.
CREATE TABLE users (
  user_id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL
);
