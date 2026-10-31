-- 1.0.0: episode guide for expanding shows in a timeline.

-- Episodes of a show's seasons (specials included) from TMDb or Seerr: name, air date and runtime
-- (Seerr gives no runtime). Refreshed on demand when a show is expanded and the copy is old.
CREATE TABLE title_episodes (
  title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  season   INTEGER NOT NULL,
  episode  INTEGER NOT NULL,
  name     TEXT,
  air_date TEXT,
  runtime  INTEGER,
  PRIMARY KEY (title_id, season, episode)
);

-- When the episode guide was last read (NULL: never); an error keeps the old copy.
ALTER TABLE titles ADD COLUMN episodes_fetched_at TEXT;
