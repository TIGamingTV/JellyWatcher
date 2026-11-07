-- 1.2.0: Janitor monitors the next season of a show once a requester nearly finished a season.

-- JSON validated by the server (shared/janitor.ts JanitorNextSeason); '{}' means off.
ALTER TABLE janitor_rules ADD COLUMN next_season TEXT NOT NULL DEFAULT '{}';

-- Seasons the Janitor added to a Seerr request (Seerr's own request still lists only what was
-- requested). The Janitor treats them as requested by that request: cleaned up once watched, and
-- the request is only deleted with them.
CREATE TABLE janitor_request_seasons (
  request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  season     INTEGER NOT NULL,
  title_id   INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  rule_id    INTEGER REFERENCES janitor_rules(id) ON DELETE SET NULL,
  -- 1: the Janitor turned monitoring on in Sonarr; 0: it was already monitored.
  monitored  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (request_id, season)
);
CREATE INDEX janitor_request_seasons_title ON janitor_request_seasons(title_id);

CREATE INDEX janitor_log_title ON janitor_log(title_id, season, step);
