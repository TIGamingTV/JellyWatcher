# Janitor

The Janitor cleans up what people asked for once they have watched it. Someone requests a movie or a
show in Seerr, Sonarr or Radarr downloads it, they watch it, and the Janitor then deletes the files
in Sonarr or Radarr and the request in Seerr. You decide how: who has to have watched it, how long
to wait, whether you get a warning in Home Assistant, and whether you approve each deletion.

It runs inside the JellyWatcher container. It is **off** unless you turn it on.

## Turn it on

Set one environment variable and restart the container:

```yaml
    environment:
      JW_JANITOR: "true"
```

Then, as an administrator:

1. **Integrations:** connect **Sonarr** and/or **Radarr** (URL and API key from Settings › General ›
   Security). Optionally connect **Home Assistant**: its URL, a long-lived access token (your profile
   › Security) and the notify service that reaches you, e.g. `mobile_app_pixel_8` (Developer Tools ›
   Actions lists them as `notify.…`). **Send a test notification** checks it.
2. Set `JW_PUBLIC_URL` so a tapped notification opens the Janitor page.
3. Open **Janitor › Rules** and add a rule from a template. Templates start **turned off** and in
   **dry run**.
4. Turn the rule on and press **Preview** to see what it would pick up now, then **Run Now** in the
   Overview. Dry runs log everything they *would* delete (Janitor › Log) and send their notifications
   with a “[Dry run]” prefix.
5. When the log looks right, switch the rule to **Ask first** (you approve every deletion) or
   **Automatic**.

Without `JW_JANITOR`, the Janitor's page, API routes, job and the Sonarr, Radarr and Home Assistant
integrations do not exist. Turning it off later stops everything; its rules and log stay in the
database for when you turn it back on.

## What it considers

Only **titles requested through Seerr** (approved or completed requests). Anything you added to Sonarr
or Radarr yourself, or that is only in Jellyfin, is never touched. The one addition: seasons the
[next-season option](#next-season) added to a request count as requested by it.

Each request belongs to the **first turned-on rule that matches it**, from the top of the Rules page.

Titles deleted outside the Janitor are left out: a request deleted in Seerr no longer counts (each
Seerr sync checks every request), and a movie or show gone from both Jellyfin and Radarr/Sonarr has
nothing left to clean up, so the preview does not list it.

A rule handles one of:

| Handles | Unit | Ready when |
| --- | --- | --- |
| Movies | the movie | it is in Jellyfin and everyone needed watched it |
| Shows, season by season | each requested season | the season is complete (Sonarr: nothing more to air, every aired monitored episode downloaded) and everyone needed watched every episode of it that is in Jellyfin |
| Whole shows | the show | every season is complete and everyone needed watched every episode in Jellyfin |

**Watched** means played to the end in Jellyfin (by the linked Jellyfin account), marked as watched
in JellyWatcher, or marked **Not Watching**. Only people with a JellyWatcher account and a linked
Jellyfin account are known; someone who watches in Jellyfin without a JellyWatcher account is
invisible to the Janitor.

### Which requests

- **Requested by:** only requests by the people you pick (none: anyone).
- **4K requests:** both, regular only or 4K only.
- **Show status in Sonarr:** any, ended or continuing (shows only).

### Who has to watch it

| Setting | Meaning |
| --- | --- |
| Requester: *Must have watched it* | Everyone who requested it must have finished it. Requested by someone without a JellyWatcher account: it waits forever (their viewing is unknown). |
| Requester: *Counts like everyone else* | The requester is judged with the others below. |
| Also wait for: *Nobody else* | Only the requester matters. |
| *People who started watching it* | Anyone who played or marked any of the show (or the movie). |
| *People with it on a watchlist* | Anyone with the title on one of their JellyWatcher lists. |
| *Started it or have it on a watchlist* | Both of the above. |
| *Everyone with a linked Jellyfin account* | Every active person. |
| *All of them* / *At least N* | Every one of them must finish, or at least N of them (N larger than the group means all of them). With the requester ignored and *Everyone*, *At least 1* means “anyone watched it”. |
| *Stop waiting for people inactive for N days* | Someone who has not played anything of the title for N days (counted from their last play, or from when the requester finished) stops holding it back. Does not apply to the requester. |

### Next season

Rules that handle shows season by season can follow the requester through the show. Seerr requests
usually list only the first season; without this, the Janitor only knows about that season, so the
season they moved on to is never cleaned up and the request (and the show) may go while they are
still watching.

With **Monitor the next season** on (default in the *Watched seasons* template), once a requester has
at most **N episodes of a season left** (default 3; episodes not downloaded yet count as left,
episodes marked *Not Watching* do not, and they must have watched at least one):

1. Sonarr monitors the next season and, unless turned off, searches for it right away (otherwise it
   only grabs new releases). A season that is already monitored is left as it is.
2. That season is added to **their** request in JellyWatcher (Seerr's request stays as it is). From
   then on it is a season they requested: it gets its own cleanup once watched, and *no episode
   files are left* is not true until the Janitor deleted it, so the show and the request stay until
   then.

The next season is always the one after the **last** season of their request, so a season they
already watched and deleted is never monitored again, nor one the show is already past (a later
season is in Jellyfin or monitored).

**Catching up:** a requester who moved on by hand (e.g. requested season 1, monitored and deleted
seasons in Sonarr themselves and is now on season 4) is caught up on the next run: every season after
their request that is in Jellyfin or monitored in Sonarr joins their request, once they watched
anything after the requested seasons or those seasons are gone from Jellyfin and Sonarr. This only
changes JellyWatcher's bookkeeping (Sonarr is not touched), so it happens in dry run too. Seasons a
request has moved past and that are gone from Jellyfin are no longer listed in the preview.

It happens once per season and is logged (*Monitor the next season*). It is not a deletion: it runs in
*Ask first* and *Automatic* mode without approval and outside the deletion window, and stops while
the Janitor is paused. Dry runs log it once and change nothing. Only requesters with a JellyWatcher
account count, and only requests that list seasons (a request for the whole show already covers
every season). A title's page lists the seasons added to its requests.

## Steps

A rule's steps run from the top. Each cleanup remembers where it is, so a restart continues at the
same step.

| Step | What it does |
| --- | --- |
| **Wait** | Days and hours. The first wait counts from when the last person needed finished watching (their last play or mark); later ones from the step before. Switching a rule from dry run to Ask first or Automatic therefore does not restart the clock. |
| **Notify in Home Assistant** | Sends your message. Placeholders: `{title}` (with the season), `{show}`, `{date}` of the next deletion (the waits until it, added up), `{requester}`, `{size}`, `{rule}`. |
| **Wait for approval** | Stops until you approve it in the Overview. |
| **Continue only if…** | *the show has ended in Sonarr*, or *no episode files are left* (specials aside; every season the next-season option added to a request already deleted by the Janitor; and no season monitored in Sonarr with aired episodes still to download, unless the Janitor deleted it). Otherwise *stop here*, or *check again daily*. |
| **Delete season in Sonarr** | Optionally unmonitors the season first (so Sonarr does not download it again), then deletes the season's episode files. |
| **Delete show in Sonarr** | Removes the show with all its files; optionally adds an import list exclusion. |
| **Delete movie in Radarr** | Removes the movie with its files; optionally adds an import exclusion. |
| **Delete the request in Seerr** | Deletes the request(s) the cleanup is about. Seerr updates the title's availability on its next scan. |
| **Remove the title from Seerr** | Clears the title in Seerr (status and every request), so it can be requested again right away. |

### Templates

- **Watched movies:** wait 7 days → notify → wait 3 days → delete movie in Radarr → delete the request.
- **Watched seasons:** monitors the next season at 3 episodes left; wait 7 days → notify → wait 3 days → delete the season in Sonarr (unmonitored)
  → continue only if the show has ended (else check daily) → continue only if no files are left
  (else stop) → delete the show in Sonarr → delete the request. A continuing show keeps its request,
  so new seasons still arrive; once the show ends and the last season is gone, the show and the
  request go too.
- **Finished shows:** ended shows only: wait 14 days → notify → wait 3 days → delete the show →
  delete the request.

## Modes and safety

| Mode | Behaviour |
| --- | --- |
| **Dry run** | Every step runs, but deletions are only logged as “Would do”. Notifications say “[Dry run]”. Switching a rule to dry run also stops real deletions of its cleanups already under way. |
| **Ask first** | Stops before the first deletion of each cleanup until you approve it (Overview › Approve). With a *Notify* step before the deletion, that warning also asks for the approval (“Approve or keep it in JellyWatcher.”) and you can approve right away, so it is deleted on the date it names; otherwise you get an *approval needed* notification when it waits. Either way, one message per cleanup. |
| **Automatic** | Deletes when the steps allow. |

Further safety nets:

- **Keep:** in the Overview, a rule preview or a title's page, *Keep* excludes a title (or one season)
  for every rule or one rule, forever or for 30, 90 or 365 days (Janitor › Kept). Its cleanups stop
  at once, also those that already deleted something; one that is running stops before its next
  deletion. Deletions that already happened stay done. Keeping one season also protects the whole
  show: steps that delete the show (or the movie, or the title in Seerr) do not run.
- **Pause:** the switch in the Overview stops every step. Rules are still checked so you can see what
  is coming up.
- **Deletion window:** deletions only run between two times of day (server time zone, `TZ`). Waits,
  notifications and approvals happen any time.
- **Deletions per run:** at most this many real deletions per run (default 5); the rest follow on the
  next run.
- **Fresh data only:** deletions wait while the last Jellyfin sync failed or is older than three sync
  intervals (at least an hour).
- **Matching ids:** Sonarr and Radarr items are found by TVDB / TMDb id and must agree with the title.
- **Still eligible:** each run checks the rule again. If someone new starts watching, or a request
  changes, a cleanup that has not deleted anything yet is dropped (and starts over when it is ready
  again).
- **Saving a rule** drops its cleanups that have not deleted anything (dry-run results included);
  they start over on the next run with their timers still counted from when people finished. Cleanups
  that already deleted something keep their place if the steps before it are unchanged; otherwise
  they start over from the first step (what they deleted counts as already gone).
- **Failures** are retried after 15, 30, 60, 120 minutes; after 5 failed attempts the cleanup stops
  (Overview › Problems › Retry) and you get a notification. “Already gone” (404) counts as done.

Every step, dry run or not, is written to **Janitor › Log** (kept for a year).

## How a run works

The `janitor` job runs on its interval (default 60 minutes, Janitor › Settings), after every Jellyfin
sync, when you save or turn on a rule, and with **Run Now** (also in Settings › Sync).

1. Read every Sonarr series and Radarr movie once (only for the kinds of rules that are on).
2. For each rule, top to bottom: build its units from Seerr requests, skip titles an earlier rule
   matched, kept titles, titles not in Jellyfin and incomplete seasons, then check who has watched
   them. Ready units get a cleanup; cleanups that are no longer ready are dropped unless they already
   deleted something (kept ones are dropped either way).
3. Unless paused, monitor next seasons for requesters close to the end of one, then run every cleanup that is due: its steps until a wait, an approval, a gate that
   says stop or wait, the end, or a failure. Each cleanup and its rule are read again just before it
   runs, so a Keep, an approval, a rule change or Pause made during a run counts for the rest of it.
4. After real deletions, sync Seerr and Jellyfin.

With the Janitor on, JellyWatcher also reads the episodes of requested shows from Jellyfin (not only
those on someone's list), so season rules know which episodes each person watched.

## Notifications

With Home Assistant connected you get:

- your rules' **Notify** steps (warnings before a deletion),
- **approval needed** (Settings: *Notify when a deletion needs approval*), unless a *Notify* step of that
  cleanup already asked for the approval,
- **cleaned up**, with the space freed (*Notify when something was deleted*),
- **deletion failed** after the last retry (*Notify when a deletion keeps failing*).

A notification that cannot be sent never stops a cleanup; the log says why.

## Limits

- One Sonarr and one Radarr. 4K requests are only told apart for matching; deletions go to the one
  instance connected.
- Season units use the episodes Jellyfin has. Specials (season 0) are never cleaned up on their own
  and are ignored by *no episode files are left*; deleting the whole show removes them too.
- The Janitor cannot see viewing on other servers or by people without a JellyWatcher account.
