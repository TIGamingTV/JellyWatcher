import type { AppContext } from '../context.js';
import { nowIso } from '../db/index.js';
import { normalizeTitle } from '../domain/matching.js';
import { ProviderError } from '../http/errors.js';
import { normalizeItem, normalizeUserData, type NormalizedJellyfinItem } from '../providers/jellyfin.js';

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
    const select = db.prepare('SELECT id, title_id FROM jellyfin_items WHERE id = ?');
    const upsert = db.prepare(
      `INSERT INTO jellyfin_items (id, server_id, media_type, name, year, tmdb_id, imdb_id, tvdb_id, image_tag, date_created, episode_count, title_id, first_seen_at, last_seen_run, updated_at)
       VALUES (@id, @serverId, @mediaType, @name, @year, @tmdbId, @imdbId, @tvdbId, @imageTag, @dateCreated, @episodeCount, @titleId, @now, @run, @now)
       ON CONFLICT(id) DO UPDATE SET server_id = excluded.server_id, media_type = excluded.media_type, name = excluded.name, year = excluded.year,
         tmdb_id = excluded.tmdb_id, imdb_id = excluded.imdb_id, tvdb_id = excluded.tvdb_id, image_tag = excluded.image_tag, date_created = excluded.date_created,
         episode_count = excluded.episode_count, title_id = excluded.title_id, last_seen_run = excluded.last_seen_run, updated_at = excluded.updated_at`,
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
    for (const u of users) {
      const startedAt = nowIso();
      try {
        for await (const page of client.libraryPages(u.id)) {
          const rows = page.items.map(normalizeUserData).filter((r) => r !== null);
          db.transaction(() => {
            const now = nowIso();
            for (const r of rows) {
              if (!select.get(r.itemId)) continue;
              upsertUd.run({ ...r, played: r.played ? 1 : 0, isFavorite: r.isFavorite ? 1 : 0, userId: u.id, now });
            }
          })();
        }
        db.prepare('DELETE FROM jellyfin_user_data WHERE jellyfin_user_id = ? AND synced_at < ?').run(u.id, startedAt);
      } catch (err) {
        userErrors++;
        ctx.log.warn({ err: (err as Error).message }, 'jellyfin user sync failed');
        if (err instanceof ProviderError && err.kind === 'auth') throw err;
      }
    }

    announceNewAvailability(ctx, newlyAdded);
    const info = await client.systemInfo().catch(() => null);
    ctx.integrations.markOk('jellyfin', info ? { serverName: info.ServerName, version: info.Version, serverId: info.Id } : undefined);
    return { status: userErrors > 0 ? ('partial' as const) : ('ok' as const), stats: { indexed, removed, newItems: newlyAdded.length, users: users.length, userErrors } };
  } catch (err) {
    ctx.integrations.markError('jellyfin', err);
    throw err;
  }
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
