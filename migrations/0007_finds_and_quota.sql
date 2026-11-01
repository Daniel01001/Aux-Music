-- YouTube searches each person has made today (Pacific date, when Google's quota resets).
CREATE TABLE yt_usage (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- How often a cached search is reused: popular ones get refreshed overnight, and power suggestions.
ALTER TABLE search_cache ADD COLUMN hits INTEGER NOT NULL DEFAULT 0;

-- Genre of a song (from Audius), used to learn what each person likes.
ALTER TABLE tracks ADD COLUMN genre TEXT;

-- Each person's own Fresh finds. A song nobody has played for 2 days is dropped and replaced;
-- dropped songs aren't brought back for a while.
CREATE TABLE fresh_pool (
  user_id TEXT NOT NULL,
  track_id TEXT NOT NULL,
  track TEXT NOT NULL,          -- the song as JSON, so the row can be shown without lookups
  added_at INTEGER NOT NULL,
  last_played INTEGER,
  dropped_at INTEGER,
  PRIMARY KEY (user_id, track_id)
);
CREATE INDEX fresh_pool_user ON fresh_pool(user_id, dropped_at);
