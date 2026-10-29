import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import type { AppContext } from '../context.js';
import { parseJson } from '../db/index.js';
import { ApiError } from '../http/errors.js';
import { IdParam, parse } from '../http/validate.js';
import { requireUser, type SessionUser } from '../security/auth.js';
import { card, cardsFor, JF_JOIN, posterUrl, userCtx } from '../services/cards.js';
import { isTimeline } from '../services/lists.js';
import { checkEligibility, submitRequest, syncTitleFromSeerr } from '../services/requests.js';
import { buildTimelines } from '../services/timeline.js';
import type { TitleRow } from '../services/titles.js';
import { ensureTitleMetadata } from '../sync/metadata.js';
import { triggerJob } from '../sync/scheduler.js';
import { ACTIVE_REQUEST_STATES, mapSeerrRequest, type LifecycleStage } from '../../shared/status.js';

const CatalogQuery = z.object({
  listId: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(100).optional(),
  type: z.enum(['movie', 'tv']).optional(),
  provider: z.enum(['trakt', 'letterboxd', 'imdb']).optional(),
  genre: z.string().max(60).optional(),
  availability: z.enum(['in_library', 'not_in_library', 'unknown']).optional(),
  request: z.enum(['not_requested', 'active', 'available', 'declined', 'failed']).optional(),
  viewing: z.enum(['watched', 'in_progress', 'unwatched']).optional(),
  sort: z.enum(['added', 'title', 'year', 'position', 'status']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(3000).default(120),
});

const STAGE_ORDER: LifecycleStage[] = ['in_progress', 'in_library', 'reported_available', 'partially_available', 'processing', 'pending_approval', 'requested', 'listed', 'declined', 'failed', 'watched', 'unknown'];

export function catalog(ctx: AppContext, u: SessionUser, q: z.infer<typeof CatalogQuery>) {
  const where = ["l.user_id = ?", "li.match_status = 'matched'"];
  const args: unknown[] = [u.id];
  if (q.listId) {
    where.push('l.id = ?');
    args.push(q.listId);
  }
  if (q.provider) {
    where.push('l.provider = ?');
    args.push(q.provider);
  }
  if (q.type) {
    where.push('t.media_type = ?');
    args.push(q.type);
  }
  if (q.q) {
    where.push("(t.title LIKE ? ESCAPE '\\' OR t.original_title LIKE ? ESCAPE '\\' OR li.source_title LIKE ? ESCAPE '\\')");
    const like = `%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    args.push(like, like, like);
  }
  const rows = ctx.db
    .prepare(
      `SELECT t.*, jf.jf_id, jf.jf_tag, MIN(li.position) AS pos, MAX(COALESCE(li.listed_at, li.first_seen_at)) AS added,
              GROUP_CONCAT(DISTINCT l.id) AS list_ids
         FROM list_items li JOIN lists l ON l.id = li.list_id JOIN titles t ON t.id = li.title_id ${JF_JOIN}
        WHERE ${where.join(' AND ')}
        GROUP BY t.id`,
    )
    .all(...args) as (TitleRow & { jf_id: string | null; jf_tag: string | null; pos: number | null; added: string; list_ids: string })[];

  const statuses = ctx.status.forTitles(userCtx(u), rows.map((r) => r.id));
  const lists = new Map(ctx.lists.forUser(u.id).map((l) => [l.id, { id: l.id, name: l.name, provider: l.provider }]));

  const genreCounts = new Map<string, number>();
  for (const r of rows) for (const g of parseJson<string[]>(r.genres, [])) genreCounts.set(g, (genreCounts.get(g) ?? 0) + 1);

  let items = rows.filter((r) => {
    const s = statuses.get(r.id)!;
    if (q.genre && !parseJson<string[]>(r.genres, []).includes(q.genre)) return false;
    if (q.availability) {
      const a = s.availability.state === 'partially_in_library' ? 'in_library' : s.availability.state;
      if (a !== q.availability) return false;
    }
    if (q.request) {
      const rs = s.request.state;
      const bucket = ACTIVE_REQUEST_STATES.includes(rs) ? 'active' : rs === 'available' || rs === 'partially_available' ? 'available' : rs === 'blocklisted' ? 'declined' : rs;
      if (bucket !== q.request) return false;
    }
    if (q.viewing && s.viewing.state !== q.viewing) return false;
    return true;
  });

  const sort = q.sort ?? (q.listId ? 'position' : 'added');
  const dir = (q.order ?? (sort === 'title' || sort === 'position' ? 'asc' : 'desc')) === 'asc' ? 1 : -1;
  items.sort((a, b) => {
    let c = 0;
    if (sort === 'title') c = a.title.localeCompare(b.title, undefined, { sensitivity: 'base', ignorePunctuation: true });
    else if (sort === 'year') c = (a.year ?? 0) - (b.year ?? 0);
    else if (sort === 'position') c = (a.pos ?? 1e9) - (b.pos ?? 1e9);
    else if (sort === 'status') c = STAGE_ORDER.indexOf(statuses.get(a.id)!.stage) - STAGE_ORDER.indexOf(statuses.get(b.id)!.stage);
    else c = a.added.localeCompare(b.added);
    return c * dir || a.title.localeCompare(b.title);
  });

  const total = items.length;
  items = items.slice(q.offset, q.offset + q.limit);
  return {
    total,
    offset: q.offset,
    items: items.map((r) => ({
      ...card(r, statuses.get(r.id)),
      lists: r.list_ids
        .split(',')
        .map((id) => lists.get(Number(id)))
        .filter(Boolean),
    })),
    facets: {
      genres: [...genreCounts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    },
  };
}

const WATCH_STAGES = new Set<LifecycleStage>(['in_library', 'in_progress', 'watched']);
const WAITING_STAGES = new Set<LifecycleStage>(['processing', 'pending_approval', 'requested', 'reported_available', 'partially_available']);

/**
 * The next unwatched entry of every list, in list order: what to watch or request next. Lists with
 * progress come first, then timelines, then everything else. Diaries (already watched) are skipped.
 */
export function upNextFor(ctx: AppContext, u: SessionUser, limit = 16) {
  const lists = ctx.lists.forUser(u.id).filter((l) => l.kind !== 'diary');
  const timelines = buildTimelines(ctx, u, lists);
  const picks = lists
    .map((l, order) => ({ l, order, t: timelines.get(l.id)! }))
    .filter((x) => x.t.nextIndex !== null)
    .map((x) => ({ ...x, timeline: isTimeline(x.l), started: x.t.summary.watchedEntries > 0 }))
    .sort((a, b) => Number(b.started) - Number(a.started) || Number(b.timeline) - Number(a.timeline) || a.order - b.order);
  const seen = new Map<string, { lists: { id: number; name: string; provider: string }[] }>();
  const out = [];
  for (const p of picks) {
    const e = p.t.entries[p.t.nextIndex!]!;
    const key = `${e.title?.id}:${e.season ?? ''}:${e.episode ?? ''}`;
    const ref = { id: p.l.id, name: p.l.name, provider: p.l.provider };
    const dup = seen.get(key);
    if (dup) {
      dup.lists.push(ref);
      continue;
    }
    if (out.length >= limit) continue;
    const action = WATCH_STAGES.has(e.stage) ? 'watch' : WAITING_STAGES.has(e.stage) ? 'waiting' : 'request';
    const item = {
      list: ref,
      lists: [ref],
      timeline: p.timeline,
      position: e.position,
      of: p.t.entries.length,
      remainingMinutes: p.t.summary.remainingMinutes,
      action,
      entry: e,
    };
    seen.set(key, item);
    out.push(item);
  }
  return out;
}

export async function catalogRoutes(app: FastifyInstance, { ctx }: AppDeps) {
  app.get('/catalog', async (req) => {
    const u = requireUser(req);
    const q = parse(CatalogQuery, req.query);
    if (q.listId && !ctx.lists.getOwned(q.listId, u.id)) throw new ApiError(404, 'not_found', 'List not found.');
    return catalog(ctx, u, q);
  });

  // ---- Title detail ------------------------------------------------------------------------
  app.get('/titles/:id', async (req) => {
    const u = requireUser(req);
    const { id: rawId } = parse(IdParam, req.params);
    if (!ctx.titles.get(rawId)) throw new ApiError(404, 'not_found', 'Title not found.');
    const id = await ensureTitleMetadata(ctx, rawId);
    const t = ctx.titles.get(id)!;
    const status = ctx.status.forTitles(userCtx(u), [id]).get(id)!;
    const memberships = ctx.db
      .prepare(
        `SELECT l.id, l.name, l.provider, l.kind, li.source_url AS sourceUrl, li.rating, li.notes, li.listed_at AS listedAt, li.watched_at AS watchedAt, li.match_method AS matchMethod, li.id AS itemId
           FROM list_items li JOIN lists l ON l.id = li.list_id WHERE li.title_id = ? AND l.user_id = ? ORDER BY l.name`,
      )
      .all(id, u.id);
    const jf = ctx.db.prepare('SELECT id, server_id, image_tag, date_created FROM jellyfin_items WHERE title_id = ? ORDER BY date_created LIMIT 1').get(id) as
      | { id: string; server_id: string | null; image_tag: string | null; date_created: string | null }
      | undefined;
    const jfClient = ctx.integrations.jellyfin();
    const seerrBase = ctx.integrations.seerrPublicUrl();
    const requests = ctx.db
      .prepare('SELECT id, user_id AS userId, requested_by AS requestedBy, request_status AS requestStatus, media_status AS mediaStatus, is4k, seasons, created_at AS createdAt, synced_at AS syncedAt, last_error AS lastError FROM requests WHERE title_id = ? ORDER BY created_at DESC')
      .all(id) as Record<string, unknown>[];
    return {
      title: {
        id: t.id,
        mediaType: t.media_type,
        tmdbId: t.tmdb_id,
        imdbId: t.imdb_id,
        tvdbId: t.tvdb_id,
        title: t.title,
        originalTitle: t.original_title,
        year: t.year,
        releaseDate: t.release_date,
        overview: t.overview,
        genres: parseJson<string[]>(t.genres, []),
        runtime: t.runtime,
        posterUrl: posterUrl(t, jf ?? null),
        backdropUrl: t.backdrop_path && /^\/[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$/i.test(t.backdrop_path) ? `/api/images/tmdb/w1280${t.backdrop_path}` : null,
        metadataSource: t.metadata_source,
      },
      status,
      lists: memberships,
      requests: requests.map((r) => ({ ...r, mine: r.userId === u.id, seasons: parseJson(r.seasons as string, []) })),
      links: {
        jellyfin: jf && jfClient ? jfClient.webUrl(jf.id, jf.server_id, ctx.integrations.jellyfinPublicUrl()) : null,
        seerr: seerrBase && t.tmdb_id ? `${seerrBase}/${t.media_type === 'movie' ? 'movie' : 'tv'}/${t.tmdb_id}` : null,
        tmdb: t.tmdb_id ? `https://www.themoviedb.org/${t.media_type}/${t.tmdb_id}` : null,
        imdb: t.imdb_id ? `https://www.imdb.com/title/${t.imdb_id}/` : null,
      },
      jellyfin: jf ? { itemId: jf.id, addedAt: jf.date_created } : null,
    };
  });

  app.get('/titles/:id/eligibility', async (req) => {
    const u = requireUser(req);
    const { id } = parse(IdParam, req.params);
    const e = await checkEligibility(ctx, { id: u.id, seerrUserId: u.seerrUserId, seerrPermissions: u.seerrPermissions }, id);
    // Refresh our mirror with what Seerr just told us so the page and the badges agree.
    if (e.details) void syncTitleFromSeerr(ctx, id, e.details);
    const { details: _d, ...rest } = e;
    return rest;
  });

  app.post('/titles/:id/request', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const u = requireUser(req);
    const { id } = parse(IdParam, req.params);
    const body = parse(z.object({ seasons: z.union([z.literal('all'), z.array(z.number().int().min(0).max(500)).max(200)]).optional(), is4k: z.boolean().optional() }), req.body);
    const res = await submitRequest(ctx, { id: u.id, seerrUserId: u.seerrUserId, seerrPermissions: u.seerrPermissions }, id, body);
    return { ...res, status: ctx.status.forTitles(userCtx(u), [id]).get(id) };
  });

  // ---- Review queue (uncertain matches) ----------------------------------------------------
  app.get('/review', async (req) => {
    const u = requireUser(req);
    const rows = ctx.db
      .prepare(
        `SELECT li.id, li.source_title AS title, li.source_year AS year, li.media_type AS mediaType, li.source_url AS sourceUrl, li.match_status AS status,
                li.match_confidence AS confidence, li.match_candidates AS candidates, l.id AS listId, l.name AS listName, l.provider
           FROM list_items li JOIN lists l ON l.id = li.list_id
          WHERE l.user_id = ? AND li.match_status IN ('review', 'unmatched')
          ORDER BY li.match_status = 'review' DESC, li.source_title COLLATE NOCASE LIMIT 500`,
      )
      .all(u.id) as { candidates: string | null }[];
    return {
      items: rows.map((r) => ({
        ...r,
        candidates: parseJson<{ posterPath: string | null }[]>(r.candidates, []).map((c) => ({ ...c, posterUrl: posterUrl({ poster_path: c.posterPath }) })),
      })),
      pending: ctx.matcher.pendingCount(),
      metadataSource: ctx.metadata()?.name ?? null,
    };
  });

  app.get('/review/search', async (req) => {
    requireUser(req);
    const q = parse(z.object({ q: z.string().trim().min(1).max(100), type: z.enum(['movie', 'tv']).optional(), year: z.coerce.number().int().optional() }), req.query);
    const meta = ctx.metadata();
    if (!meta) throw new ApiError(400, 'no_metadata', 'Connect TMDb or Seerr to search for matches.');
    const results = q.type ? await meta.search(q.type, q.q, q.year ?? null) : (await meta.searchAny(q.q, 1)).results;
    return { results: results.slice(0, 20).map((r) => ({ ...r, posterUrl: posterUrl({ poster_path: r.posterPath ?? null }) })) };
  });

  app.post('/review/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(IdParam, req.params);
    const body = parse(
      z.union([
        z.object({ ignore: z.literal(true) }),
        z.object({ tmdbId: z.number().int().positive(), mediaType: z.enum(['movie', 'tv']), title: z.string().min(1).max(300), year: z.number().int().nullable() }),
      ]),
      req.body,
    );
    const n = ctx.matcher.resolveManually(id, u.id, 'ignore' in body ? 'ignore' : body);
    if (n === 0) throw new ApiError(404, 'not_found', 'Item not found.');
    void triggerJob(ctx, 'metadata', 'event');
    return { updated: n };
  });

  // ---- Requests ----------------------------------------------------------------------------
  app.get('/requests', async (req) => {
    const u = requireUser(req);
    const q = parse(z.object({ scope: z.enum(['mine', 'all']).default('mine'), filter: z.enum(['active', 'available', 'problems', 'all']).default('all') }), req.query);
    const all = q.scope === 'all' && u.role === 'admin';
    const rows = ctx.db
      .prepare(
        `SELECT r.id, r.title_id AS titleId, r.user_id AS userId, r.requested_by AS requestedBy, r.request_status AS requestStatus, r.media_status AS mediaStatus,
                r.is4k, r.seasons, r.origin, r.last_error AS lastError, r.created_at AS createdAt, r.updated_at AS updatedAt, r.synced_at AS syncedAt, u.display_name AS userName
           FROM requests r LEFT JOIN users u ON u.id = r.user_id
          WHERE ${all ? '1 = 1' : 'r.user_id = ?'} ORDER BY r.created_at DESC LIMIT 500`,
      )
      .all(...(all ? [] : [u.id])) as { titleId: number; seasons: string; requestStatus: number | null; mediaStatus: number | null; userId: number | null }[];
    const cards = new Map(cardsFor(ctx, u, [...new Set(rows.map((r) => r.titleId))]).map((c) => [c.id, c]));
    const items = rows
      .map((r) => ({ ...r, seasons: parseJson<number[]>(r.seasons, []), state: mapSeerrRequest(r.requestStatus, r.mediaStatus), title: cards.get(r.titleId) ?? null, mine: r.userId === u.id }))
      .filter((r) => {
        if (q.filter === 'active') return ACTIVE_REQUEST_STATES.includes(r.state);
        if (q.filter === 'available') return r.state === 'available' || r.state === 'partially_available';
        if (q.filter === 'problems') return ['declined', 'failed', 'blocklisted', 'unknown'].includes(r.state);
        return true;
      });
    const seerr = ctx.integrations.view('seerr');
    return { items, seerr: { ready: seerr.ready, lastOkAt: seerr.lastOkAt, status: seerr.status }, canViewAll: u.role === 'admin' };
  });

  // ---- Library (Jellyfin) ------------------------------------------------------------------
  app.get('/library', async (req) => {
    const u = requireUser(req);
    const q = parse(
      z.object({
        type: z.enum(['movie', 'tv']).optional(),
        filter: z.enum(['all', 'in_progress', 'unwatched', 'watched', 'favorites']).default('all'),
        q: z.string().trim().max(100).optional(),
        sort: z.enum(['added', 'title', 'year', 'played']).default('added'),
        offset: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(3000).default(120),
      }),
      req.query,
    );
    const jf = ctx.integrations.view('jellyfin');
    if (!jf.ready) return { configured: false, total: 0, items: [], jellyfin: jf };
    const where = ['1 = 1'];
    const args: unknown[] = [u.jellyfinUserId ?? ''];
    if (q.type) {
      where.push('ji.media_type = ?');
      args.push(q.type);
    }
    if (q.q) {
      where.push("(ji.name LIKE ? ESCAPE '\\' OR t.title LIKE ? ESCAPE '\\')");
      const like = `%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      args.push(like, like);
    }
    if (u.jellyfinUserId) {
      if (q.filter === 'watched') where.push('ud.played = 1');
      if (q.filter === 'unwatched') where.push('(ud.played IS NULL OR ud.played = 0) AND COALESCE(ud.position_ticks, 0) = 0 AND (ji.media_type = \'movie\' OR ud.unplayed_count IS NULL OR ud.unplayed_count >= ji.episode_count)');
      if (q.filter === 'in_progress') where.push("(ud.played = 0 AND (COALESCE(ud.position_ticks, 0) > 0 OR (ji.media_type = 'tv' AND ud.unplayed_count < ji.episode_count)))");
      if (q.filter === 'favorites') where.push('ud.is_favorite = 1');
    }
    const order = { added: 'ji.date_created DESC', title: 'COALESCE(t.title, ji.name) COLLATE NOCASE ASC', year: 'COALESCE(ji.year, t.year) DESC', played: 'ud.last_played_at DESC NULLS LAST' }[q.sort];
    const base = `FROM jellyfin_items ji LEFT JOIN titles t ON t.id = ji.title_id LEFT JOIN jellyfin_user_data ud ON ud.item_id = ji.id AND ud.jellyfin_user_id = ? WHERE ${where.join(' AND ')}`;
    const total = (ctx.db.prepare(`SELECT COUNT(*) AS n ${base}`).get(...args) as { n: number }).n;
    const rows = ctx.db
      .prepare(`SELECT ji.id AS jfId, ji.title_id AS titleId, ji.image_tag AS tag, ji.date_created AS addedAt ${base} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...args, q.limit, q.offset) as { jfId: string; titleId: number | null; tag: string | null; addedAt: string | null }[];
    const cards = new Map(cardsFor(ctx, u, rows.map((r) => r.titleId).filter((x): x is number => x !== null)).map((c) => [c.id, c]));
    return {
      configured: true,
      linked: Boolean(u.jellyfinUserId),
      total,
      items: rows.map((r) => ({ ...(r.titleId ? cards.get(r.titleId) : null), jellyfinItemId: r.jfId, addedAt: r.addedAt })).filter((c) => c.id),
      jellyfin: { lastOkAt: jf.lastOkAt, status: jf.status, lastError: jf.lastError },
    };
  });

  // ---- Home --------------------------------------------------------------------------------
  app.get('/home', async (req) => {
    const u = requireUser(req);
    const recentlyAvailable = ctx.db
      .prepare(
        `SELECT DISTINCT t.id FROM list_items li JOIN lists l ON l.id = li.list_id JOIN titles t ON t.id = li.title_id JOIN jellyfin_items ji ON ji.title_id = t.id
          WHERE l.user_id = ? ORDER BY ji.date_created DESC LIMIT 12`,
      )
      .all(u.id) as { id: number }[];
    const activeReqs = ctx.db
      .prepare("SELECT DISTINCT title_id AS id FROM requests WHERE user_id = ? AND (request_status IN (1, 2) OR seerr_request_id IS NULL) ORDER BY created_at DESC LIMIT 12")
      .all(u.id) as { id: number }[];
    const watchlistCount = (ctx.db
      .prepare("SELECT COUNT(DISTINCT li.title_id) AS n FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.user_id = ? AND li.match_status = 'matched'")
      .get(u.id) as { n: number }).n;
    const reviewCount = (ctx.db
      .prepare("SELECT COUNT(*) AS n FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.user_id = ? AND li.match_status IN ('review', 'unmatched')")
      .get(u.id) as { n: number }).n;

    const upNext = upNextFor(ctx, u);

    const attention: { kind: string; message: string; href: string }[] = [];
    if (reviewCount > 0) attention.push({ kind: 'review', message: `${reviewCount} imported ${reviewCount === 1 ? 'title needs' : 'titles need'} a match review.`, href: '/watchlists/review' });
    for (const l of ctx.lists.forUser(u.id).filter((l) => l.last_status === 'error')) {
      attention.push({ kind: 'list_error', message: `“${l.name}” could not sync: ${l.last_error ?? 'unknown error'}`, href: `/watchlists/lists/${l.id}` });
    }
    const trakt = ctx.connections.get(u.id, 'trakt');
    if (trakt?.status === 'needs_reauth') attention.push({ kind: 'reauth', message: 'Your Trakt sign-in expired. Reconnect to keep lists in sync.', href: '/integrations/trakt' });
    if (!u.jellyfinUserId && ctx.integrations.isReady('jellyfin')) attention.push({ kind: 'link', message: 'Link your Jellyfin account to see what you have watched.', href: '/integrations/jellyfin' });
    if (!u.seerrUserId && ctx.integrations.isReady('seerr')) attention.push({ kind: 'link', message: 'Your account is not linked to Seerr yet, so you cannot request titles.', href: '/integrations/seerr' });
    if (u.role === 'admin') {
      for (const p of ['jellyfin', 'seerr', 'tmdb', 'trakt'] as const) {
        const v = ctx.integrations.view(p);
        if (v.ready && v.status === 'error') attention.push({ kind: 'integration', message: `${p === 'tmdb' ? 'TMDb' : p[0]!.toUpperCase() + p.slice(1)}: ${v.lastError ?? 'connection failed'}`, href: `/integrations/${p}` });
      }
    }

    return {
      counts: { watchlist: watchlistCount, review: reviewCount, lists: ctx.lists.forUser(u.id).length },
      recentlyAvailable: cardsFor(ctx, u, recentlyAvailable.map((r) => r.id)),
      activeRequests: cardsFor(ctx, u, activeReqs.map((r) => r.id)),
      upNext,
      activity: ctx.activity.recent(u.id, 20),
      attention,
    };
  });
}
