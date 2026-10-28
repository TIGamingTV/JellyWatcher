-- JellyWatcher initial schema
-- Timestamps are ISO-8601 UTC strings.

CREATE TABLE users (
  id                INTEGER PRIMARY KEY,
  username          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name      TEXT NOT NULL,
  password_hash     TEXT,
  role              TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  auth_source       TEXT NOT NULL DEFAULT 'local' CHECK (auth_source IN ('local', 'jellyfin')),
  jellyfin_user_id  TEXT UNIQUE,
  jellyfin_username TEXT,
  seerr_user_id     INTEGER,
  seerr_username    TEXT,
  seerr_permissions INTEGER,
  disabled          INTEGER NOT NULL DEFAULT 0,
  preferences       TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,           -- sha256(token), the raw token only lives in the cookie
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent   TEXT,
  ip           TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Server-wide integrations configured by an admin (jellyfin, seerr, tmdb, trakt app).
CREATE TABLE integrations (
  provider        TEXT PRIMARY KEY,
  enabled         INTEGER NOT NULL DEFAULT 1,
  config          TEXT NOT NULL DEFAULT '{}',
  secrets         TEXT,                     -- AES-256-GCM encrypted JSON
  status          TEXT NOT NULL DEFAULT 'unconfigured',
  last_checked_at TEXT,
  last_ok_at      TEXT,
  last_error      TEXT,
  server_info     TEXT,
  updated_at      TEXT NOT NULL
);

-- Per-user source connections (trakt account, letterboxd username, ...).
CREATE TABLE connections (
  id             INTEGER PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider       TEXT NOT NULL,
  account_name   TEXT,
  config         TEXT NOT NULL DEFAULT '{}',
  secrets        TEXT,
  status         TEXT NOT NULL DEFAULT 'connected',
  last_error     TEXT,
  last_synced_at TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (user_id, provider)
);

-- Canonical titles, deduplicated by (media_type, tmdb_id) when the TMDb id is known.
CREATE TABLE titles (
  id                  INTEGER PRIMARY KEY,
  media_type          TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
  tmdb_id             INTEGER,
  imdb_id             TEXT,
  tvdb_id             INTEGER,
  title               TEXT NOT NULL,
  original_title      TEXT,
  year                INTEGER,
  release_date        TEXT,
  overview            TEXT,
  poster_path         TEXT,
  backdrop_path       TEXT,
  genres              TEXT NOT NULL DEFAULT '[]',
  runtime             INTEGER,
  metadata_source     TEXT,
  metadata_updated_at TEXT,
  metadata_error      TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE UNIQUE INDEX titles_tmdb ON titles(media_type, tmdb_id) WHERE tmdb_id IS NOT NULL;
CREATE INDEX titles_imdb ON titles(imdb_id) WHERE imdb_id IS NOT NULL;
CREATE INDEX titles_tvdb ON titles(tvdb_id) WHERE tvdb_id IS NOT NULL;
CREATE INDEX titles_title ON titles(title COLLATE NOCASE);

CREATE TABLE lists (
  id              INTEGER PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id   INTEGER REFERENCES connections(id) ON DELETE SET NULL,
  provider        TEXT NOT NULL,
  kind            TEXT NOT NULL,            -- watchlist | owned | liked | public | upload | diary
  external_id     TEXT NOT NULL,            -- provider-specific stable key
  source_ref      TEXT NOT NULL DEFAULT '{}', -- provider-specific JSON needed to re-fetch the list
  name            TEXT NOT NULL,
  description     TEXT,
  owner_name      TEXT,
  url             TEXT,
  auto_sync       INTEGER NOT NULL DEFAULT 1,
  sync_supported  INTEGER NOT NULL DEFAULT 1,
  last_synced_at  TEXT,
  last_attempt_at TEXT,
  last_status     TEXT,                     -- ok | error | running | partial
  last_error      TEXT,
  item_count      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (user_id, provider, external_id)
);

CREATE TABLE list_items (
  id               INTEGER PRIMARY KEY,
  list_id          INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  source_key       TEXT NOT NULL,
  title_id         INTEGER REFERENCES titles(id) ON DELETE SET NULL,
  media_type       TEXT,
  source_title     TEXT NOT NULL,
  source_year      INTEGER,
  tmdb_id          INTEGER,
  imdb_id          TEXT,
  tvdb_id          INTEGER,
  source_url       TEXT,
  position         INTEGER,
  listed_at        TEXT,
  notes            TEXT,
  rating           REAL,
  watched_at       TEXT,
  match_status     TEXT NOT NULL DEFAULT 'pending', -- pending | matched | review | unmatched | ignored
  match_method     TEXT,
  match_confidence REAL,
  match_candidates TEXT,
  match_attempts   INTEGER NOT NULL DEFAULT 0,
  first_seen_at    TEXT NOT NULL,
  last_seen_at     TEXT NOT NULL,
  UNIQUE (list_id, source_key)
);
CREATE INDEX list_items_title ON list_items(title_id);
CREATE INDEX list_items_status ON list_items(match_status);

-- User decisions on uncertain matches; reused whenever the same source entry is imported again.
CREATE TABLE match_resolutions (
  fingerprint TEXT PRIMARY KEY,
  title_id    INTEGER REFERENCES titles(id) ON DELETE CASCADE,
  ignored     INTEGER NOT NULL DEFAULT 0,
  decided_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE jellyfin_items (
  id             TEXT PRIMARY KEY,
  server_id      TEXT,
  media_type     TEXT NOT NULL,
  name           TEXT NOT NULL,
  year           INTEGER,
  tmdb_id        INTEGER,
  imdb_id        TEXT,
  tvdb_id        INTEGER,
  image_tag      TEXT,
  date_created   TEXT,
  episode_count  INTEGER,
  title_id       INTEGER REFERENCES titles(id) ON DELETE SET NULL,
  first_seen_at  TEXT NOT NULL,
  last_seen_run  INTEGER,
  updated_at     TEXT NOT NULL
);
CREATE INDEX jellyfin_items_title ON jellyfin_items(title_id);
CREATE INDEX jellyfin_items_tmdb ON jellyfin_items(media_type, tmdb_id);

CREATE TABLE jellyfin_user_data (
  item_id           TEXT NOT NULL REFERENCES jellyfin_items(id) ON DELETE CASCADE,
  jellyfin_user_id  TEXT NOT NULL,
  played            INTEGER NOT NULL DEFAULT 0,
  play_count        INTEGER,
  played_percentage REAL,
  unplayed_count    INTEGER,
  position_ticks    INTEGER,
  runtime_ticks     INTEGER,
  last_played_at    TEXT,
  is_favorite       INTEGER NOT NULL DEFAULT 0,
  synced_at         TEXT NOT NULL,
  PRIMARY KEY (item_id, jellyfin_user_id)
);

-- Seerr's view of media (request/availability status), keyed by TMDb id.
CREATE TABLE seerr_media (
  media_type       TEXT NOT NULL,
  tmdb_id          INTEGER NOT NULL,
  seerr_media_id   INTEGER,
  status           INTEGER,
  status4k         INTEGER,
  seasons          TEXT,
  jellyfin_item_id TEXT,
  synced_at        TEXT NOT NULL,
  PRIMARY KEY (media_type, tmdb_id)
);

CREATE TABLE requests (
  id               INTEGER PRIMARY KEY,
  user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title_id         INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  seerr_request_id INTEGER UNIQUE,
  seerr_user_id    INTEGER,
  requested_by     TEXT,
  request_status   INTEGER,
  media_status     INTEGER,
  is4k             INTEGER NOT NULL DEFAULT 0,
  seasons          TEXT,
  origin           TEXT NOT NULL DEFAULT 'jellywatcher', -- jellywatcher | seerr
  last_error       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  synced_at        TEXT
);
CREATE INDEX requests_title ON requests(title_id);
CREATE INDEX requests_user ON requests(user_id);

CREATE TABLE sync_runs (
  id          INTEGER PRIMARY KEY,
  job         TEXT NOT NULL,
  scope       TEXT,
  trigger     TEXT NOT NULL,
  status      TEXT NOT NULL,               -- running | ok | partial | error | skipped
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  stats       TEXT,
  error       TEXT
);
CREATE INDEX sync_runs_job ON sync_runs(job, started_at);

CREATE TABLE activity (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,  -- NULL = visible to everyone
  kind       TEXT NOT NULL,
  title_id   INTEGER REFERENCES titles(id) ON DELETE CASCADE,
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX activity_user ON activity(user_id, created_at);
