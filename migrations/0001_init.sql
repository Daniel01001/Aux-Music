-- Aux schema. Songs are stored as tracks with a source (yt = YouTube, au = Audius),
-- so a playlist is a list of songs rather than a list of YouTube videos.

CREATE TABLE users (
  id TEXT PRIMARY KEY,                -- the @ID, lowercase
  name TEXT NOT NULL,
  credits INTEGER NOT NULL DEFAULT 5,
  google_sub TEXT UNIQUE,
  email TEXT,
  sample INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- One row per signed-in device. Only a SHA-256 of the token is stored.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE tracks (
  id TEXT PRIMARY KEY,                -- "<source>:<source_id>", e.g. yt:dQw4w9WgXcQ
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  title TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  art TEXT NOT NULL DEFAULT '',
  duration INTEGER,
  isrc TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE playlists (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX playlists_owner ON playlists(owner);

CREATE TABLE playlist_songs (
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id TEXT NOT NULL REFERENCES tracks(id),
  added_by TEXT,                      -- null when the owner added it
  added_at INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, track_id)
);

-- Every credit change, so balances can be audited or rebuilt.
CREATE TABLE credit_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,               -- start | add_song | listen
  ref TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX credit_ledger_user ON credit_ledger(user_id);

-- One listening credit per user, per song, per playlist.
CREATE TABLE listens (
  user_id TEXT NOT NULL,
  playlist_id TEXT NOT NULL,
  track_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (user_id, playlist_id, track_id)
);

CREATE TABLE search_cache (
  key TEXT PRIMARY KEY,
  results TEXT NOT NULL,
  at INTEGER NOT NULL
);
