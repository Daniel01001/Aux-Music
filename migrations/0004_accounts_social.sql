-- Profiles, per-device sessions, likes, an inbox, and web push subscriptions.

ALTER TABLE users ADD COLUMN bio TEXT;
ALTER TABLE users ADD COLUMN avatar TEXT;            -- shown photo URL, or null for the initial
ALTER TABLE users ADD COLUMN google_picture TEXT;    -- offered as the photo; only shown if chosen
ALTER TABLE users ADD COLUMN handle_changed_at INTEGER;

ALTER TABLE sessions ADD COLUMN device TEXT;
ALTER TABLE sessions ADD COLUMN last_seen INTEGER;

CREATE TABLE likes (
  user_id TEXT NOT NULL,
  playlist_id TEXT NOT NULL,
  track_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (user_id, playlist_id, track_id)
);
CREATE INDEX likes_song ON likes(playlist_id, track_id);

CREATE TABLE inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- added | liked
  actor TEXT,
  text TEXT NOT NULL,
  url TEXT,
  at INTEGER NOT NULL,
  read INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX inbox_user ON inbox(user_id, at);

CREATE TABLE push_subs (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX push_subs_user ON push_subs(user_id);
