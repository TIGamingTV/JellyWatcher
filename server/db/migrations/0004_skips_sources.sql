-- 0.4.0: "not watching" marks, and season air dates for sorting lists by release date.

-- Titles, seasons and episodes a person decided not to watch. Skipped entries are passed over by
-- Up Next and left out of the watch time still to go. season = -1: the whole title;
-- episode = -1: a whole season. Watched always wins over skipped.
CREATE TABLE skipped_entries (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title_id   INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  season     INTEGER NOT NULL DEFAULT -1,
  episode    INTEGER NOT NULL DEFAULT -1,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, title_id, season, episode)
);
CREATE INDEX skipped_entries_title ON skipped_entries(title_id);

-- Season metadata now includes air dates; refresh shows so they get them.
UPDATE titles SET metadata_updated_at = NULL WHERE media_type = 'tv';
