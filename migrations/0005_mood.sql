-- A short "what's on your mind" line and an optional mood song, shown under the profile photo.
ALTER TABLE users ADD COLUMN mood TEXT;
ALTER TABLE users ADD COLUMN mood_track TEXT;   -- tracks.id
ALTER TABLE users ADD COLUMN mood_at INTEGER;
