import type { AppContext } from '../context.js';
import { nowIso } from '../db/index.js';
import { normalizeTitle } from '../domain/matching.js';
import { ProviderError } from '../http/errors.js';
import { normalizeItem, normalizeUserData, type JellyfinClient, type NormalizedJellyfinItem, type NormalizedUserData } from '../providers/jellyfin.js';
import { mapViewing, type ViewingState } from '../../shared/status.js';

/**
 * Indexes the Jellyfin movie/series library and the viewing state of every linked Jellyfin user.
 * Read-only towards Jellyfin. Removed items are only deleted after a complete, successful pass, so a
 * network failure halfway never makes the library look empty.
 */
export async function syncJellyfin(ctx: AppContext) {
  const client = ctx.integrations.jellyfin();
  if (!client) return { status: 'skipped' as const, stats: { reason: 'not configured' } };
  const db = ctx.db;
  const run = Date.now();
  const newlyAdded: number[] = [];
  let indexed = 0;

  try {
    const select = db.prepare('SELECT id, title_id, media_type, episode_count FROM jellyfin_items WHERE id = ?');
    const upsert = db.prepare(
      `INSERT INTO jellyfin_items (id, server_id, media_type, name, year, tmdb_id, imdb_id, tvdb_id, image_tag, date_created, episode_count, runtime_ticks, title_id, first_seen_at, last_seen_run, updated_at)
       VALUES (@id, @serverId, @mediaType, @name, @year, @tmdbId, @imdbId, @tvdbId, @imageTag, @dateCreated, @episodeCount, @runtimeTicks, @titleId, @now, @run, @now)
       ON CONFLICT(id) DO UPDATE SET server_id = excluded.server_id, media_type = excluded.media_type, name = excluded.name, year = excluded.year,
         tmdb_id = excluded.tmdb_id, imdb_id = excluded.imdb_id, tvdb_id = excluded.tvdb_id, image_tag = excluded.image_tag, date_created = excluded.date_created,
         episode_count = excluded.episode_count, runtime_ticks = excluded.runtime_ticks, title_id = excluded.title_id, last_seen_run = excluded.last_seen_run, updated_at = excluded.updated_at`,
    );

    for await (const page of client.libraryPages()) {
      const items = page.items.map(normalizeItem).filter((i): i is NormalizedJellyfinItem => i !== null);
      db.transaction(() => {
        for (const item of items) {
          const existing = select.get(item.id) as { id: string; title_id: number | null } | undefined;
          const titleId = linkTitle(ctx, item);
          upsert.run({ ...item, titleId, now: nowIso(), run });
          if (!existing) newlyAdded.push(titleId);
          indexed++;
        }
      })();
    }
    const removed = db.prepare('DELETE FROM jellyfin_items WHERE last_seen_run IS NOT ? ').run(run).changes;

    // Per-user viewing state.
    const users = db.prepare('SELECT DISTINCT jellyfin_user_id AS id FROM users WHERE jellyfin_user_id IS NOT NULL AND disabled = 0').all() as { id: string }[];
    let userErrors = 0;
    const upsertUd = db.prepare(
      `INSERT INTO jellyfin_user_data (item_id, jellyfin_user_id, played, play_count, played_percentage, unplayed_count, position_ticks, runtime_ticks, last_played_at, is_favorite, synced_at)
       VALUES (@itemId, @userId, @played, @playCount, @playedPercentage, @unplayedCount, @positionTicks, @runtimeTicks, @lastPlayedAt, @isFavorite, @now)
       ON CONFLICT(item_id, jellyfin_user_id) DO UPDATE SET played = excluded.played, play_count = excluded.play_count, played_percentage = excluded.played_percentage,
         unplayed_count = excluded.unplayed_count, position_ticks = excluded.position_ticks, runtime_ticks = excluded.runtime_ticks, last_played_at = excluded.last_played_at,
         is_favorite = excluded.is_favorite, synced_at = excluded.synced_at`,
    );
    let episodeSeries = 0;
    for (const u of users) {
      const startedAt = nowIso();
      try {
        const seen = new Map<number, ViewingSnapshot>();
        for await (const page of client.libraryPages(u.id)) {
          const rows = page.items.map(normalizeUserData).filter((r) => r !== null);
          db.transaction(() => {
            const now = nowIso();
            for (const r of rows) {
              const item = select.get(r.itemId) as JfItemRow | undefined;
              if (!item) continue;
              upsertUd.run({ ...r, played: r.played ? 1 : 0, isFavorite: r.isFavorite ? 1 : 0, userId: u.id, now });
              if (item.title_id !== null) seen.set(item.title_id, bestSnapshot(seen.get(item.title_id), snapshot(r, item)));
            }
          })();
        }
        db.prepare('DELETE FROM jellyfin_user_data WHERE jellyfin_user_id = ? AND synced_at < ?').run(u.id, startedAt);
        recordHistory(ctx, u.id, seen);
        episodeSeries += await syncEpisodes(ctx, client, u.id);
      } catch (err) {
        userErrors++;
        ctx.log.warn({ err: (err as Error).message }, 'jellyfin user sync failed');
        if (err instanceof ProviderError && err.kind === 'auth') throw err;
      }
    }

    announceNewAvailability(ctx, newlyAdded);
    const info = await client.systemInfo().catch(() => null);
    ctx.integrations.markOk('jellyfin', info ? { serverName: info.ServerName, version: info.Version, serverId: info.Id } : undefined);
    return { status: userErrors > 0 ? ('partial' as const) : ('ok' as const), stats: { indexed, removed, newItems: newlyAdded.length, users: users.length, userErrors, episodeSeries } };
  } catch (err) {
    ctx.integrations.markError('jellyfin', err);
    throw err;
  }
}

interface JfItemRow {
  id: string;
  title_id: number | null;
  media_type: 'movie' | 'tv';
  episode_count: number | null;
}

interface ViewingSnapshot {
  state: ViewingState;
  percent: number | null;
  playedEpisodes: number | null;
  totalEpisodes: number | null;
  lastPlayedAt: string | null;
}

const RANK: Record<ViewingState, number> = { watched: 3, in_progress: 2, unwatched: 1, unavailable: 0 };

function snapshot(r: NormalizedUserData, item: JfItemRow): ViewingSnapshot {
  const total = item.episode_count ?? r.episodeCount;
  const state = mapViewing(item.media_type, { played: r.played, playedPercentage: r.playedPercentage, positionTicks: r.positionTicks, unplayedCount: r.unplayedCount, episodeCount: total });
  const tv = item.media_type === 'tv';
  return {
    state,
    percent: state === 'watched' ? 100 : r.playedPercentage !== null ? Math.round(r.playedPercentage) : null,
    playedEpisodes: tv && total !== null && r.unplayedCount !== null ? Math.max(0, total - r.unplayedCount) : null,
    totalEpisodes: tv ? total : null,
    lastPlayedAt: r.lastPlayedAt,
  };
}

function bestSnapshot(a: ViewingSnapshot | undefined, b: ViewingSnapshot): ViewingSnapshot {
  if (!a) return b;
  return RANK[b.state] > RANK[a.state] || (RANK[b.state] === RANK[a.state] && (b.percent ?? 0) > (a.percent ?? 0)) ? b : a;
}

const localUsers = (ctx: AppContext, jellyfinUserId: string) =>
  (ctx.db.prepare('SELECT id FROM users WHERE jellyfin_user_id = ?').all(jellyfinUserId) as { id: number }[]).map((r) => r.id);

/**
 * Remembers what each person watched. Rows are only written for titles that are in the library right
 * now and are never removed when a title leaves the library, so deleting a watched title in Seerr,
 * Sonarr or Radarr keeps it marked as watched.
 */
function recordHistory(ctx: AppContext, jellyfinUserId: string, seen: Map<number, ViewingSnapshot>): void {
  const locals = localUsers(ctx, jellyfinUserId);
  if (locals.length === 0 || seen.size === 0) return;
  const upsert = ctx.db.prepare(
    `INSERT INTO watch_history (user_id, title_id, state, percent, played_episodes, total_episodes, last_played_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, title_id) DO UPDATE SET state = excluded.state, percent = excluded.percent, played_episodes = excluded.played_episodes,
       total_episodes = excluded.total_episodes, last_played_at = COALESCE(excluded.last_played_at, last_played_at), updated_at = excluded.updated_at`,
  );
  const clear = ctx.db.prepare('DELETE FROM watch_history WHERE user_id = ? AND title_id = ?');
  const now = nowIso();
  ctx.db.transaction(() => {
    for (const [titleId, s] of seen) {
      for (const userId of locals) {
        // Live data wins while the title is in the library, including marking it unwatched again.
        if (s.state === 'watched' || s.state === 'in_progress') upsert.run(userId, titleId, s.state, s.percent, s.playedEpisodes, s.totalEpisodes, s.lastPlayedAt, now);
        else clear.run(userId, titleId);
      }
    }
  })();
}

const EPISODE_SERIES_PER_RUN = 300;

/**
 * Reads episodes of series that appear on someone's list, for season/episode entries and watch time.
 * A series is re-read only when its series-level user data changed since the last read.
 */
async function syncEpisodes(ctx: AppContext, client: JellyfinClient, jellyfinUserId: string): Promise<number> {
  const db = ctx.db;
  const series = db
    .prepare(
      `SELECT ji.id, ji.title_id, ji.episode_count, ud.played, ud.unplayed_count, ud.last_played_at, ud.episodes_sig,
              (SELECT COUNT(*) FROM jellyfin_episodes je WHERE je.series_id = ji.id) AS known
         FROM jellyfin_items ji JOIN jellyfin_user_data ud ON ud.item_id = ji.id AND ud.jellyfin_user_id = ?
        WHERE ji.media_type = 'tv' AND ji.title_id IN (SELECT title_id FROM list_items WHERE title_id IS NOT NULL)`,
    )
    .all(jellyfinUserId) as {
    id: string;
    title_id: number;
    episode_count: number | null;
    played: number;
    unplayed_count: number | null;
    last_played_at: string | null;
    episodes_sig: string | null;
    known: number;
  }[];
  const locals = localUsers(ctx, jellyfinUserId);
  const replaceEp = db.prepare('INSERT OR REPLACE INTO jellyfin_episodes (id, series_id, season, episode, runtime_ticks, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  const markWatched = db.prepare(
    `INSERT INTO watched_episodes (user_id, title_id, season, episode, played_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, title_id, season, episode) DO UPDATE SET played_at = COALESCE(excluded.played_at, played_at)`,
  );
  const unmark = db.prepare('DELETE FROM watched_episodes WHERE user_id = ? AND title_id = ? AND season = ? AND episode = ?');
  const setSig = db.prepare('UPDATE jellyfin_user_data SET episodes_sig = ? WHERE item_id = ? AND jellyfin_user_id = ?');
  let read = 0;
  for (const s of series) {
    const sig = `${s.played}|${s.unplayed_count ?? ''}|${s.episode_count ?? ''}|${s.last_played_at ?? ''}`;
    if (sig === s.episodes_sig && s.known > 0) continue;
    if (read >= EPISODE_SERIES_PER_RUN) break;
    read++;
    let episodes;
    try {
      episodes = await client.episodes(s.id, jellyfinUserId);
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'auth') throw err;
      ctx.log.debug({ err: (err as Error).message, series: s.id }, 'jellyfin episodes failed');
      continue;
    }
    db.transaction(() => {
      const now = nowIso();
      db.prepare('DELETE FROM jellyfin_episodes WHERE series_id = ?').run(s.id);
      for (const e of episodes) {
        const parts = e.episodeEnd - e.episode + 1;
        for (let n = e.episode; n <= e.episodeEnd; n++) {
          // A multi-episode file counts once per episode it contains.
          replaceEp.run(n === e.episode ? e.id : `${e.id}#${n}`, s.id, e.season, n, e.runtimeTicks !== null ? Math.round(e.runtimeTicks / parts) : null, now);
          for (const userId of locals) {
            if (e.played) markWatched.run(userId, s.title_id, e.season, n, e.lastPlayedAt);
            else unmark.run(userId, s.title_id, e.season, n);
          }
        }
      }
      setSig.run(sig, s.id, jellyfinUserId);
    })();
  }
  return read;
}

/** Finds the canonical title for a Jellyfin item, by provider ids first, then exact title + year. */
function linkTitle(ctx: AppContext, item: NormalizedJellyfinItem): number {
  if (item.tmdbId || item.imdbId || item.tvdbId) {
    return ctx.titles.ensure({
      mediaType: item.mediaType,
      tmdbId: item.tmdbId,
      imdbId: item.imdbId,
      tvdbId: item.tvdbId,
      title: item.name,
      year: item.year,
      overview: item.overview,
      genres: item.genres,
      source: 'jellyfin',
    });
  }
  const norm = normalizeTitle(item.name);
  const candidates = ctx.db
    .prepare('SELECT id, title, year FROM titles WHERE media_type = ? AND (year IS ? OR year IS NULL OR ? IS NULL) AND title = ? COLLATE NOCASE LIMIT 5')
    .all(item.mediaType, item.year, item.year, item.name) as { id: number; title: string; year: number | null }[];
  const hit = candidates.find((c) => normalizeTitle(c.title) === norm);
  if (hit) return hit.id;
  return ctx.titles.ensure({ mediaType: item.mediaType, title: item.name, year: item.year, overview: item.overview, genres: item.genres, source: 'jellyfin' });
}

function announceNewAvailability(ctx: AppContext, titleIds: number[]): void {
  if (titleIds.length === 0 || titleIds.length > 500) return; // first full index: don't flood the feed
  const firstIndex = !ctx.integrations.get('jellyfin').lastOkAt;
  if (firstIndex) return;
  for (const titleId of new Set(titleIds)) {
    const users = ctx.db
      .prepare(
        `SELECT DISTINCT l.user_id FROM list_items li JOIN lists l ON l.id = li.list_id WHERE li.title_id = ?
         UNION SELECT user_id FROM requests WHERE title_id = ? AND user_id IS NOT NULL`,
      )
      .all(titleId, titleId) as { user_id: number }[];
    const t = ctx.titles.get(titleId);
    if (!t) continue;
    for (const u of users) ctx.activity.addOnce(u.user_id, 'now_available', `${t.title} is now in your Jellyfin library.`, titleId);
  }
}
