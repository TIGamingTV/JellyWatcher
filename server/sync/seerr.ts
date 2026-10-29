import type { AppContext } from '../context.js';
import { nowIso } from '../db/index.js';
import { mapSeerrRequest, REQUEST_STATE_LABEL, type RequestState } from '../../shared/status.js';
import type { SeerrMediaInfo, SeerrRequestJson } from '../providers/seerr.js';

/**
 * Mirrors Seerr's media table and recent requests. Seerr is the source of truth for request state;
 * nothing is written back except new requests created through the request workflow.
 */
export async function syncSeerr(ctx: AppContext) {
  const client = ctx.integrations.seerr();
  if (!client) return { status: 'skipped' as const, stats: { reason: 'not configured' } };
  try {
    const startedAt = nowIso();
    const media = await client.media();
    const upsertMedia = ctx.db.prepare(
      `INSERT INTO seerr_media (media_type, tmdb_id, seerr_media_id, status, status4k, seasons, jellyfin_item_id, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(media_type, tmdb_id) DO UPDATE SET seerr_media_id = excluded.seerr_media_id, status = excluded.status, status4k = excluded.status4k,
         seasons = excluded.seasons, jellyfin_item_id = excluded.jellyfin_item_id, synced_at = excluded.synced_at`,
    );
    ctx.db.transaction((rows: SeerrMediaInfo[]) => {
      for (const m of rows) {
        if (!m.tmdbId || (m.mediaType !== 'movie' && m.mediaType !== 'tv')) continue;
        upsertMedia.run(m.mediaType, m.tmdbId, m.id ?? null, m.status ?? null, m.status4k ?? null, JSON.stringify(m.seasons ?? []), m.jellyfinMediaId ?? null, startedAt);
      }
    })(media);
    // A complete pass succeeded: anything not seen is no longer tracked by Seerr.
    ctx.db.prepare('DELETE FROM seerr_media WHERE synced_at < ?').run(startedAt);

    const linked = await syncSeerrUsers(ctx).catch((err) => {
      ctx.log.warn({ err: (err as Error).message }, 'seerr user sync failed');
      return 0;
    });

    const requests = await client.requests();
    const seen = new Set<number>();
    let changed = 0;
    for (const r of requests) {
      seen.add(r.id);
      if (upsertRequest(ctx, r, 'seerr')) changed++;
    }

    // Requests we created that fell out of the recent window: check them individually.
    const orphans = ctx.db
      .prepare('SELECT seerr_request_id AS id FROM requests WHERE seerr_request_id IS NOT NULL AND request_status IN (1, 2) ORDER BY updated_at DESC LIMIT 100')
      .all() as { id: number }[];
    let missing = 0;
    for (const o of orphans) {
      if (seen.has(o.id)) continue;
      const r = await client.request(o.id);
      if (r) upsertRequest(ctx, r, 'seerr');
      else {
        missing++;
        ctx.db.prepare("UPDATE requests SET request_status = NULL, media_status = NULL, last_error = 'This request no longer exists in Seerr.', synced_at = ? WHERE seerr_request_id = ?").run(nowIso(), o.id);
      }
    }
    ctx.integrations.markOk('seerr');
    return { status: 'ok' as const, stats: { media: media.length, requests: requests.length, changed, missing, linked } };
  } catch (err) {
    ctx.integrations.markError('seerr', err);
    throw err;
  }
}

const normId = (id: string | null | undefined) => (id ? id.replace(/-/g, '').toLowerCase() : null);

/**
 * Refreshes cached Seerr permissions for linked users and auto-links accounts whose Jellyfin user id
 * matches a Seerr user's Jellyfin user id (an exact, verifiable match). Returns new links made.
 */
export async function syncSeerrUsers(ctx: AppContext): Promise<number> {
  const client = ctx.integrations.seerr();
  if (!client) return 0;
  const seerrUsers = await client.users();
  const byId = new Map(seerrUsers.map((u) => [u.id, u]));
  const byJf = new Map(seerrUsers.filter((u) => u.jellyfinUserId).map((u) => [normId(u.jellyfinUserId), u]));
  const users = ctx.db.prepare('SELECT id, jellyfin_user_id, seerr_user_id FROM users').all() as { id: number; jellyfin_user_id: string | null; seerr_user_id: number | null }[];
  let linked = 0;
  const update = ctx.db.prepare('UPDATE users SET seerr_user_id = ?, seerr_username = ?, seerr_permissions = ?, updated_at = ? WHERE id = ?');
  // A Seerr user is linked to one account at most (requests are credited by Seerr user).
  const taken = new Set(users.map((u) => u.seerr_user_id).filter((id): id is number => id !== null));
  for (const u of users) {
    let s = u.seerr_user_id !== null ? byId.get(u.seerr_user_id) : undefined;
    if (!s && u.seerr_user_id === null && u.jellyfin_user_id) {
      const candidate = byJf.get(normId(u.jellyfin_user_id));
      if (candidate && !taken.has(candidate.id)) {
        s = candidate;
        taken.add(candidate.id);
        linked++;
      }
    }
    if (s) update.run(s.id, s.displayName ?? s.jellyfinUsername ?? s.username ?? null, s.permissions ?? null, nowIso(), u.id);
  }
  return linked;
}

const NOTIFY: Partial<Record<RequestState, ['request_approved' | 'request_declined' | 'request_failed' | 'request_available', string]>> = {
  approved: ['request_approved', 'was approved'],
  processing: ['request_approved', 'is being processed'],
  declined: ['request_declined', 'was declined'],
  failed: ['request_failed', 'failed in Seerr'],
  available: ['request_available', 'is now available'],
  partially_available: ['request_available', 'is partially available'],
};

/** Inserts or updates a request row from Seerr. Returns true if its state changed. */
export function upsertRequest(ctx: AppContext, r: SeerrRequestJson, origin: 'seerr' | 'jellywatcher', localUserId?: number): boolean {
  const media = r.media;
  if (!media?.tmdbId || (media.mediaType !== 'movie' && media.mediaType !== 'tv')) return false;
  const mediaType = media.mediaType;
  const titleId = ctx.titles.ensure({ mediaType, tmdbId: media.tmdbId, tvdbId: media.tvdbId, imdbId: media.imdbId, title: `TMDb ${media.tmdbId}`, source: 'seerr' });
  const seerrUserId = r.requestedBy?.id ?? null;
  const userId =
    localUserId ??
    ((seerrUserId !== null ? ctx.db.prepare('SELECT id FROM users WHERE seerr_user_id = ? ORDER BY id LIMIT 1').get(seerrUserId) : undefined) as { id: number } | undefined)?.id ??
    null;
  const requestedBy = r.requestedBy?.displayName ?? r.requestedBy?.jellyfinUsername ?? r.requestedBy?.username ?? null;
  const mediaStatus = r.is4k ? (media.status4k ?? null) : (media.status ?? null);
  const now = nowIso();

  const existing = ctx.db.prepare('SELECT id, request_status, media_status, user_id FROM requests WHERE seerr_request_id = ?').get(r.id) as
    | { id: number; request_status: number | null; media_status: number | null; user_id: number | null }
    | undefined;
  const newState = mapSeerrRequest(r.status, mediaStatus);
  if (existing) {
    const oldState = mapSeerrRequest(existing.request_status, existing.media_status);
    ctx.db
      .prepare(
        'UPDATE requests SET title_id = ?, user_id = COALESCE(user_id, ?), seerr_user_id = ?, requested_by = ?, request_status = ?, media_status = ?, is4k = ?, seasons = ?, last_error = NULL, updated_at = ?, synced_at = ? WHERE id = ?',
      )
      .run(titleId, userId, seerrUserId, requestedBy, r.status, mediaStatus, r.is4k ? 1 : 0, JSON.stringify((r.seasons ?? []).map((s) => s.seasonNumber)), r.updatedAt ?? now, now, existing.id);
    if (oldState !== newState) {
      const owner = existing.user_id ?? userId;
      const note = NOTIFY[newState];
      const t = ctx.titles.get(titleId);
      if (owner && note && t) ctx.activity.add(owner, note[0], `${displayTitle(t.title, mediaType, media.tmdbId)} ${note[1]}.`, titleId);
      return true;
    }
    return false;
  }
  ctx.db
    .prepare(
      `INSERT INTO requests (user_id, title_id, seerr_request_id, seerr_user_id, requested_by, request_status, media_status, is4k, seasons, origin, created_at, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(userId, titleId, r.id, seerrUserId, requestedBy, r.status, mediaStatus, r.is4k ? 1 : 0, JSON.stringify((r.seasons ?? []).map((s) => s.seasonNumber)), origin, r.createdAt ?? now, r.updatedAt ?? now, now);
  return true;
}

function displayTitle(title: string, mediaType: string, tmdbId: number): string {
  return title.startsWith('TMDb ') ? `${mediaType === 'tv' ? 'A show' : 'A movie'} (TMDb ${tmdbId})` : title;
}

export { REQUEST_STATE_LABEL };
