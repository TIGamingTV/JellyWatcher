import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import type { AppContext } from '../context.js';
import { ApiError } from '../http/errors.js';
import { IdParam, parse } from '../http/validate.js';
import { requireUser, type SessionUser } from '../security/auth.js';
import { posterUrl, userCtx } from '../services/cards.js';
import { LOCAL_PROVIDER } from '../services/lists.js';
import type { TitleStatus } from '../services/status.js';
import type { TitleRow } from '../services/titles.js';
import { epKey, manualDateFor, parseWatchedAt, seasonSizes } from '../services/watched.js';

export interface EpisodeWatch {
  episode: number;
  watched: boolean;
  source: 'manual' | 'jellyfin' | null;
  watchedAt: string | null;
  inLibrary: boolean;
}

export interface SeasonWatch {
  season: number;
  /** Episodes in the season; null when unknown. */
  episodes: number | null;
  watched: number;
  /** Date of a manual mark covering the whole season (or the whole show). */
  manualAt: string | null;
  list: EpisodeWatch[];
}

/**
 * Watch state of a title broken down by season and episode, combining what Jellyfin reported with
 * the person's own marks. Drives the "Mark as Watched" controls on the title page.
 */
export function watchDetail(ctx: AppContext, u: SessionUser, t: TitleRow, status: TitleStatus) {
  const marks = ctx.watches.marks(u.id, t.id);
  const watched = status.viewing.state === 'watched';
  const base = {
    manualAt: marks.title,
    watchedAt: watched ? (marks.title ?? status.viewing.progress?.lastPlayedAt ?? null) : null,
    seasons: [] as SeasonWatch[],
  };
  if (t.media_type !== 'tv') return base;

  const sizes = seasonSizes(t.seasons);
  const jf = new Map(
    (ctx.db.prepare('SELECT season, episode, played_at FROM watched_episodes WHERE user_id = ? AND title_id = ?').all(u.id, t.id) as { season: number; episode: number; played_at: string | null }[]).map(
      (r) => [epKey(r.season, r.episode), r.played_at],
    ),
  );
  const present = new Set(
    (ctx.db.prepare('SELECT je.season, je.episode FROM jellyfin_episodes je JOIN jellyfin_items ji ON ji.id = je.series_id WHERE ji.title_id = ?').all(t.id) as { season: number; episode: number }[]).map((r) =>
      epKey(r.season, r.episode),
    ),
  );
  // A whole show reported watched by Jellyfin counts every episode, even ones never read one by one.
  const jfAll = watched && status.viewing.source === 'Jellyfin';

  const known = new Map<number, number>();
  for (const k of [...jf.keys(), ...present, ...marks.episodes.keys()]) {
    const [s, e] = k.split(':').map(Number) as [number, number];
    known.set(s, Math.max(known.get(s) ?? 0, e));
  }
  const seasons = new Set<number>([...sizes.keys(), ...[...known.keys()].filter((s) => s > 0 || [...present].some((k) => k.startsWith(`${s}:`))), ...marks.seasons.keys()]);
  base.seasons = [...seasons]
    .sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b))
    .map((s) => {
      const n = sizes.get(s) ?? (known.get(s) || null);
      const list: EpisodeWatch[] = [];
      for (let e = 1; e <= (n ?? 0); e++) {
        const k = epKey(s, e);
        const manualAt = manualDateFor(marks, s, e);
        const fromJf = jf.has(k) || jfAll;
        list.push({
          episode: e,
          watched: Boolean(manualAt) || fromJf,
          source: manualAt ? 'manual' : fromJf ? 'jellyfin' : null,
          watchedAt: manualAt ?? jf.get(k) ?? null,
          inLibrary: present.has(k),
        });
      }
      const seasonManual = marks.seasons.get(s) ?? marks.title;
      return { season: s, episodes: n, watched: seasonManual && !n ? 0 : list.filter((x) => x.watched).length, manualAt: seasonManual, list };
    });
  return base;
}

const Scope = z.object({
  watched: z.boolean(),
  season: z.number().int().min(0).max(500).nullable().optional(),
  episode: z.number().int().min(1).max(5000).nullable().optional(),
  /** Several episodes at once, e.g. "everything up to here". */
  episodes: z.array(z.object({ season: z.number().int().min(0).max(500), episode: z.number().int().min(1).max(5000) })).max(5000).optional(),
  /** ISO date (YYYY-MM-DD) or date-time; defaults to now. */
  watchedAt: z.string().max(40).nullable().optional(),
});

const DiscoverQuery = z.object({
  q: z.string().trim().max(100).optional(),
  kind: z.enum(['trending', 'movies', 'tv']).default('trending'),
  type: z.enum(['movie', 'tv']).optional(),
  page: z.coerce.number().int().min(1).max(500).default(1),
  listId: z.coerce.number().int().positive().optional(),
});

export async function watchRoutes(app: FastifyInstance, { ctx }: AppDeps) {
  app.put('/titles/:id/watched', { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }, async (req) => {
    const u = requireUser(req);
    const { id } = parse(IdParam, req.params);
    const body = parse(Scope, req.body);
    const t = ctx.titles.get(id);
    if (!t) throw new ApiError(404, 'not_found', 'Title not found.');
    if (body.watched) {
      const at = parseWatchedAt(body.watchedAt);
      if (body.episodes?.length) ctx.watches.markEpisodes(u.id, id, body.episodes, at);
      else ctx.watches.mark(u.id, id, { season: body.season, episode: body.episode }, at);
    } else if (body.episodes?.length) {
      for (const e of body.episodes) ctx.watches.unmark(u.id, id, e);
    } else ctx.watches.unmark(u.id, id, { season: body.season, episode: body.episode });
    const status = ctx.status.forTitles(userCtx(u), [id]).get(id)!;
    return { status, watch: watchDetail(ctx, u, ctx.titles.get(id)!, status) };
  });

  /** "Not Watching": skip a title, season or episode so Up Next moves on to the next entry. */
  app.put('/titles/:id/skipped', { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }, async (req) => {
    const u = requireUser(req);
    const { id } = parse(IdParam, req.params);
    const body = parse(
      z.object({
        skipped: z.boolean(),
        season: z.number().int().min(0).max(500).nullable().optional(),
        episode: z.number().int().min(1).max(5000).nullable().optional(),
      }),
      req.body,
    );
    if (!ctx.titles.get(id)) throw new ApiError(404, 'not_found', 'Title not found.');
    const scope = { season: body.season ?? null, episode: body.episode ?? null };
    if (body.skipped) ctx.watches.skip(u.id, id, scope);
    else ctx.watches.unskip(u.id, id, scope);
    return { ok: true, skipped: body.skipped };
  });

  // ---- Discover: find titles to add to a local list -----------------------------------------
  app.get('/discover', async (req) => {
    const u = requireUser(req);
    const q = parse(DiscoverQuery, req.query);
    const meta = ctx.metadata();
    if (!meta) throw new ApiError(400, 'no_metadata', 'Connect TMDb or Seerr in Integrations to discover titles.');
    if (q.listId && !ctx.lists.getOwned(q.listId, u.id)) throw new ApiError(404, 'not_found', 'List not found.');
    const res = q.q ? await meta.searchAny(q.q, q.page) : await meta.discover(q.kind, q.page);
    const results = q.type ? res.results.filter((r) => r.mediaType === q.type) : res.results;

    const keys = results.map((r) => `${r.mediaType}:${r.tmdbId}`);
    const local = new Map<string, { id: number; inLibrary: boolean }>();
    if (keys.length) {
      const rows = ctx.db
        .prepare(
          `SELECT t.id, t.media_type, t.tmdb_id, EXISTS (SELECT 1 FROM jellyfin_items ji WHERE ji.title_id = t.id) AS lib
             FROM titles t WHERE t.tmdb_id IS NOT NULL AND (t.media_type || ':' || t.tmdb_id) IN (SELECT value FROM json_each(?))`,
        )
        .all(JSON.stringify(keys)) as { id: number; media_type: string; tmdb_id: number; lib: number }[];
      for (const r of rows) local.set(`${r.media_type}:${r.tmdb_id}`, { id: r.id, inLibrary: r.lib === 1 });
    }
    const inList = new Set<string>();
    if (q.listId) {
      const rows = ctx.db
        .prepare('SELECT t.media_type, t.tmdb_id FROM list_items li JOIN titles t ON t.id = li.title_id WHERE li.list_id = ? AND li.season_number IS NULL AND t.tmdb_id IS NOT NULL')
        .all(q.listId) as { media_type: string; tmdb_id: number }[];
      for (const r of rows) inList.add(`${r.media_type}:${r.tmdb_id}`);
    }
    return {
      source: meta.name,
      page: q.page,
      totalPages: res.totalPages,
      results: results.map((r) => {
        const key = `${r.mediaType}:${r.tmdbId}`;
        return {
          tmdbId: r.tmdbId,
          mediaType: r.mediaType,
          title: r.title,
          year: r.year,
          overview: r.overview ?? null,
          posterPath: r.posterPath ?? null,
          posterUrl: posterUrl({ poster_path: r.posterPath ?? null }),
          titleId: local.get(key)?.id ?? null,
          inLibrary: local.get(key)?.inLibrary ?? false,
          inList: inList.has(key),
        };
      }),
    };
  });

  /** Seasons of a show, for adding one season or one episode to a list. */
  app.get('/discover/tv/:id', async (req) => {
    requireUser(req);
    const { id } = parse(IdParam, req.params);
    const meta = ctx.metadata();
    if (!meta) throw new ApiError(400, 'no_metadata', 'Connect TMDb or Seerr in Integrations to discover titles.');
    const d = await meta.details('tv', id);
    if (!d) throw new ApiError(404, 'not_found', 'Show not found.');
    return {
      tmdbId: d.tmdbId,
      title: d.title,
      year: d.year,
      seasons: (d.seasons ?? []).map((s) => ({ season: s.seasonNumber, name: s.name, episodes: s.episodeCount })),
    };
  });

  /** Local lists the title could be added to, with whether it is on them already. */
  app.get('/titles/:id/local-lists', async (req) => {
    const u = requireUser(req);
    const { id } = parse(IdParam, req.params);
    const rows = ctx.db
      .prepare(
        `SELECT l.id, l.name, EXISTS (SELECT 1 FROM list_items li WHERE li.list_id = l.id AND li.title_id = ? AND li.season_number IS NULL) AS has
           FROM lists l WHERE l.user_id = ? AND l.provider = ? ORDER BY l.name COLLATE NOCASE`,
      )
      .all(id, u.id, LOCAL_PROVIDER) as { id: number; name: string; has: number }[];
    return { lists: rows.map((r) => ({ id: r.id, name: r.name, contains: r.has === 1 })) };
  });
}
