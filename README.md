# JellyWatcher

A self-hosted hub for your movie and TV watchlists. JellyWatcher combines lists from **Trakt**,
**Letterboxd** and **IMDb** into one catalog without duplicates. It shows what's already in
**Jellyfin**, what you've watched, and what's been requested, and lets you request the rest through
**Seerr** one title at a time.

Runs as one Docker container with one data volume. Everything is configured in the web UI.

## Features

- **Watchlists:**
  - Trakt watchlist, your own lists, liked lists, and any public list by link or search (franchises, filmographies, community lists).
  - Letterboxd and IMDb exports.
  - Letterboxd RSS diary.
  - Each list syncs on its own.
- **One catalog:** deduplicated by TMDb and IMDb ids, with fuzzy title and year matching and a review
  queue for uncertain matches. Your match decisions are remembered.
- **Search and filters:** title, type, source, genre, library state, request state, watched state, and sorting.
- **Requests via Seerr:**
  - A live eligibility check prevents duplicates.
  - For shows, you choose which seasons to request.
  - Requests are made as your linked Seerr user, so its permissions, quotas and approvals apply.
  - Clear messages for every outcome.
- **Lifecycle tracking:** On Watchlist → Requested → Processing → In Library → Watched. Each status
  comes from its authoritative service (Seerr for requests, Jellyfin for library and progress) and
  shows when it was synced. Out-of-date data is marked as such.
- **Library and Continue Watching** from Jellyfin, for your linked account.
- **Multi-user:**
  - Local or Jellyfin sign-in.
  - Private per-user lists and connections.
  - Admin-managed account links.
- **Homelab-friendly:**
  - SQLite with automatic pre-upgrade backups and one-click backup download.
  - Health check, non-root read-only container, encrypted credentials, optional webhooks.
- **Apple-inspired interface:** system type, light and dark appearance, responsive from phone to
  desktop, keyboard and screen-reader friendly.

## Quick start

```bash
cp .env.example .env
mkdir -p data && sudo chown 1000:1000 data
docker compose up -d --build
docker compose logs jellywatcher | grep "setup code"
```

Open `http://<host>:8484`, enter the setup code, and create the administrator. Then connect Jellyfin
and Seerr under **Integrations**.

## What each integration can and can't do

| Service | Method | Sync |
| --- | --- | --- |
| Trakt | Official API, device sign-in (admin registers one Trakt app) | Automatic |
| Letterboxd | Your export ZIP or CSV, plus your public RSS diary | Uploads: manual. RSS: automatic |
| IMDb | The CSV from IMDb's Export button | Manual (re-upload) |
| Seerr | REST API key, requests made as each linked user | Polling, plus an optional webhook |
| Jellyfin | REST API key, plus per-user account linking | Polling, plus an optional webhook |
| TMDb | Optional; Seerr's TMDb access is used otherwise | — |

Letterboxd and IMDb don't offer an API for personal projects, and their terms prohibit scraping. So
JellyWatcher imports only files you export yourself and never fetches their sites. Importing other
people's Letterboxd lists is not supported.

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
npm test         # 77 unit and end-to-end tests (mocked Jellyfin, Seerr, Trakt)
npm run build
```

## Attribution

This product uses the TMDB API but is not endorsed or certified by TMDB. JellyWatcher uses Trakt but
is not endorsed or certified by Trakt. It is not affiliated with Jellyfin, Seerr, Letterboxd or IMDb.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
