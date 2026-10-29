# Architecture

JellyWatcher is a single Node.js process in a single container. It serves the web UI and a JSON API,
and runs the background sync jobs. State lives in one SQLite database on the `/data` volume.

```
 Browser ──HTTPS/HTTP──▶ Fastify ─┬─ routes/   (auth, CSRF, validation, per-user authorization)
                                  ├─ services/ (business logic: lists, titles, matcher, status, requests)
                                  ├─ sync/     (jobs + scheduler: lists, jellyfin, seerr, match, metadata)
                                  ├─ providers/(one adapter per external service, isolated API details)
                                  ├─ http/     (fetch client: timeouts, retries, backoff, error classes)
                                  └─ db/       (SQLite, SQL migrations)
```

## Why this stack

| Decision | Reason |
| --- | --- |
| **Node 24 + TypeScript, one language front to back** | Shared status model (`shared/status.ts`) used by both server and UI. Easy to maintain. |
| **Fastify** | Small, fast, good plugin ecosystem (cookies, multipart, rate limit, helmet, static). |
| **SQLite (better-sqlite3, WAL)** | No second container to run. The whole state is one file plus a key. Easy backup, and fast enough for a household. Synchronous transactions make sync jobs simple and atomic. |
| **In-process scheduler** | No Redis or queue to deploy. Jobs are single-flight per job and scope, recorded in `sync_runs`, and safe to retry. |
| **React + Vite + TanStack Query** | Mature, accessible, with good loading and error state handling. Code-split per screen. |
| **No UI framework; a small design system in `web/src/styles.css`** | Apple-inspired system type, semantic light/dark colours, inset grouped lists, and blur only on the navigation layer. |

## Provider adapters

Each external service has one module in `server/providers/` that holds all of its endpoints, headers,
response validation (zod, tolerant of missing fields) and quirks:

| Adapter | Responsibility |
| --- | --- |
| `trakt.ts` | Device-code OAuth on `auth.trakt.tv`, paginated list and watchlist reads (movies, shows, seasons, episodes in rank order), list search and discovery, list URL parsing. |
| `letterboxd.ts` | Parsing the export ZIP and list CSVs, and RSS diary parsing. No scraping. |
| `imdb.ts` | Public list reads through IMDb's GraphQL endpoint (list order, episodes), list URL parsing, CSV exports with column aliases. |
| `seerr.ts` | Status, users, search, details, request creation with `X-API-User`, request and media listing. |
| `jellyfin.ts` | `MediaBrowser` auth header, credential verification, paginated library and user data, series episodes, images. |
| `tmdb.ts` | Find by external id, search, details (runtime, season and episode counts). |

`services/metadata.ts` abstracts *metadata*. It uses TMDb when a token is configured, and otherwise
Seerr's TMDb proxy, so a TMDb key is optional.

`services/timeline.ts` turns a list into ordered entries (movie, show, season or episode), each with
its episode count, runtime and watched share, plus list totals. Runtimes come from metadata, then the
source, then Jellyfin. It feeds timeline views and Home's *Up Next* (the first unwatched entry of
each list).

Adding a source means writing an adapter that produces `SourceItem[]` and registering how its lists
are fetched in `sync/lists.ts`. Matching, dedup, status and UI then work unchanged.

## Data model (see `server/db/migrations/`)

| Table | Content |
| --- | --- |
| `users`, `sessions` | Local or Jellyfin-backed accounts. Sessions store `sha256(token)` and a CSRF token. |
| `integrations` | Server-wide services. Config is JSON; secrets are AES-256-GCM encrypted. |
| `connections` | Per-user source accounts (Trakt tokens encrypted, Letterboxd username). |
| `lists`, `list_items` | Every imported list (with its display: auto, grid or timeline) and its raw entries in list order, with season/episode numbers for partial entries, source runtimes, match status, method, confidence and candidates. |
| `titles` | Canonical titles, unique on `(media_type, tmdb_id)`. |
| `match_resolutions` | Manual match decisions keyed by a source fingerprint, reused on re-import. |
| `jellyfin_items`, `jellyfin_user_data`, `jellyfin_episodes` | Library index, per-Jellyfin-user viewing state, and episodes of listed series. |
| `watch_history`, `watched_episodes` | Per-person viewing state that outlives the library, so deleted titles stay watched. |
| `seerr_media`, `requests` | Mirror of Seerr media status and requests. |
| `sync_runs`, `activity` | Job history and the Home activity feed. |

## Matching and deduplication

Order of precedence (in `services/matcher.ts`):

1. A stored manual decision for the entry's fingerprint.
2. A TMDb id from the source (Trakt, Letterboxd RSS). This match is exact.
3. An IMDb id: found locally, or resolved via `/find` or Seerr `imdb:`. This match is exact.
4. A TVDB id (shows).
5. Title + year search.
   - Scoring: Dice similarity of normalised titles (accents, punctuation, articles and roman numerals normalised), plus year proximity, minus a media-type penalty.
   - Auto-accepted only when the title is an exact normalised match, scores ≥ 0.9, and is not ambiguous (the runner-up is more than 0.06 behind).
   - Everything else goes to **Needs Review** with up to six candidates, or is marked unmatched.

All list memberships point at one `titles` row, so the same film from Trakt, Letterboxd and IMDb
appears once with all its lists. If enrichment later reveals that two rows share a TMDb id, they are
merged.

## Source of truth and sync safety

| State | Authority | Notes |
| --- | --- | --- |
| List contents | The source | `applyItems` replaces a list atomically after a *complete* fetch. Vanished entries are removed. Identity changes reset the match. Applying the same fetch twice changes nothing. |
| Library availability | Jellyfin | Removed items are deleted only after a complete successful pass. A failed sync keeps the last known index and marks it **stale**. |
| Viewing progress | Jellyfin user data for the linked account, plus the person's own marks | Never written back. Copied to `watch_history` / `watched_episodes` while a title is in the library; used once it is gone. Live data wins while present (marking unwatched in Jellyfin clears the history). Manual marks (`manual_watches`: whole title, season or episode, with a date) are stored separately, only ever add "watched", and are never touched by a sync. |
| List order | The source, unless the person reordered | Drag-and-drop order is stored in `list_items.custom_position` and survives syncs; new entries from the source follow afterwards. Resetting clears it. |
| Local lists | JellyWatcher | `provider = 'local'`: created or duplicated in JellyWatcher, edited here, never synced. Duplicates copy every entry with its match. |
| Requests | Seerr | Before a request is submitted, Seerr is checked live (`/movie|tv/{id}` as the user). Then duplicates (409), permissions, quota and blocklist (403), and missing seasons (202) are mapped to clear messages. |

JellyWatcher is **read-only** towards every service except for creating Seerr requests (and, once
during the guided setup, creating its own Jellyfin API key with the administrator's session). This
avoids loops of conflicting state.

Each status shown in the UI carries `syncedAt`, `source` and `stale`. Stale means not synced
within 3× the interval, or the last sync failed. The UI says "Possibly outdated" instead of
presenting old data as current.

## Scheduler and resilience

- **Ticks:** every minute the scheduler checks each job's interval, set in Settings › Sync. A failing job backs off after 5, 10, 20… minutes, capped at its interval.
- **Retries:** HTTP calls have timeouts and retries with jitter for 429, 502, 503, 504 and network errors, honouring `Retry-After`. Trakt calls are spaced 650 ms apart to stay under 500 requests per 5 minutes.
- **Trakt tokens:** refresh tokens are single use, so refreshes are serialised per connection and persisted before use. `invalid_grant` marks the connection *needs re-auth*.
- **Restarts:** runs interrupted by a restart are marked as such on startup.

## Security model

- **Accounts:**
  - First-run setup requires a one-time code from the container log (or `JW_SETUP_TOKEN`).
  - Passwords use scrypt (N=2¹⁵).
  - Login is rate limited.
- **Sessions and CSRF:**
  - The session cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` when the request arrived over HTTPS.
  - Every state-changing request needs the `X-CSRF-Token` header, and the `Origin` header must match.
- **Authorization:**
  - Every list and connection query is scoped to the signed-in user.
  - Server integrations, users, sync and backups are admin-only.
  - Members see only whether a service works, not its config.
- **Credentials:**
  - Encrypted at rest with AES-256-GCM. The key comes from `JW_SECRET_KEY` or `/data/secret.key` (0600).
  - Never returned by the API (only "is set").
  - Redacted from logs.
  - Jellyfin passwords used for account linking are never stored, and the resulting session is logged out immediately.
- **Outbound requests:**
  - Only to admin-configured service URLs (http/https, no embedded credentials) and fixed provider hosts.
  - The image proxy accepts only whitelisted sizes and file names, or Jellyfin item ids, so it is not an open proxy.
- **Webhooks:** authenticated with a bearer token. The payload is never trusted; it only schedules a sync.
- **HTTP headers:** strict CSP (`default-src 'self'`), `frame-ancestors 'none'`, `nosniff`, `no-referrer`.
- **Container:** non-root (uid 1000), read-only root filesystem, all capabilities dropped, `no-new-privileges`.
