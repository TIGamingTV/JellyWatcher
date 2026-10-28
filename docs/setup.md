# Installation and setup

## 1. Run the container

Requirements: Docker with Compose v2.24 or newer, and about 150 MB of disk space plus the image cache.

```bash
git clone https://github.com/TIGamingTV/JellyWatcher.git
cd JellyWatcher
cp .env.example .env          # optional; every value has a sensible default
mkdir -p data && sudo chown 1000:1000 data
docker compose up -d --build
```

Without Compose:

```bash
docker build -t jellywatcher .
docker run -d --name jellywatcher --restart unless-stopped --init \
  -p 8484:8484 -v "$PWD/data:/data" \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
  jellywatcher
```

The container runs as uid/gid **1000**, so the mounted `data` folder must be writable by that user.
If it isn't, the container exits with a message explaining the `chown` to run.

## 2. Create the administrator

1. Get the one-time setup code:
   ```bash
   docker compose logs jellywatcher | grep "setup code"
   ```
   If you set `JW_SETUP_TOKEN` in `.env`, use that value instead.
2. Open `http://<host>:8484` and enter the code, a username and a password of at least 10 characters.

Only someone who can read the container log can claim the admin account. This protects a fresh
install on a shared network.

## 3. Connect services (Integrations)

All connections are configured in the UI. URLs are the address **the JellyWatcher container** uses to
reach the service:

- a container name on a shared Docker network, e.g. `http://jellyfin:8096`
- a LAN address, e.g. `http://192.168.1.10:8096`
- a public URL

Each service also has an optional **Browser URL** for links you click.

| Service | What you need | Where to get it |
| --- | --- | --- |
| **Jellyfin** (recommended) | Server URL + API key | Jellyfin › Dashboard › API Keys › **+** |
| **Seerr** (for requests) | Server URL (without `/api/v1`) + API key | Seerr › Settings › General › API Key |
| **TMDb** (optional) | API Read Access Token | themoviedb.org › Settings › API. Without it, Seerr's TMDb access is used. |
| **Trakt** (optional) | Client ID + Client Secret | Create an app at trakt.tv/oauth/applications/new. The Redirect URI can be `urn:ietf:wg:oauth:2.0:oob`; device sign-in doesn't use it. |

Each page has **Save and Test** (saves the values and verifies them) and **Test Without Saving**.
Secrets are write-only: after saving, the field shows "saved", and leaving it empty keeps the
stored value.

### Link people's accounts

- **Jellyfin:** each person opens Integrations › Jellyfin and signs in once with their Jellyfin
  credentials. This proves the account is theirs. Only the user id is stored. Administrators can also
  assign accounts in Settings › Users.
- **Seerr:**
  - Accounts link automatically when a Seerr user has the same Jellyfin user id (Settings › Users ›
    *Match Seerr Users*). Otherwise choose the Seerr user manually.
  - Requests are sent *as* that Seerr user, so Seerr's own permissions, quotas and approval rules apply.
- **Sign in with Jellyfin (optional):** in Settings › Users, enable *Allow Jellyfin sign-in*. Optionally
  also enable *Create accounts automatically*.

### Add more people

Settings › Users › **Add Person** creates either a local account with a password, or a Jellyfin-backed
account that signs in with Jellyfin.

## 4. Add watchlists

Watchlists › Lists › **Add List**:

- **Trakt:**
  1. Connect your account in Integrations › Trakt by entering a code at trakt.tv/activate.
  2. Add your Watchlist, your own lists and the lists you liked.
  3. Any **public list** can be added by pasting its link (franchises, filmographies, community lists) or found under *Public Lists*.
- **Letterboxd:**
  - Upload the export ZIP (letterboxd.com › Settings › Data › Export Your Data) or a single list CSV.
  - Optionally add your username for the RSS diary.
- **IMDb:** upload the CSV from the Export icon on your Watchlist or a list.

Entries without IDs are matched in the background. Anything uncertain appears under
**Watchlists › Needs Review**.

## 5. Optional: instant updates via webhooks

Without webhooks, JellyWatcher polls on the schedule in Settings › Sync. Defaults:

| Data | Interval |
| --- | --- |
| Seerr | 10 min |
| Jellyfin | 30 min |
| Lists | 6 h |

**Seerr:**
1. In Seerr, open Settings › Notifications › Webhook.
2. Set the Webhook URL to `http(s)://<jellywatcher>/api/webhooks/seerr`.
3. Set Authorization Header to the `Bearer …` value shown in JellyWatcher › Integrations › Seerr.
4. Enable the request notification types.

**Jellyfin:**
1. Install the official *Webhook* plugin.
2. Add a Generic destination with URL `…/api/webhooks/jellyfin`.
3. Add a header `Authorization: Bearer …` and enable *Item Added*.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `JW_PORT` | `8484` | Port inside the container. |
| `JW_HOST_PORT` | `8484` | Published port (Compose only). |
| `JW_DATA_DIR` | `/data` | Database, key, cache, logs, backups. |
| `JW_PUBLIC_URL` | — | Public origin, e.g. `https://watch.example.com`. Used for cross-site checks behind proxies. |
| `JW_TRUST_PROXY` | `false` | Trust `X-Forwarded-*` from a reverse proxy. |
| `JW_COOKIE_SECURE` | `auto` | `auto`, `true` or `false`. |
| `JW_SECRET_KEY` | — | 64 hex characters (`openssl rand -hex 32`). If unset, `/data/secret.key` is generated. |
| `JW_SETUP_TOKEN` | — | Fixed first-run setup code instead of the logged one. |
| `JW_SESSION_TTL_DAYS` | `30` | Sliding session lifetime. |
| `JW_LOG_LEVEL` | `info` | `trace` … `error`. |
| `JW_LOG_FILE` | `true` | Also log to `/data/logs/jellywatcher.log`, rotated at 10 MB on start. |
| `JW_DISABLE_SCHEDULER` | `false` | Turn off background sync (debugging). |
| `TZ` | `UTC` | Time zone for logs. |

## Development

```bash
npm install
npm run dev        # API on :8484 (data in ./.data) + Vite on :5173 with proxy
npm test           # unit + end-to-end tests against mocked Jellyfin/Seerr/Trakt
npm run typecheck
npx tsx tests/helpers/serve-mocks.ts   # fake Jellyfin :18096 / Seerr :15055 for manual UI testing
```

The mock services are for development only. Their data is never shown as live information.
