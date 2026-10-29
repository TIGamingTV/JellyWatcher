import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import type { AppContext } from '../context.js';
import { ApiError, ProviderError } from '../http/errors.js';
import { IdParam, parse } from '../http/validate.js';
import { ImdbClient, parseImdbCsv, parseImdbListUrl } from '../providers/imdb.js';
import { LETTERBOXD_USERNAME, LetterboxdRssClient, UploadError, parseLetterboxdCsv, parseLetterboxdZip } from '../providers/letterboxd.js';
import { listInfoFromJson, parseTraktListUrl } from '../providers/trakt.js';
import { decodeText } from '../providers/csv.js';
import { SOURCE_DESCRIPTORS, type ListFetchResult, type SourceListInfo } from '../providers/types.js';
import { requireUser, type SessionUser } from '../security/auth.js';
import { isTimeline, type ListRow } from '../services/lists.js';
import { buildTimelines, type TimelineSummary } from '../services/timeline.js';
import { syncList, type TraktListRef } from '../sync/lists.js';
import { triggerJob } from '../sync/scheduler.js';

interface PendingDevice {
  deviceCode: string;
  expiresAt: number;
  interval: number;
  nextPollAt: number;
}

export function listView(ctx: AppContext, l: ListRow, summary?: TimelineSummary) {
  const counts = ctx.db
    .prepare(
      `SELECT SUM(match_status = 'matched') AS matched, SUM(match_status IN ('review', 'unmatched')) AS review, SUM(match_status = 'pending') AS pending
         FROM list_items WHERE list_id = ?`,
    )
    .get(l.id) as { matched: number | null; review: number | null; pending: number | null };
  return {
    id: l.id,
    provider: l.provider,
    kind: l.kind,
    name: l.name,
    description: l.description,
    ownerName: l.owner_name,
    url: l.url,
    autoSync: l.auto_sync === 1,
    canSync: l.sync_supported === 1,
    itemCount: l.item_count,
    matched: counts.matched ?? 0,
    needsReview: counts.review ?? 0,
    pending: counts.pending ?? 0,
    lastSyncedAt: l.last_synced_at,
    lastAttemptAt: l.last_attempt_at,
    lastStatus: l.last_status,
    lastError: l.last_error,
    display: l.display,
    timeline: isTimeline(l),
    summary: summary ?? null,
    createdAt: l.created_at,
  };
}

async function runListSync(ctx: AppContext, list: ListRow) {
  const res = await ctx.jobs.run('lists', 'manual', async () => ({ stats: { ...(await syncList(ctx, list)) } }), `list:${list.id}`);
  void triggerJob(ctx, 'match', 'event');
  if (res.status === 'error') throw new ApiError(502, 'sync_failed', res.error ?? 'Sync failed.');
  return res;
}

export async function sourceRoutes(app: FastifyInstance, { ctx, users }: AppDeps) {
  const pending = new Map<number, PendingDevice>();

  const traktClient = () => {
    const c = ctx.integrations.trakt();
    if (!c) throw new ApiError(400, 'trakt_not_configured', 'Trakt is not set up yet. An administrator needs to add a Trakt API app in Integrations.');
    return c;
  };

  app.get('/sources', async (req) => {
    const u = requireUser(req);
    const trakt = ctx.connections.get(u.id, 'trakt');
    const letterboxd = ctx.connections.get(u.id, 'letterboxd');
    const counts = ctx.db.prepare('SELECT provider, COUNT(*) AS n FROM lists WHERE user_id = ? GROUP BY provider').all(u.id) as { provider: string; n: number }[];
    const listCount = Object.fromEntries(counts.map((c) => [c.provider, c.n]));
    return {
      sources: SOURCE_DESCRIPTORS.map((d) => ({
        ...d,
        available: d.id !== 'trakt' || ctx.integrations.isReady('trakt'),
        connection: d.id === 'trakt' ? ctx.connections.view(trakt) : d.id === 'letterboxd' ? ctx.connections.view(letterboxd) : null,
        listCount: listCount[d.id] ?? 0,
      })),
      jellyfin: {
        available: ctx.integrations.isReady('jellyfin'),
        linked: u.jellyfinUserId ? { userId: u.jellyfinUserId, username: u.jellyfinUsername } : null,
      },
      seerr: { available: ctx.integrations.isReady('seerr'), linked: u.seerrUserId ? { userId: u.seerrUserId, username: u.seerrUsername } : null },
    };
  });

  // ---- Trakt device sign-in -------------------------------------------------------------
  app.post('/connections/trakt/device', async (req) => {
    const u = requireUser(req);
    const code = await traktClient().deviceCode();
    pending.set(u.id, { deviceCode: code.device_code, expiresAt: Date.now() + code.expires_in * 1000, interval: code.interval, nextPollAt: Date.now() + code.interval * 1000 });
    return { userCode: code.user_code, verificationUrl: code.verification_url, expiresIn: code.expires_in, interval: code.interval };
  });

  app.post('/connections/trakt/poll', async (req) => {
    const u = requireUser(req);
    const p = pending.get(u.id);
    if (!p) throw new ApiError(404, 'no_pending', 'Start the Trakt sign-in again.');
    if (Date.now() > p.expiresAt) {
      pending.delete(u.id);
      return { status: 'expired' };
    }
    if (Date.now() < p.nextPollAt) return { status: 'pending', retryIn: Math.ceil((p.nextPollAt - Date.now()) / 1000) };
    const client = traktClient();
    const r = await client.pollDevice(p.deviceCode);
    if (r.status === 'slow_down') p.interval += 5;
    p.nextPollAt = Date.now() + p.interval * 1000;
    if (r.status !== 'authorized') {
      if (['expired', 'denied', 'invalid', 'used'].includes(r.status)) pending.delete(u.id);
      return { status: r.status === 'slow_down' ? 'pending' : r.status, retryIn: p.interval };
    }
    pending.delete(u.id);
    const settings = await client.settings(r.tokens.accessToken);
    const conn = ctx.connections.save(u.id, 'trakt', {
      accountName: settings.user.username,
      config: { slug: settings.user.ids.slug, name: settings.user.name ?? null, vip: settings.user.vip ?? false },
      secrets: { ...r.tokens },
    });
    // Import the watchlist straight away; it is what people expect after connecting.
    const listId = ctx.lists.upsert(u.id, 'trakt', { externalId: 'watchlist', name: 'Trakt Watchlist', kind: 'watchlist', url: `https://trakt.tv/users/${settings.user.ids.slug}/watchlist` }, {
      connectionId: conn.id,
      sourceRef: { mode: 'watchlist' } satisfies TraktListRef,
    });
    void runListSync(ctx, ctx.lists.get(listId)!).catch(() => undefined);
    return { status: 'authorized', connection: ctx.connections.view(conn) };
  });

  app.delete('/connections/trakt', async (req) => {
    const u = requireUser(req);
    const conn = ctx.connections.get(u.id, 'trakt');
    const q = parse(z.object({ removeLists: z.enum(['0', '1']).default('1') }), req.query);
    if (conn?.secrets.accessToken && ctx.integrations.trakt()) await ctx.integrations.trakt()!.revoke(conn.secrets.accessToken).catch(() => undefined);
    ctx.connections.remove(u.id, 'trakt');
    if (q.removeLists === '1') ctx.db.prepare("DELETE FROM lists WHERE user_id = ? AND provider = 'trakt' AND kind IN ('watchlist', 'owned')").run(u.id);
    return { ok: true };
  });

  const imported = (userId: number) =>
    new Set((ctx.db.prepare("SELECT external_id FROM lists WHERE user_id = ? AND provider = 'trakt'").all(userId) as { external_id: string }[]).map((r) => r.external_id));

  app.get('/trakt/my-lists', async (req) => {
    const u = requireUser(req);
    const conn = ctx.connections.get(u.id, 'trakt');
    if (!conn) throw new ApiError(400, 'trakt_not_connected', 'Connect your Trakt account first.');
    const client = traktClient();
    const token = await ctx.connections.traktAccessToken(conn, client);
    const [owned, liked] = await Promise.all([client.myLists(token), client.likedLists(token)]);
    const have = imported(u.id);
    const mark = (l: SourceListInfo) => ({ ...l, imported: have.has(l.externalId) });
    return { watchlistImported: have.has('watchlist'), owned: owned.map(mark), liked: liked.map(mark) };
  });

  app.get('/trakt/lists/search', async (req) => {
    const u = requireUser(req);
    const q = parse(z.object({ q: z.string().trim().min(2).max(100) }), req.query);
    const have = imported(u.id);
    return { lists: (await traktClient().searchLists(q.q)).map((l) => ({ ...l, imported: have.has(l.externalId) })) };
  });

  app.get('/trakt/lists/discover', async (req) => {
    const u = requireUser(req);
    const q = parse(z.object({ kind: z.enum(['trending', 'popular']).default('popular') }), req.query);
    const client = traktClient();
    const lists = q.kind === 'trending' ? await client.trendingLists() : await client.popularLists();
    const have = imported(u.id);
    return { lists: lists.map((l) => ({ ...l, imported: have.has(l.externalId) })) };
  });

  const TraktImport = z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('watchlist') }),
    z.object({ mode: z.enum(['owned', 'liked', 'public']), traktId: z.number().int().positive() }),
    z.object({ mode: z.literal('url'), url: z.string().trim().url().max(500) }),
  ]);

  app.post('/lists/trakt', async (req) => importTrakt(requireUser(req), parse(TraktImport, req.body)));

  async function importTrakt(u: SessionUser, body: z.infer<typeof TraktImport>) {
    const client = traktClient();
    const conn = ctx.connections.get(u.id, 'trakt');
    const token = conn ? await ctx.connections.traktAccessToken(conn, client).catch(() => undefined) : undefined;
    const mySlug = (conn?.config.slug as string | undefined)?.toLowerCase();

    let info: SourceListInfo;
    let ref: TraktListRef;
    if (body.mode === 'watchlist') {
      if (!conn || !token) throw new ApiError(400, 'trakt_not_connected', 'Connect your Trakt account to import your watchlist.');
      info = { externalId: 'watchlist', name: 'Trakt Watchlist', kind: 'watchlist', url: `https://trakt.tv/users/${mySlug}/watchlist` };
      ref = { mode: 'watchlist' };
    } else {
      let listRef;
      if (body.mode === 'url') {
        listRef = parseTraktListUrl(body.url);
        if (!listRef) throw new ApiError(400, 'invalid_url', 'Paste a Trakt list link, like https://trakt.tv/users/name/lists/list-name.');
        if (listRef.kind === 'user_watchlist') {
          const own = listRef.user!.toLowerCase() === mySlug;
          info = own
            ? { externalId: 'watchlist', name: 'Trakt Watchlist', kind: 'watchlist', url: `https://trakt.tv/users/${mySlug}/watchlist` }
            : { externalId: `watchlist:${listRef.user!.toLowerCase()}`, name: `${listRef.user}’s Watchlist`, kind: 'public', ownerName: listRef.user, url: `https://trakt.tv/users/${listRef.user}/watchlist` };
          ref = own ? { mode: 'watchlist' } : { mode: 'public_watchlist', user: listRef.user };
          return importAndSync(u, info, ref, conn?.id);
        }
      } else listRef = { kind: 'list_id' as const, id: String(body.traktId) };
      let json;
      try {
        json = await client.listInfo(listRef, token);
      } catch (err) {
        if (err instanceof ProviderError && (err.kind === 'not_found' || err.kind === 'forbidden' || err.kind === 'auth')) {
          throw new ApiError(404, 'list_not_found', 'That Trakt list was not found or is private.');
        }
        throw err;
      }
      const ownerSlug = json.user?.ids?.slug?.toLowerCase();
      const owned = Boolean(mySlug && ownerSlug === mySlug);
      const mode = owned ? 'owned' : body.mode === 'liked' ? 'liked' : 'public';
      if (!owned && json.privacy && json.privacy !== 'public') throw new ApiError(400, 'list_private', 'That list is not public, so it cannot be imported.');
      info = listInfoFromJson(json, mode);
      ref = { mode, traktId: json.ids.trakt, ownerSlug: ownerSlug ?? undefined };
    }
    return importAndSync(u, info, ref, conn?.id);
  }

  // ---- IMDb public lists by link (no account or key) -------------------------------------
  async function importImdb(u: SessionUser, url: string) {
    const listId = parseImdbListUrl(url);
    if (!listId) throw new ApiError(400, 'invalid_url', 'Paste an IMDb list link, like https://www.imdb.com/list/ls020816781/.');
    let result: ListFetchResult;
    try {
      result = await new ImdbClient().list(listId);
    } catch (err) {
      if (err instanceof ProviderError && (err.kind === 'not_found' || err.kind === 'forbidden')) throw new ApiError(404, 'list_not_found', err.message);
      throw err;
    }
    const id = ctx.lists.upsert(u.id, 'imdb', result.info, { sourceRef: { mode: 'graphql', listId } });
    // Lists first imported from a CSV become syncable once added by link.
    ctx.db.prepare('UPDATE lists SET sync_supported = 1 WHERE id = ?').run(id);
    ctx.lists.applyItems(id, result);
    ctx.activity.add(u.id, 'list_imported', `Imported the IMDb list “${result.info.name}”.`);
    void triggerJob(ctx, 'match', 'event');
    return { list: listView(ctx, ctx.lists.get(id)!) };
  }

  app.post('/lists/imdb', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const u = requireUser(req);
    const body = parse(z.object({ url: z.string().trim().min(4).max(500) }), req.body);
    return importImdb(u, body.url);
  });

  /** One field for any supported link: IMDb lists and Trakt lists or watchlists. */
  app.post('/lists/link', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const u = requireUser(req);
    const body = parse(z.object({ url: z.string().trim().min(4).max(500) }), req.body);
    if (parseImdbListUrl(body.url)) return importImdb(u, body.url);
    if (parseTraktListUrl(body.url)) return importTrakt(u, { mode: 'url', url: body.url });
    throw new ApiError(400, 'invalid_url', 'Paste a link to a public IMDb list (imdb.com/list/ls…) or a Trakt list (trakt.tv/users/…/lists/…).');
  });

  async function importAndSync(u: SessionUser, info: SourceListInfo, ref: TraktListRef, connectionId?: number) {
    const needsToken = ref.mode === 'watchlist' || ref.mode === 'owned';
    const id = ctx.lists.upsert(u.id, 'trakt', info, { connectionId: needsToken ? connectionId : null, sourceRef: ref as Record<string, unknown> });
    const list = ctx.lists.get(id)!;
    ctx.activity.add(u.id, 'list_imported', `Imported the Trakt list “${info.name}”.`);
    try {
      await runListSync(ctx, list);
    } catch {
      /* status recorded on the list */
    }
    return { list: listView(ctx, ctx.lists.get(id)!) };
  }

  // ---- Letterboxd -----------------------------------------------------------------------
  app.put('/connections/letterboxd', async (req) => {
    const u = requireUser(req);
    const body = parse(z.object({ username: z.string().trim().regex(LETTERBOXD_USERNAME, 'Enter your Letterboxd username (letters, numbers, underscores).'), rss: z.boolean().default(true) }), req.body);
    let diary: ListFetchResult | null = null;
    if (body.rss) {
      diary = await new LetterboxdRssClient().diary(body.username);
    }
    const conn = ctx.connections.save(u.id, 'letterboxd', { accountName: body.username, config: { rss: body.rss } });
    if (diary) {
      const listId = ctx.lists.upsert(u.id, 'letterboxd', diary.info, { connectionId: conn.id, sourceRef: { mode: 'rss' } });
      ctx.lists.applyItems(listId, diary);
      ctx.connections.markSynced(conn.id);
      void triggerJob(ctx, 'match', 'event');
    } else {
      ctx.db.prepare("DELETE FROM lists WHERE user_id = ? AND provider = 'letterboxd' AND kind = 'diary'").run(u.id);
    }
    return { connection: ctx.connections.view(ctx.connections.get(u.id, 'letterboxd')) };
  });

  app.delete('/connections/letterboxd', async (req) => {
    const u = requireUser(req);
    ctx.connections.remove(u.id, 'letterboxd');
    ctx.db.prepare("DELETE FROM lists WHERE user_id = ? AND provider = 'letterboxd' AND kind = 'diary'").run(u.id);
    return { ok: true };
  });

  // ---- Jellyfin account link ------------------------------------------------------------
  app.post('/connections/jellyfin', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const u = requireUser(req);
    const body = parse(z.object({ username: z.string().min(1).max(128), password: z.string().max(256) }), req.body);
    const jf = ctx.integrations.jellyfin();
    if (!jf) throw new ApiError(400, 'jellyfin_not_configured', 'Jellyfin is not connected yet.');
    let verified;
    try {
      verified = await jf.verifyCredentials(body.username, body.password);
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'auth') throw new ApiError(400, 'invalid_credentials', 'Jellyfin rejected that username or password.');
      throw err;
    }
    users.update(u.id, { jellyfinUserId: verified.userId, jellyfinUsername: verified.name });
    void triggerJob(ctx, 'jellyfin', 'event');
    return { linked: { userId: verified.userId, username: verified.name } };
  });

  app.delete('/connections/jellyfin', async (req) => {
    const u = requireUser(req);
    if (u.authSource === 'jellyfin' && !u.hasPassword) {
      throw new ApiError(400, 'needs_password', 'You sign in with Jellyfin. Set a JellyWatcher password first, then unlink.');
    }
    users.update(u.id, { jellyfinUserId: null, jellyfinUsername: null });
    return { ok: true };
  });

  // ---- Uploads (Letterboxd / IMDb exports) ----------------------------------------------
  app.post('/lists/upload', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const u = requireUser(req);
    const fields: Record<string, string> = {};
    let file: { filename: string; data: Buffer } | null = null;
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        const data = await part.toBuffer();
        file = { filename: part.filename, data };
      } else fields[part.fieldname] = String(part.value).slice(0, 200);
    }
    const meta = parse(
      z.object({ provider: z.enum(['letterboxd', 'imdb']), name: z.string().trim().max(120).optional(), replaceListId: z.coerce.number().int().positive().optional() }),
      fields,
    );
    if (!file || file.data.length === 0) throw new ApiError(400, 'no_file', 'Choose a file to upload.');
    const lower = file.filename.toLowerCase();
    const baseName = file.filename.replace(/\.(csv|zip)$/i, '').replace(/[-_]+/g, ' ').trim() || 'Imported list';

    let results: ListFetchResult[];
    try {
      if (meta.provider === 'letterboxd') {
        if (lower.endsWith('.zip')) results = parseLetterboxdZip(file.data);
        else if (lower.endsWith('.csv')) {
          const r = parseLetterboxdCsv(decodeText(file.data), meta.name || baseName);
          if (/^watchlist$/i.test(baseName)) r.info = { ...r.info, externalId: 'watchlist', name: 'Letterboxd Watchlist', kind: 'watchlist' };
          results = [r];
        } else throw new UploadError('Upload the Letterboxd export ZIP or a list CSV.');
      } else {
        if (!lower.endsWith('.csv')) throw new UploadError('Upload the CSV file from IMDb’s Export button.');
        const isWatchlist = /watchlist/i.test(baseName);
        const r = parseImdbCsv(decodeText(file.data), meta.name || (isWatchlist ? 'IMDb Watchlist' : baseName));
        if (isWatchlist && !meta.name) r.info = { ...r.info, externalId: 'watchlist', kind: 'watchlist' };
        results = [r];
      }
    } catch (err) {
      if (err instanceof UploadError) throw new ApiError(400, 'invalid_file', err.message);
      throw err;
    }

    const lists = [];
    if (meta.replaceListId) {
      const target = ctx.lists.getOwned(meta.replaceListId, u.id);
      if (!target || target.provider !== meta.provider) throw new ApiError(404, 'not_found', 'List not found.');
      if (results.length !== 1) throw new ApiError(400, 'ambiguous', 'To update one list, upload that list’s CSV rather than the full export.');
      const applied = ctx.lists.applyItems(target.id, results[0]!);
      lists.push({ ...listView(ctx, ctx.lists.get(target.id)!), applied });
    } else {
      for (const r of results) {
        const id = ctx.lists.upsert(u.id, meta.provider, r.info, { autoSync: false, syncSupported: false });
        const applied = ctx.lists.applyItems(id, r);
        lists.push({ ...listView(ctx, ctx.lists.get(id)!), applied });
      }
      ctx.activity.add(u.id, 'list_imported', `Imported ${results.length === 1 ? `“${results[0]!.info.name}”` : `${results.length} lists`} from ${meta.provider === 'imdb' ? 'IMDb' : 'Letterboxd'}.`);
    }
    void triggerJob(ctx, 'match', 'event');
    return { lists };
  });

  // ---- Lists ---------------------------------------------------------------------------
  app.get('/lists', async (req) => {
    const u = requireUser(req);
    const lists = ctx.lists.forUser(u.id);
    const timelines = buildTimelines(ctx, u, lists);
    return { lists: lists.map((l) => listView(ctx, l, timelines.get(l.id)?.summary)) };
  });

  app.get('/lists/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(IdParam, req.params);
    const l = ctx.lists.getOwned(id, u.id);
    if (!l) throw new ApiError(404, 'not_found', 'List not found.');
    return { list: listView(ctx, l, buildTimelines(ctx, u, [l]).get(l.id)?.summary) };
  });

  /** Every entry in list order with sizes, watch time and progress. */
  app.get('/lists/:id/timeline', async (req) => {
    const u = requireUser(req);
    const { id } = parse(IdParam, req.params);
    const l = ctx.lists.getOwned(id, u.id);
    if (!l) throw new ApiError(404, 'not_found', 'List not found.');
    return buildTimelines(ctx, u, [l]).get(l.id)!;
  });

  app.patch('/lists/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(IdParam, req.params);
    const body = parse(
      z.object({ name: z.string().trim().min(1).max(120).optional(), autoSync: z.boolean().optional(), display: z.enum(['auto', 'grid', 'timeline']).optional() }),
      req.body,
    );
    const l = ctx.lists.getOwned(id, u.id);
    if (!l) throw new ApiError(404, 'not_found', 'List not found.');
    if (body.name) ctx.lists.rename(id, body.name);
    if (body.autoSync !== undefined) ctx.lists.setAutoSync(id, body.autoSync);
    if (body.display) ctx.lists.setDisplay(id, body.display);
    return { list: listView(ctx, ctx.lists.get(id)!) };
  });

  app.delete('/lists/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(IdParam, req.params);
    if (!ctx.lists.getOwned(id, u.id)) throw new ApiError(404, 'not_found', 'List not found.');
    ctx.lists.remove(id);
    return { ok: true };
  });

  app.post('/lists/:id/sync', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const u = requireUser(req);
    const { id } = parse(IdParam, req.params);
    const l = ctx.lists.getOwned(id, u.id);
    if (!l) throw new ApiError(404, 'not_found', 'List not found.');
    if (!l.sync_supported) throw new ApiError(400, 'not_syncable', 'This list was imported from a file. Upload a new export to update it.');
    const res = await runListSync(ctx, l);
    return { list: listView(ctx, ctx.lists.get(id)!), result: res.stats };
  });
}
