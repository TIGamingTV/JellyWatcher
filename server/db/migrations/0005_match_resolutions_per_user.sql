-- Match decisions belong to the person who made them. Before, one decision per entry
-- fingerprint was shared by everyone, so a user could change (or hide) how other people's imported
-- entries matched. Decisions by administrators still apply to everyone without their own.

CREATE TABLE match_resolutions_new (
  fingerprint TEXT NOT NULL,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title_id    INTEGER REFERENCES titles(id) ON DELETE CASCADE,
  ignored     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (fingerprint, user_id)
);

INSERT INTO match_resolutions_new (fingerprint, user_id, title_id, ignored, created_at)
  SELECT fingerprint, decided_by, title_id, ignored, created_at FROM match_resolutions WHERE decided_by IS NOT NULL;

DROP TABLE match_resolutions;
ALTER TABLE match_resolutions_new RENAME TO match_resolutions;
CREATE INDEX match_resolutions_title ON match_resolutions(title_id);
