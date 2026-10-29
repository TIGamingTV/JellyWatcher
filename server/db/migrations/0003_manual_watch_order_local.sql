-- 0.3.0: manual watch marks, personal list order and local (editable) lists.

-- Titles, seasons and episodes a person marked as watched themselves. Kept apart from the Jellyfin
-- mirror so a sync never overwrites them. season = -1: the whole title; episode = -1: a whole season.
CREATE TABLE manual_watches (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title_id   INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  season     INTEGER NOT NULL DEFAULT -1,
  episode    INTEGER NOT NULL DEFAULT -1,
  watched_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, title_id, season, episode)
);
CREATE INDEX manual_watches_title ON manual_watches(title_id);

-- Order chosen by the person (drag and drop). NULL: follow the source order. Survives syncs.
ALTER TABLE list_items ADD COLUMN custom_position INTEGER;

-- Every list is shown as a timeline unless the person picked the grid.
UPDATE lists SET display = 'timeline' WHERE display = 'auto';
