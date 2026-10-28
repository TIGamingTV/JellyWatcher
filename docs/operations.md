# Operations: backup, upgrade, reverse proxy, troubleshooting

## What lives in `/data`

| Path | Content | Back up? |
| --- | --- | --- |
| `jellywatcher.db` (+ `-wal`, `-shm`) | All application data | **Yes** |
| `secret.key` | Encryption key for stored credentials (absent if you use `JW_SECRET_KEY`) | **Yes, keep it private** |
| `backups/` | Automatic pre-migration copies and downloaded backups | Optional |
| `cache/images/` | Poster cache (re-downloadable) | No |
| `logs/` | Log files | No |

**Without the key, the database is still usable, but every stored credential must be re-entered.**
These are the API keys and the Trakt sign-ins.

## Backup

Pick one of these:

- **From the UI:** Settings › System › *Download a database backup*. This is a consistent online copy.
  Store it together with `secret.key` (or your `JW_SECRET_KEY`).
- **Cold copy:** run `docker compose stop`, copy the whole `data/` folder, then run `docker compose start`.
- **Hot copy from the host:**
  ```bash
  docker exec jellywatcher node -e "require('better-sqlite3')('/data/jellywatcher.db').backup('/data/backups/manual.db').then(()=>console.log('ok'))"
  ```

## Restore

```bash
docker compose stop
cp jellywatcher-YYYY-…db data/jellywatcher.db
rm -f data/jellywatcher.db-wal data/jellywatcher.db-shm
cp secret.key data/secret.key && chmod 600 data/secret.key   # or set the same JW_SECRET_KEY
sudo chown -R 1000:1000 data
docker compose start
```

## Upgrade

```bash
docker compose pull && docker compose up -d   # published image (or change the pinned tag first)
git pull && docker compose up -d --build      # when building from source
```

On start, pending database migrations run automatically:

- **Before any change to an existing database**, a copy is written to
  `data/backups/pre-migration-<timestamp>.db`.
- Each migration runs in a transaction. A failure rolls back and the container exits, leaving the
  database untouched.

To roll back, start the previous version with that backup restored as described above.
Downgrading without restoring is not supported once a newer migration has been applied.

## Reverse proxy

Set `JW_TRUST_PROXY=true` and `JW_PUBLIC_URL=https://watch.example.com`, and serve over HTTPS. Then the
session cookie is marked `Secure` (with `JW_COOKIE_SECURE=auto`), and cross-site checks know the public
origin. Enable HSTS at the proxy.

Caddy:
```
watch.example.com {
  reverse_proxy jellywatcher:8484
}
```

nginx:
```nginx
location / {
  proxy_pass http://jellywatcher:8484;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Forwarded-Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  client_max_body_size 30m;   # export uploads
}
```

Serving under a sub-path (e.g. `/watch/`) is not supported; use a sub-domain.

If you expose JellyWatcher to the internet, keep the admin password strong. Consider putting it behind
your SSO or VPN. Leave *Create accounts automatically* off unless every Jellyfin user should get access.

## Networking

JellyWatcher reaches Jellyfin, Seerr, TMDb (`api.themoviedb.org`, `image.tmdb.org`), Trakt
(`api.trakt.tv`, `auth.trakt.tv`) and Letterboxd (`letterboxd.com`, RSS only). No inbound ports are
needed except the web port, plus the webhooks if you use them.

| Where the services run | Server URL to use |
| --- | --- |
| Same Compose project or a shared network | Container names, e.g. `http://jellyfin:8096` |
| Same host, different networks | The host's LAN IP. `host.docker.internal` works only if you add `extra_hosts: ["host.docker.internal:host-gateway"]`. |
| Another machine | Its LAN address or public URL |

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Container exits: "cannot write to its data directory" | `sudo chown -R 1000:1000 ./data` |
| Setup screen rejects the code | Use the code from the **latest** start (`docker compose logs jellywatcher \| grep "setup code"`), or set `JW_SETUP_TOKEN`. |
| "The server could not be reached" when testing a service | The URL must work *from inside the container*. `localhost` there means the JellyWatcher container itself. Use a container name or LAN IP. |
| Jellyfin: "rejected the API key" | Create a key under Dashboard › API Keys. On Jellyfin 12, legacy `X-Emby-Token` or `api_key` auth is disabled; JellyWatcher already uses the supported header. |
| Seerr: requests fail mentioning CSRF | Disable *CSRF Protection* in Seerr › Settings › Network. It blocks API-key POSTs. |
| Seerr: "not allowed to make this request" | The linked Seerr user lacks the Request permission, hit a quota, or the title is blocklisted. Check the user in Seerr. |
| "Your account is not linked to a Seerr user" | Settings › Users › choose the Seerr user, or *Match Seerr Users*. |
| Trakt: "sign-in expired" | Refresh tokens are single use and can be invalidated by Trakt. Reconnect in Integrations › Trakt. |
| Trakt app stopped working | Trakt deletes apps unused for 30 days. Create a new one and paste the new Client ID. |
| Letterboxd RSS: "refused the RSS request" | Letterboxd challenged the request. It is retried on the next sync. Uploads are unaffected. |
| Titles stuck in "Needs Review" | Expected for exports without IDs when the title is ambiguous. Pick the right match once; it's remembered. If matching never starts, connect TMDb or Seerr. |
| Status shows "Possibly outdated" | The last sync of that service failed or is overdue. Check Settings › Sync › History for the error. |
| Stored credentials disappeared after moving the data | `secret.key` or `JW_SECRET_KEY` changed. Restore the original key or re-enter the credentials. |

Logs: `docker compose logs -f jellywatcher` (JSON). Set `JW_LOG_LEVEL=debug` for more detail.
Credentials and tokens are redacted.
