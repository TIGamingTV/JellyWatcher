-- 0.2.0: ordered timelines with season/episode entries, and viewing history that survives
-- titles leaving the library (deleted in Seerr / Sonarr / Radarr after watching).

-- How a list is shown: auto (timeline when the name suggests a watch order), grid or timeline.
ALTER TABLE lists ADD COLUMN display TEXT NOT NULL DEFAULT 'auto';

-- Entries can point at one season or one episode of a show (title_id is then the show).
ALTER TABLE list_items ADD COLUMN season_number INTEGER;
ALTER TABLE list_items ADD COLUMN episode_number INTEGER;
ALTER TABLE list_items ADD COLUMN episode_title TEXT;
-- Facts reported by the source, used when metadata has none: minutes per movie / per episode,
-- and the size of a whole-series entry.
ALTER TABLE list_items ADD COLUMN source_runtime INTEGER;
ALTER TABLE list_items ADD COLUMN source_episodes INTEGER;
ALTER TABLE list_items ADD COLUMN source_seasons INTEGER;
CREATE INDEX list_items_order ON list_items(list_id, position);

-- Regular-season episode/season counts and per-season sizes: [{"season":1,"episodes":10}, ...].
ALTER TABLE titles ADD COLUMN episode_count INTEGER;
ALTER TABLE titles ADD COLUMN season_count INTEGER;
ALTER TABLE titles ADD COLUMN seasons TEXT;
-- Existing show metadata predates these columns.
UPDATE titles SET metadata_updated_at = NULL WHERE media_type = 'tv';

ALTER TABLE jellyfin_items ADD COLUMN runtime_ticks INTEGER;
-- Signature of the series-level user data when its episodes were last read (skips unchanged series).
ALTER TABLE jellyfin_user_data ADD COLUMN episodes_sig TEXT;

-- Episodes of indexed series (presence and runtime).
CREATE TABLE jellyfin_episodes (
  id            TEXT PRIMARY KEY,
  series_id     TEXT NOT NULL REFERENCES jellyfin_items(id) ON DELETE CASCADE,
  season        INTEGER NOT NULL,
  episode       INTEGER NOT NULL,
  runtime_ticks INTEGER,
  updated_at    TEXT NOT NULL
);
CREATE INDEX jellyfin_episodes_series ON jellyfin_episodes(series_id, season, episode);

-- Last known viewing state per person and title. Written from Jellyfin while the title is in the
-- library and kept after it is removed, so watched titles stay watched.
CREATE TABLE watch_history (
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title_id        INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  state           TEXT NOT NULL CHECK (state IN ('watched', 'in_progress')),
  percent         REAL,
  played_episodes INTEGER,
  total_episodes  INTEGER,
  last_played_at  TEXT,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (user_id, title_id)
);

-- Watched episodes per person, kept after the files are deleted.
CREATE TABLE watched_episodes (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title_id  INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  season    INTEGER NOT NULL,
  episode   INTEGER NOT NULL,
  played_at TEXT,
  PRIMARY KEY (user_id, title_id, season, episode)
);
