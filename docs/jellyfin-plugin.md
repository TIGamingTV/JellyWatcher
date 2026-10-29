# Jellyfin plugin

The optional JellyWatcher plugin adds a **Watchlists** page to Jellyfin's menu, so people can follow
their lists without leaving Jellyfin. The JellyWatcher web app stays as it is; the plugin is a
smaller view of the parts used most:

- **Your lists** with progress, time left and sync status, and **Sync** for lists that sync.
- **Add a list** by pasting a link (IMDb, Trakt, Letterboxd, TMDb, MyAnimeList, AniList, MDBList),
  starting your own list, or adding your Trakt watchlist when Trakt is connected.
- **Timeline** of a list with Up Next, and on every entry:
  - **Play** opens the movie, show or episode in Jellyfin when it is in the library.
  - **Request** asks Seerr live what can be requested, with season picking for shows.
  - **Not Watching** skips the entry (with Undo), so Up Next moves on.
  - **Watched** marks it watched (or unmarks it).
- **Show in Jellyfin** keeps a list in Jellyfin as a collection or a private playlist, in the list's
  order (see [below](#collections-and-playlists)).

Everything else, such as uploads, connecting Trakt, reviewing matches and settings, is linked to
the JellyWatcher web app.

## Requirements

- Jellyfin **12.x**.
- The [File Transformation](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation)
  plugin. Jellyfin has no official way for plugins to add pages for people, so the plugin uses File
  Transformation to add its script to Jellyfin's web app while it is served. Nothing on disk changes.
- JellyWatcher **0.5.0** or newer, reachable from the Jellyfin server (**0.7.0** for collections and
  playlists).

## Install

1. In JellyWatcher, open **Integrations › Jellyfin › Jellyfin Plugin (Optional)** and select **Turn On**.
   This creates the plugin key.
2. In Jellyfin, open **Dashboard › Plugins › Repositories** and add both repositories:
   - JellyWatcher: `https://raw.githubusercontent.com/TIGamingTV/JellyWatcher/main/jellyfin-plugin/manifest.json`
   - File Transformation: `https://www.iamparadox.dev/jellyfin/plugins/manifest.json`
3. Install **File Transformation** and **JellyWatcher** from the catalog and restart Jellyfin.
4. Open **Dashboard › Plugins › JellyWatcher** and enter:
   - **JellyWatcher address**: how the *Jellyfin server* reaches JellyWatcher, for example
     `http://jellywatcher:8484` on a shared Docker network. Include a base path if you use one.
   - **Plugin key**: from step 1.
   - Optionally a **browser address** for "Open in JellyWatcher" links (only needed when
     JellyWatcher has no `JW_PUBLIC_URL`), a menu name and a [Material icon](https://fonts.google.com/icons).
5. Select **Test Connection**, then **Save**, and reload Jellyfin in the browser.

People now find **Watchlists** in Jellyfin's menu (the top bar on large screens, the side menu on
phones). The page is at `#/jellywatcher` and supports the browser's Back button.

Manual install: download `jellywatcher_<version>.zip` from the
[release](https://github.com/TIGamingTV/JellyWatcher/releases), unpack it into a folder in Jellyfin's
`plugins` directory and restart Jellyfin.

The plugin version follows JellyWatcher with a fourth part: JellyWatcher 0.6.0 ↔ plugin 0.6.0.0.
Keep both on the same version.

## Collections and playlists

Any list can be kept in Jellyfin itself, so it shows up in every Jellyfin app, including TV apps and
Infuse. Choose **Show in Jellyfin** on the list, in the JellyWatcher web app or on the Watchlists page:

| Choice | In Jellyfin | Who sees it | Shows and seasons |
| --- | --- | --- | --- |
| **Off** | Nothing | | |
| **Collection** | A collection named after the list, in the list's order | Everyone who can see the titles in it | One tile per show or season |
| **Private Playlist** | A playlist owned by your Jellyfin account, in the list's order | Only you | Added as their episodes (season by season, without specials) |

- It holds every matched entry that is in the library, in your order (your own order when you
  reordered the list, the source's order otherwise). Entries marked **Not Watching** are left out.
  Watched state comes from Jellyfin as usual.
- It updates on its own: every few minutes (Dashboard › Plugins › JellyWatcher › **Update every**),
  right away when you change the setting on the Watchlists page, and about a minute after a library
  scan adds or removes titles (Jellyfin drops removed items from collections and playlists; they are
  added back when the title returns). The list page shows how many items it holds and how many
  entries are not in the library.
- Renaming the list renames the collection or playlist. Switching between collection and playlist
  replaces it. **Turning it off, or deleting the list, deletes the collection or playlist** (only
  the one the plugin made; titles and files are never touched).
- Collections keep their order through Jellyfin's "Default" display order. Apps that sort on their
  own still can: Jellyfin's web app groups a collection's items by type (movies, shows, episodes),
  and Infuse sorts a collection pinned to its home screen by release date (open it from
  Library › Collections to keep the order). Playlists always keep their order.

Settings in **Dashboard › Plugins › JellyWatcher › Collections and playlists**:

- **Keep chosen lists in Jellyfin**: when off, nothing is changed in Jellyfin and people see why on
  their lists.
- **Who may show lists as collections**: administrators and people with Jellyfin's *Allow collection
  management* permission (default), everyone, or nobody (private playlists only). Collections are
  shared, so this keeps people from creating them for everyone.
- **Update Now** and **Turn Off and Remove All** (deletes every collection and playlist the plugin
  made, for example before uninstalling it). The task **JellyWatcher: Sync collections and playlists**
  in Dashboard › Scheduled Tasks runs an update too.

How the plugin knows what is its own: each collection and playlist it creates carries the provider id
`JellyWatcher = <JellyWatcher instance id>:<list id>`, and the plugin also lists them in
`plugins/configurations/JellyWatcher.mirrors.json`. It only changes or deletes those, only after a
complete answer from JellyWatcher, and never those of another JellyWatcher instance. A JellyWatcher
outage or a wrong key changes nothing.

## Who can use it

People use the page with their Jellyfin account. JellyWatcher applies the same rules as signing in
with Jellyfin:

- A Jellyfin user linked to a JellyWatcher account (by signing in with Jellyfin, linking in
  Integrations, or an administrator import) sees that account's lists.
- Unknown Jellyfin users get a JellyWatcher account automatically only when **Settings › Users ›
  Let everyone on the Jellyfin server sign in** is on; otherwise the page asks them to contact an
  administrator.
- Disabled accounts are refused.

## How it works

```
Jellyfin web ── client.js (added to index.html by File Transformation; Preact)
   │  /JellyWatcher/api/...  with the person's normal Jellyfin session
   ▼
Plugin (inside Jellyfin) ── Jellyfin has authenticated the person; only allowed calls pass
   │  X-JW-Plugin-Key: <key>   X-JW-Jellyfin-User: <user id>
   ▼
JellyWatcher /api/...  ── key checked, account found by Jellyfin user id, route allowlist
```

- The browser only talks to Jellyfin. No JellyWatcher cookie is set, no CORS or framing is needed,
  and the person's Jellyfin token is never sent to JellyWatcher.
- TMDb posters come through `/JellyWatcher/img/tmdb/…` (public artwork, cached by JellyWatcher);
  library posters come from Jellyfin itself.
- The menu entry is added to Jellyfin's `config.json` `menuLinks`, next to any links you have there.

## Security

- **The plugin key lets the plugin act for any linked person.** It is stored encrypted in
  JellyWatcher and in Jellyfin's plugin configuration, which only Jellyfin administrators can read.
  Treat it like a password. **Regenerate** replaces it at once; **Turn Off** disables plugin access.
- Requests with the key can only reach the routes the page needs: lists and timelines, adding lists
  by link, local lists or the Trakt watchlist, list sync, the Show in Jellyfin setting, request
  eligibility and requests, Not Watching and Watched, TMDb artwork, and (plugin only, not the page)
  the lists to show in Jellyfin and the plugin's report about them. Everything else, including all administration, answers 403,
  even for administrators. The plugin checks the same list before anything leaves Jellyfin.
- Requests from the plugin skip the browser CSRF check because they carry no cookie; the key is a
  server-side secret. Rate limits count per person instead of per IP.
- When JellyWatcher rejects the key, the plugin answers 503 instead of 401, so Jellyfin's web app
  does not sign the person out.
- The artwork route needs no Jellyfin sign-in (`<img>` tags send no token), so JellyWatcher only
  serves posters of titles it already knows through it: no open image proxy, no filling its cache.
  Only JPEG, PNG, WebP, GIF and AVIF pass, with `nosniff`; API answers are passed on only as JSON.
- **Connection test:** the saved key is only sent to the saved address. To test a new address,
  enter the key again.
- **Which address to enter:** one Jellyfin's *server* reaches, ideally a Docker network name
  (`http://jellywatcher:8484`) or a Tailscale address. Plain `http://` is fine there; across the
  internet use `https://`, since the key travels with every request. Whether people open Jellyfin
  over HTTPS or HTTP does not matter: the browser only ever talks to Jellyfin.

## Limits

- Only Jellyfin's web app and the apps that show it (Jellyfin Android, iOS and Desktop) get the
  page. TV apps and other clients (Swiftfin, Findroid, Infuse, …) don't, but they do show lists kept
  in Jellyfin as collections or playlists.
- On phones, Jellyfin shows its full top bar on pages it doesn't know instead of the menu button.
- The page depends on File Transformation and on a few parts of jellyfin-web's page structure
  (kept in `jellyfin-plugin/client/jf-dom.ts`); a jellyfin-web update may need a plugin update.

## Development

```bash
npm run typecheck                 # includes the plugin page (jellyfin-plugin/client)
dotnet test jellyfin-plugin       # builds the page with esbuild, then the plugin, then its tests
npm run build:plugin              # dist/plugin/jellywatcher_<version>.zip
```

On a tag, the release workflow attaches the zip to the GitHub release and adds the version to
`jellyfin-plugin/manifest.json` on `main` (`node scripts/plugin.mjs manifest`).
