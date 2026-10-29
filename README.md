# JellyWatcher

A self-hosted hub for your movie and TV watchlists. JellyWatcher brings in lists from **Trakt**,
**Letterboxd** and **IMDb**, keeps their order, and matches every entry to one title without
duplicates. It shows what's already in **Jellyfin**, what you've watched, and what's been requested,
and lets you request the next thing on each list through **Seerr**.

Runs as one Docker container with one data volume. Everything is configured in the web UI.

## Features

- **Watchlists:**
  - Add a list by pasting its link: any public **IMDb list** or **Trakt list**, no sign-in needed.
  - Trakt watchlist, your own lists, liked lists, and public list search.
  - Letterboxd and IMDb exports, and the Letterboxd RSS diary.
  - Each list keeps its order and syncs on its own.
  - **Your own lists:** create a list, or duplicate any synced list into an editable copy, then add
    movies, shows, single seasons or episodes through **Discover** (search, trending, popular).
- **Timelines:** every list is shown as a timeline with each movie, show, season and episode in
  order, the film / show / season / episode counts, and the total watch time counting down as you
  watch. **Drag entries into your own order** (mouse, touch or keyboard); it survives syncs and can
  be reset to the source order. Any list can be switched to a poster grid.
- **Up Next:** the next unwatched entry of every list on Home, with a one-click request.
- **Matching:** by TMDb and IMDb ids, with fuzzy title and year matching and a review queue for
  uncertain matches. Your match decisions are remembered.
- **Search and filters** per list: title, type, genre, library state, request state, watched state, and sorting.
- **Requests via Seerr:**
  - A live eligibility check prevents duplicates.
  - For shows, you choose which seasons to request.
  - Requests are made as your linked Seerr user, so its permissions, quotas and approvals apply.
  - Clear messages for every outcome.
- **Lifecycle tracking:** On Watchlist → Requested → Processing → In Library → Watched. Each status
  comes from its authoritative service (Seerr for requests, Jellyfin for library and progress) and
  shows when it was synced. Out-of-date data is marked as such.
- **Mark as watched:** mark movies, whole shows, single seasons or single episodes as watched, with
  the date you watched them. Works with or without Jellyfin and is never overwritten by a sync.
- **Watched stays watched:** viewing history is remembered, so deleting a watched title in Seerr,
  Sonarr or Radarr afterwards doesn't reset it.
- **Library** from Jellyfin, for your linked account.
- **Multi-user, signed in with Jellyfin (like Seerr):**
  - Set up with your Jellyfin administrator account; JellyWatcher creates its own Jellyfin API key.
  - Everyone signs in with their Jellyfin account: password or **Quick Connect**.
  - Import Jellyfin users in one click; local accounts remain as a fallback.
  - Private per-user lists and connections.
  - Admin-managed account links.
- **Homelab-friendly:**
  - SQLite with automatic pre-upgrade backups and one-click backup download.
  - Health check, non-root read-only container, encrypted credentials, optional webhooks.
- **Apple-inspired interface:** system type, light and dark appearance, built for iPhone, iPad and
  desktop (safe areas, touch-sized controls, bottom sheets on phones), keyboard and screen-reader
  friendly.

## Setup

Requirements: Docker with Compose v2.24 or newer. Images for `linux/amd64` and `linux/arm64` are
published to `ghcr.io/tigamingtv/jellywatcher` (tags: `latest`, `0.3.0`, `0.3`).

### 1. Create `compose.yaml`

Create a folder (e.g. `jellywatcher/`) with this `compose.yaml`:

```yaml
services:
  jellywatcher:
    image: ghcr.io/tigamingtv/jellywatcher:latest   # or pin a version, e.g. :0.3.0
    container_name: jellywatcher
    restart: unless-stopped
    init: true
    env_file:
      - path: .env
        required: false
    environment:
      TZ: ${TZ:-UTC}
    ports:
      - "${JW_HOST_PORT:-8484}:8484"
    volumes:
      # Database, encryption key, image cache, logs and pre-upgrade backups.
      - ./data:/data
    # Hardening: the app only needs to write to /data.
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    # If Jellyfin and Seerr run in Compose on the same host, join their network to use
    # container names (e.g. http://jellyfin:8096) as server URLs.
    # networks:
    #   - media

# networks:
#   media:
#     external: true
```

Optionally add a `.env` file next to it. Every value has a default; copy
[.env.example](.env.example) for the full list (port, time zone, reverse proxy, encryption key, …).

### 2. Start the container

The container runs as uid/gid `1000`, so the data folder must be writable by that user:

```bash
mkdir -p data && sudo chown 1000:1000 data
docker compose up -d
docker compose logs jellywatcher | grep "setup code"
```

### 3. Finish in the browser

1. Open `http://<host>:8484`, enter the setup code, choose **Set Up with Jellyfin**, enter your
   Jellyfin server URL and sign in with a Jellyfin administrator account (password or Quick
   Connect). JellyWatcher creates its own Jellyfin API key; nothing to copy. A local administrator is
   available instead if you prefer.
2. Under **Integrations**, connect Seerr (URL + API key). TMDb and Trakt are optional.
3. Under **Watchlists › Add List**, paste a list link (IMDb or Trakt), connect Trakt, or upload
   Letterboxd / IMDb exports.

The full guide, including account linking, webhooks and all environment variables, is in
[docs/setup.md](docs/setup.md). For upgrades, backups and reverse proxies see
[docs/operations.md](docs/operations.md).

### Updating

```bash
docker compose pull && docker compose up -d
```

Database migrations run automatically on start, after a backup is written to `data/backups/`.

### Building from source

```bash
git clone https://github.com/TIGamingTV/JellyWatcher.git && cd JellyWatcher
# in compose.yaml, replace the `image:` line with `build: .`
docker compose up -d --build
```

## What each integration can and can't do

| Service | Method | Sync |
| --- | --- | --- |
| Trakt | Official API (admin registers one Trakt app). Public lists by link; sign-in for your own lists | Automatic |
| Letterboxd | Your export ZIP or CSV, plus your public RSS diary | Uploads: manual. RSS: automatic |
| IMDb | Public lists by link (IMDb's public list API), or the CSV from IMDb's Export button | Links: automatic. Uploads: manual |
| Seerr | REST API key, requests made as each linked user | Polling, plus an optional webhook |
| Jellyfin | REST API key (created during setup), Jellyfin sign-in with password or Quick Connect | Polling, plus an optional webhook |
| TMDb | Optional; Seerr's TMDb access is used otherwise | — |

Letterboxd doesn't offer an API for personal projects and its terms prohibit scraping, so
JellyWatcher imports only files you export yourself. Importing other people's Letterboxd lists is not
supported. IMDb public lists are read through the same public list API the IMDb website uses (no
scraping, no key); IMDb allows only personal, non-commercial use of that data. Trakt answers only
registered apps, so public Trakt links need the Trakt app an administrator sets up once, but no
Trakt account for the person adding the list.

Details, sources and verified limitations: [docs/integration-matrix.md](docs/integration-matrix.md).

## Documentation

| Document | Content |
| --- | --- |
| [Installation and setup](docs/setup.md) | Install, first run, connecting each service, environment variables, development. |
| [Operations](docs/operations.md) | Backup, restore, upgrades, reverse proxy, networking, troubleshooting. |
| [Architecture](docs/architecture.md) | Design decisions, data model, matching, sync safety, security model. |
| [Integration matrix](docs/integration-matrix.md) | Research results per service and what is explicitly unsupported. |

## Development

```bash
npm install
npm run dev      # API :8484 + UI :5173
npm test         # unit and end-to-end tests (mocked Jellyfin, Seerr, Trakt, IMDb)
npm run build
```

Releases: set `version` in `package.json`, then push a matching tag (`git tag v0.3.0 && git push
origin v0.3.0`). The [release workflow](.github/workflows/release.yml) tests, publishes the
multi-arch image to GHCR, and creates the GitHub release.

## Attribution

This product uses the TMDB API but is not endorsed or certified by TMDB. JellyWatcher uses Trakt but
is not endorsed or certified by Trakt. It is not affiliated with Jellyfin, Seerr, Letterboxd or IMDb.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
