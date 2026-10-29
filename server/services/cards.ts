import type { AppContext } from '../context.js';
import { parseJson } from '../db/index.js';
import type { SessionUser } from '../security/auth.js';
import type { TitleStatus, UserContext } from './status.js';
import type { TitleRow } from './titles.js';

/** Compact title representation shared by grids, shelves and timelines. */

const POSTER_SIZE = 'w342';

export function posterUrl(t: { poster_path: string | null }, jf?: { id: string; image_tag: string | null } | null): string | null {
  if (t.poster_path && /^\/[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$/i.test(t.poster_path)) return `/api/images/tmdb/${POSTER_SIZE}${t.poster_path}`;
  if (jf?.image_tag) return `/api/images/jellyfin/${jf.id}?tag=${encodeURIComponent(jf.image_tag)}`;
  return null;
}

export function userCtx(u: SessionUser): UserContext {
  return { id: u.id, jellyfinUserId: u.jellyfinUserId, seerrUserId: u.seerrUserId };
}

export type CardRow = TitleRow & { jf_id?: string | null; jf_tag?: string | null };

export function card(t: CardRow, s: TitleStatus | undefined) {
  return {
    id: t.id,
    mediaType: t.media_type,
    tmdbId: t.tmdb_id,
    title: t.title,
    year: t.year,
    posterUrl: posterUrl(t, t.jf_id ? { id: t.jf_id, image_tag: t.jf_tag ?? null } : null),
    genres: parseJson<string[]>(t.genres, []),
    stage: s?.stage ?? 'unknown',
    availability: s?.availability.state ?? 'unknown',
    request: s?.request.state ?? 'unknown',
    viewing: s?.viewing.state ?? 'unavailable',
    progress: s?.viewing.progress?.percent ?? null,
    stale: Boolean(s && (s.availability.stale || s.request.stale)),
  };
}
export type Card = ReturnType<typeof card>;

export const JF_JOIN = `LEFT JOIN (SELECT title_id, MIN(id) AS jf_id, MAX(image_tag) AS jf_tag FROM jellyfin_items GROUP BY title_id) jf ON jf.title_id = t.id`;

/** Title rows (with a Jellyfin poster fallback) for the given ids, in no particular order. */
export function cardRows(ctx: AppContext, ids: number[]): CardRow[] {
  const out: CardRow[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    out.push(...(ctx.db.prepare(`SELECT t.*, jf.jf_id, jf.jf_tag FROM titles t ${JF_JOIN} WHERE t.id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as CardRow[]));
  }
  return out;
}

/** Cards in the order of `ids`. */
export function cardsFor(ctx: AppContext, u: SessionUser, ids: number[]): Card[] {
  if (ids.length === 0) return [];
  const statuses = ctx.status.forTitles(userCtx(u), ids);
  const byId = new Map(cardRows(ctx, ids).map((r) => [r.id, r]));
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is CardRow => Boolean(r))
    .map((r) => card(r, statuses.get(r.id)));
}
