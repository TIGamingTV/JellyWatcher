-- 1.1.0: Janitor, automatic cleanup of watched requests (only active with JW_JANITOR=1).

-- Cleanup rules, checked in position order; the first enabled rule that matches a request claims it.
-- match / watchers / steps are JSON validated by the server (shared/janitor.ts).
CREATE TABLE janitor_rules (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 0,
  media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
  -- 'movie' for movies; 'season' or 'series' for shows.
  unit       TEXT NOT NULL CHECK (unit IN ('movie', 'season', 'series')),
  mode       TEXT NOT NULL DEFAULT 'dry_run' CHECK (mode IN ('dry_run', 'approval', 'auto')),
  position   INTEGER NOT NULL DEFAULT 0,
  match      TEXT NOT NULL DEFAULT '{}',
  watchers   TEXT NOT NULL DEFAULT '{}',
  steps      TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One unit of work (a movie, a season or a whole show) moving through a rule's steps.
-- season: -1 for a movie or a whole show.
CREATE TABLE janitor_candidates (
  id          INTEGER PRIMARY KEY,
  rule_id     INTEGER NOT NULL REFERENCES janitor_rules(id) ON DELETE CASCADE,
  title_id    INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  season      INTEGER NOT NULL DEFAULT -1,
  state       TEXT NOT NULL CHECK (state IN ('waiting', 'awaiting_approval', 'running', 'done', 'failed')),
  step_index  INTEGER NOT NULL DEFAULT 0,
  -- Waits count from here: when the last person needed finished watching, then from each finished step.
  anchor_at   TEXT NOT NULL,
  eligible_at TEXT NOT NULL,
  next_run_at TEXT,
  dry_run     INTEGER NOT NULL DEFAULT 0,
  -- A destructive step ran for real; the candidate is no longer cancelled when the rule changes.
  acted       INTEGER NOT NULL DEFAULT 0,
  approved_at TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  context     TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (rule_id, title_id, season)
);
CREATE INDEX janitor_candidates_state ON janitor_candidates(state, next_run_at);
CREATE INDEX janitor_candidates_title ON janitor_candidates(title_id);

-- Never clean these up: a title (season -1) or one season, for every rule (rule_id NULL) or one,
-- forever (until NULL) or until a date.
CREATE TABLE janitor_exclusions (
  id         INTEGER PRIMARY KEY,
  title_id   INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  season     INTEGER NOT NULL DEFAULT -1,
  rule_id    INTEGER REFERENCES janitor_rules(id) ON DELETE CASCADE,
  until      TEXT,
  reason     TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX janitor_exclusions_title ON janitor_exclusions(title_id);

-- Audit trail of every step (outcome 'would' in dry runs). Kept when rules or titles go away.
CREATE TABLE janitor_log (
  id           INTEGER PRIMARY KEY,
  candidate_id INTEGER,
  rule_id      INTEGER,
  rule_name    TEXT,
  title_id     INTEGER,
  title        TEXT NOT NULL,
  season       INTEGER NOT NULL DEFAULT -1,
  step         TEXT NOT NULL,
  outcome      TEXT NOT NULL CHECK (outcome IN ('ok', 'would', 'skipped', 'failed', 'info')),
  message      TEXT,
  freed_bytes  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);
CREATE INDEX janitor_log_created ON janitor_log(created_at);
