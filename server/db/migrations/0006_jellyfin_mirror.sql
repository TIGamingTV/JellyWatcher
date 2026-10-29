-- 0.7.0: lists shown in Jellyfin as a collection or a private playlist (kept in sync by the plugin).

-- NULL: not shown in Jellyfin. 'collection': a Jellyfin collection (visible to everyone who can see
-- the titles). 'playlist': a private playlist of the list owner's Jellyfin account.
ALTER TABLE lists ADD COLUMN jellyfin_mirror TEXT CHECK (jellyfin_mirror IN ('collection', 'playlist'));

-- What the plugin last reported for each mirrored list.
CREATE TABLE list_mirrors (
  list_id     INTEGER PRIMARY KEY REFERENCES lists(id) ON DELETE CASCADE,
  mode        TEXT NOT NULL,
  jellyfin_id TEXT,
  applied     INTEGER NOT NULL DEFAULT 0,
  missing     INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  synced_at   TEXT NOT NULL
);
