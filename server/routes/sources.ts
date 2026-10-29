import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import type { AppContext } from '../context.js';
import type { AnimeIds } from '../providers/anime.js';
import { ApiError, ProviderError } from '../http/errors.js';
import { IdParam, parse } from '../http/validate.js';
import { AnilistClient, parseAnilistUrl } from '../providers/anilist.js';
import { decodeText } from '../providers/csv.js';
import { parseIdCsv } from '../providers/generic.js';
import { ImdbClient, parseImdbCsv, parseImdbListUrl } from '../providers/imdb.js';
import { LETTERBOXD_USERNAME, LetterboxdRssClient, LetterboxdWebClient, UploadError, parseLetterboxdCsv, parseLetterboxdUrl, parseLetterboxdZip } from '../providers/letterboxd.js';
import { MdblistClient, parseMdblistUrl } from '../providers/mdblist.js';
import { MalClient, parseMalExport, parseMalListUrl } from '../providers/myanimelist.js';
import { parseSimklExport } from '../providers/simkl.js';
import { parseTmdbListUrl } from '../providers/tmdb.js';
import { listInfoFromJson, parseTraktListUrl } from '../providers/trakt.js';
import { SOURCE_DESCRIPTORS, UPLOAD_SOURCES, type ListFetchResult, type SourceListInfo, type UploadSource } from '../providers/types.js';
import { requireUser, type SessionUser } from '../security/auth.js';
import { isTimeline, LOCAL_PROVIDER, type ListRow } from '../services/lists.js';
import { autoOrder, buildTimelines, entryReleaseDates, type TimelineSummary } from '../services/timeline.js';
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
    /** Local lists: entries can be added and removed here. */
    editable: l.provider === LOCAL_PROVIDER,
    /** The person reordered the entries (kept across syncs). */
    customOrder: ctx.lists.hasCustomOrder(l.id),
    summary: summary ?? null,
    createdAt: l.created_at,
  };
}

const PROVIDER_LABEL: Record<string, string> = Object.fromEntries(SOURCE_DESCRIPTORS.map((d) => [d.id, d.name]));

/** Parses an uploaded export into one or more lists. Throws UploadError for unusable files. */
export function parseUpload(provider: UploadSource, filename: string, data: Uint8Array, baseName: string, name: string | undefined, anime: AnimeIds | null = null): ListFetchResult[] {
  const lower = filename.toLowerCase();
  const text = () => decodeText(data);
  switch (provider) {
    case 'letterboxd': {
      if (lower.endsWith('.zip')) return parseLetterboxdZip(data);
      if (!lower.endsWith('.csv')) throw new UploadError('Upload the Letterboxd export ZIP or a list CSV.');
      const r = parseLetterboxdCsv(text(), name || baseName);
      if (/^watchlist$/i.test(baseName)) r.info = { ...r.info, externalId: 'watchlist', name: 'Letterboxd Watchlist', kind: 'watchlist' };
      return [r];
    }
    case 'imdb': {
      if (!lower.endsWith('.csv')) throw new UploadError('Upload the CSV file from IMDb’s Export button.');
      const isWatchlist = /watchlist/i.test(baseName);
      const r = parseImdbCsv(text(), name || (isWatchlist ? 'IMDb Watchlist' : baseName));
      if (isWatchlist && !name) r.info = { ...r.info, externalId: 'watchlist', kind: 'watchlist' };
      return [r];
    }
    case 'myanimelist':
    case 'anilist':
      if (!/\.(xml|gz)$/.test(lower)) throw new UploadError('Upload the anime list export as .xml or .xml.gz.');
      return parseMalExport(data, provider, anime);
    case 'simkl':
      return parseSimklExport(filename, data, anime);
    case 'tmdb':
    case 'mdblist': {
      if (!lower.endsWith('.csv')) throw new UploadError('Upload a CSV file.');
      const source = provider === 'tmdb' ? 'TMDb' : 'MDBList';
      return parseIdCsv(text(), {
        source,
        fallbackName: name || baseName,
        anime,
        urlFor: ({ tmdbId, mediaType, imdbId }) => (tmdbId && mediaType ? `https://www.themoviedb.org/${mediaType}/${tmdbId}` : imdbId ? `https://www.imdb.com/title/${imdbId}/` : null),
      });
    }
  }
}

async function runListSync(ctx: AppContext, list: ListRow) {
  const res = await ctx.jobs.run('lists', 'manual', async () => ({ stats: { ...(await syncList(ctx, list)) } }), `list:${list.id}`);
  void triggerJob(ctx, 'match', 'event');
  if (res.status === 'error') throw new ApiError(502, 'sync_failed', res.error ?? 'Sync failed.');
  return res;
}

export async function sourceRoutes(app: FastifyInstance, { ctx, users, quickConnect }: AppDeps) {
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
        /** Whether links can be added right now (Trakt and TMDb need a server integration). */
        linkReady: d.link !== null && (d.id === 'trakt' ? ctx.integrations.isReady('trakt') : d.id === 'tmdb' ? ctx.integrations.isReady('tmdb') : true),
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

  /**
   * Adds (or refreshes) a list read from a public link. The list syncs automatically from then on;
   * lists first imported from a file become syncable once added by link.
   */
  async function importFetched(u: SessionUser, provider: string, fetch: () => Promise<ListFetchResult>, sourceRef: Record<string, unknown>) {
    let result: ListFetchResult;
    try {
      result = await fetch();
    } catch (err) {
      if (err instanceof ProviderError && (err.kind === 'not_found' || err.kind === 'forbidden')) throw new ApiError(404, 'list_not_found', err.message);
      if (err instanceof ProviderError && (err.kind === 'config' || err.kind === 'bad_request')) throw new ApiError(400, 'invalid_list', err.message);
      throw err;
    }
    const id = ctx.lists.upsert(u.id, provider, result.info, { sourceRef });
    ctx.db.prepare('UPDATE lists SET auto_sync = CASE WHEN sync_supported = 0 THEN 1 ELSE auto_sync END, sync_supported = 1 WHERE id = ?').run(id);
    ctx.lists.applyItems(id, result);
    ctx.activity.add(u.id, 'list_imported', `Imported the ${PROVIDER_LABEL[provider] ?? provider} list “${result.info.name}”.`);
    void triggerJob(ctx, 'match', 'event');
    return { list: listView(ctx, ctx.lists.get(id)!) };
  }

  // ---- IMDb public lists by link (no account or key) -------------------------------------
  async function importImdb(u: SessionUser, url: string) {
    const listId = parseImdbListUrl(url);
    if (!listId) throw new ApiError(400, 'invalid_url', 'Paste an IMDb list link, like https://www.imdb.com/list/ls020816781/.');
    return importFetched(u, 'imdb', () => new ImdbClient().list(listId), { mode: 'graphql', listId });
  }

  app.post('/lists/imdb', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const u = requireUser(req);
    const body = parse(z.object({ url: z.string().trim().min(4).max(500) }), req.body);
    return importImdb(u, body.url);
  });

  /** One field for every supported link: IMDb, Trakt, Letterboxd, TMDb, MyAnimeList, AniList and MDBList. */
  app.post('/lists/link', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const u = requireUser(req);
    const body = parse(z.object({ url: z.string().trim().min(4).max(500) }), req.body);
    const url = body.url;
    if (parseImdbListUrl(url)) return importImdb(u, url);
    if (parseTraktListUrl(url)) return importTrakt(u, { mode: 'url', url });

    let lb = parseLetterboxdUrl(url);
    if (lb === 'short') {
      lb = await new LetterboxdWebClient().resolveShort(url).catch(() => null);
      if (!lb) throw new ApiError(400, 'invalid_url', 'That boxd.it link does not point to a Letterboxd list or watchlist.');
    }
    if (lb) {
      const ref = lb;
      const own = ctx.connections.get(u.id, 'letterboxd')?.accountName;
      return importFetched(u, 'letterboxd', () => new LetterboxdWebClient().list(ref, own), { mode: 'web', user: ref.user, slug: ref.slug });
    }

    const tmdbList = parseTmdbListUrl(url);
    if (tmdbList) {
      const tmdb = ctx.integrations.tmdb();
      if (!tmdb) throw new ApiError(400, 'tmdb_not_configured', 'TMDb lists need the TMDb API token. An administrator can add it in Integrations › TMDb.');
      return importFetched(u, 'tmdb', () => tmdb.list(tmdbList), { mode: 'api', listId: tmdbList });
    }

    const mal = parseMalListUrl(url);
    if (mal) {
      await ctx.animeIds.load();
      return importFetched(u, 'myanimelist', () => new MalClient().list(mal.user, mal.status, ctx.animeIds), { mode: 'web', user: mal.user, status: mal.status });
    }

    const anilist = parseAnilistUrl(url);
    if (anilist) {
      await ctx.animeIds.load();
      return importFetched(u, 'anilist', () => new AnilistClient().list(anilist.user, anilist.list, ctx.animeIds), { mode: 'api', user: anilist.user, list: anilist.list });
    }

    const mdb = parseMdblistUrl(url);
    if (mdb) return importFetched(u, 'mdblist', () => new MdblistClient().list(mdb.user, mdb.slug), { mode: 'json', user: mdb.user, slug: mdb.slug });

    if (/^https?:\/\/([a-z0-9-]+\.)?simkl\.com\//i.test(url)) {
      throw new ApiError(400, 'invalid_url', 'Simkl shares lists only with apps you sign in to, so Simkl links can’t be read. Upload your Simkl export instead.');
    }
    throw new ApiError(
      400,
      'invalid_url',
      'That link isn’t a supported list. Paste a public list from IMDb, Trakt, Letterboxd, TMDb, MyAnimeList, AniList or MDBList.',
    );
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

  app.post('/connections/jellyfin/quick-connect', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const u = requireUser(req);
    const jf = ctx.integrations.jellyfin();
    if (!jf) throw new ApiError(400, 'jellyfin_not_configured', 'Jellyfin is not connected yet.');
    const deviceId = jf.signInDeviceId(`link-${u.id}-${Date.now()}`);
    let r;
    try {
      r = await jf.quickConnectInitiate(deviceId);
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'forbidden') throw new ApiError(400, 'quick_connect_disabled', err.message);
      throw err;
    }
    const p = quickConnect.add({ purpose: 'link', url: jf.baseUrl, secret: r.secret, code: r.code, deviceId, userId: u.id });
    return { id: p.id, code: r.code, expiresAt: new Date(p.expiresAt).toISOString(), interval: 2 };
  });

  app.post('/connections/jellyfin/quick-connect/poll', { config: { rateLimit: { max: 90, timeWindow: '1 minute' } } }, async (req) => {
    const u = requireUser(req);
    const body = parse(z.object({ id: z.string().min(10).max(100) }), req.body);
    const jf = ctx.integrations.jellyfin();
    if (!jf) throw new ApiError(400, 'jellyfin_not_configured', 'Jellyfin is not connected yet.');
    const p = quickConnect.get(body.id, 'link', u.id);
    if (!p) return { status: 'expired' };
    const state = await jf.quickConnectState(p.secret, p.deviceId);
    if (state !== 'approved') {
      if (state === 'expired') quickConnect.delete(p.id);
      return { status: state };
    }
    quickConnect.delete(p.id);
    const s = await jf.authenticateWithQuickConnect(p.secret, p.deviceId);
    await jf.endSession(s);
    users.update(u.id, { jellyfinUserId: s.userId, jellyfinUsername: s.name });
    void triggerJob(ctx, 'jellyfin', 'event');
    return { status: 'authorized', linked: { userId: s.userId, username: s.name } };
  });

  app.delete('/connections/jellyfin', async (req) => {
    const u = requireUser(req);
    if (u.authSource === 'jellyfin' && !u.hasPassword) {
      throw new ApiError(400, 'needs_password', 'You sign in with Jellyfin. Set a JellyWatcher password first, then unlink.');
    }
    users.update(u.id, { jellyfinUserId: null, jellyfinUsername: null });
    return { ok: true };
  });

  // ---- Uploads (exports from every source that has one) ---------------------------------
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
      z.object({ provider: z.enum(UPLOAD_SOURCES), name: z.string().trim().max(120).optional(), replaceListId: z.coerce.number().int().positive().optional() }),
      fields,
    );
    if (!file || file.data.length === 0) throw new ApiError(400, 'no_file', 'Choose a file to upload.');
    const baseName = file.filename.replace(/\.(csv|zip|json|xml|gz)$/gi, '').replace(/[-_]+/g, ' ').trim() || 'Imported list';

    let results: ListFetchResult[];
    try {
      if (['myanimelist', 'anilist', 'simkl'].includes(meta.provider)) await ctx.animeIds.load();
      results = parseUpload(meta.provider, file.filename, file.data, baseName, meta.name, ctx.animeIds);
    } catch (err) {
      if (err instanceof UploadError) throw new ApiError(400, 'invalid_file', err.message);
      throw err;
    }

    const lists = [];
    if (meta.replaceListId) {
      const target = ctx.lists.getOwned(meta.replaceListId, u.id);
      if (!target || target.provider !== meta.provider) throw new ApiError(404, 'not_found', 'List not found.');
      // A full export holds several lists: use the one this list came from.
      const match = results.length === 1 ? results[0] : results.find((r) => r.info.externalId === target.external_id);
      if (!match) throw new ApiError(400, 'ambiguous', 'To update one list, upload that list’s own file rather than the full export.');
      const applied = ctx.lists.applyItems(target.id, match);
      lists.push({ ...listView(ctx, ctx.lists.get(target.id)!), applied });
    } else {
      for (const r of results) {
        const id = ctx.lists.upsert(u.id, meta.provider, r.info, { autoSync: false, syncSupported: false });
        const applied = ctx.lists.applyItems(id, r);
        lists.push({ ...listView(ctx, ctx.lists.get(id)!), applied });
      }
      ctx.activity.add(u.id, 'list_imported', `Imported ${results.length === 1 ? `“${results[0]!.info.name}”` : `${results.length} lists`} from ${PROVIDER_LABEL[meta.provider]}.`);
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
      z.object({
        name: z.string().trim().min(1).max(120).optional(),
        description: z.string().trim().max(2000).nullable().optional(),
        autoSync: z.boolean().optional(),
        display: z.enum(['auto', 'grid', 'timeline']).optional(),
      }),
      req.body,
    );
    const l = ctx.lists.getOwned(id, u.id);
    if (!l) throw new ApiError(404, 'not_found', 'List not found.');
    if (body.name) ctx.lists.rename(id, body.name);
    if (body.description !== undefined) {
      if (l.provider !== LOCAL_PROVIDER) throw new ApiError(400, 'not_editable', 'Only lists created in JellyWatcher have an editable description.');
      ctx.lists.setDescription(id, body.description || null);
    }
    if (body.autoSync !== undefined) ctx.lists.setAutoSync(id, body.autoSync);
    if (body.display) ctx.lists.setDisplay(id, body.display);
    return { list: listView(ctx, ctx.lists.get(id)!) };
  });

  // ---- Local lists: create, duplicate, edit ------------------------------------------------
  const ownedList = (userId: number, id: number) => {
    const l = ctx.lists.getOwned(id, userId);
    if (!l) throw new ApiError(404, 'not_found', 'List not found.');
    return l;
  };
  const editableList = (userId: number, id: number) => {
    const l = ownedList(userId, id);
    if (l.provider !== LOCAL_PROVIDER) {
      throw new ApiError(400, 'not_editable', 'Entries of a synced list come from its source. Duplicate the list to edit it here.');
    }
    return l;
  };

  app.post('/lists/local', async (req) => {
    const u = requireUser(req);
    const body = parse(z.object({ name: z.string().trim().min(1).max(120), description: z.string().trim().max(2000).optional() }), req.body);
    const id = ctx.lists.createLocal(u.id, body.name, body.description || null);
    ctx.activity.add(u.id, 'list_created', `Created the list “${body.name}”.`);
    return { list: listView(ctx, ctx.lists.get(id)!) };
  });

  app.post('/lists/:id/duplicate', async (req) => {
    const u = requireUser(req);
    const { id } = parse(IdParam, req.params);
    const body = parse(z.object({ name: z.string().trim().min(1).max(120).optional() }), req.body ?? {});
    const src = ownedList(u.id, id);
    const name = body.name || `${src.name} (Copy)`.slice(0, 120);
    const newId = ctx.lists.duplicate(id, u.id, name);
    ctx.activity.add(u.id, 'list_created', `Duplicated “${src.name}” as “${name}”.`);
    const l = ctx.lists.get(newId)!;
    return { list: listView(ctx, l, buildTimelines(ctx, u, [l]).get(l.id)?.summary) };
  });

  /** Saves the person's own order (drag and drop). Works for every list and survives syncs. */
  app.put('/lists/:id/order', async (req) => {
    const u = requireUser(req);
    const { id } = parse(IdParam, req.params);
    const body = parse(z.object({ itemIds: z.array(z.number().int().positive()).max(20_000) }), req.body);
    ownedList(u.id, id);
    const ordered = ctx.lists.setOrder(id, body.itemIds);
    return { ordered, list: listView(ctx, ctx.lists.get(id)!) };
  });

  app.delete('/lists/:id/order', async (req) => {
    const u = requireUser(req);
    const { id } = parse(IdParam, req.params);
    ownedList(u.id, id);
    ctx.lists.resetOrder(id);
    return { list: listView(ctx, ctx.lists.get(id)!) };
  });

  /**
   * Sorts the list automatically and saves it as the person's order: release order (a timeline for
   * lists without an order of their own), newest first, title or runtime. Can be adjusted by hand.
   */
  app.post('/lists/:id/order/auto', async (req) => {
    const u = requireUser(req);
    const { id } = parse(IdParam, req.params);
    const body = parse(z.object({ by: z.enum(['release', 'release_desc', 'title', 'runtime']).default('release') }), req.body ?? {});
    const l = ownedList(u.id, id);
    const t = buildTimelines(ctx, u, [l]).get(l.id)!;
    const dates = entryReleaseDates(ctx, t.entries);
    const ordered = ctx.lists.setOrder(id, autoOrder(t.entries, body.by, dates));
    const unknown = body.by.startsWith('release') ? [...dates.values()].filter((d) => d === null).length : 0;
    return { ordered, withoutDate: unknown, list: listView(ctx, ctx.lists.get(id)!) };
  });

  app.post('/lists/:id/items', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const u = requireUser(req);
    const { id } = parse(IdParam, req.params);
    const body = parse(
      z.object({
        tmdbId: z.number().int().positive(),
        mediaType: z.enum(['movie', 'tv']),
        title: z.string().trim().min(1).max(300),
        year: z.number().int().min(1870).max(2200).nullable().optional(),
        posterPath: z.string().regex(/^\/[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$/i).nullable().optional(),
        overview: z.string().max(5000).nullable().optional(),
        season: z.number().int().min(0).max(500).nullable().optional(),
        episode: z.number().int().min(1).max(5000).nullable().optional(),
        episodeTitle: z.string().trim().max(300).nullable().optional(),
      }),
      req.body,
    );
    editableList(u.id, id);
    if (body.mediaType === 'movie' && body.season != null) throw new ApiError(400, 'invalid_scope', 'Movies have no seasons or episodes.');
    if (body.episode != null && body.season == null) throw new ApiError(400, 'invalid_scope', 'Choose the season of that episode.');
    const titleId = ctx.titles.ensure({
      mediaType: body.mediaType,
      tmdbId: body.tmdbId,
      title: body.title,
      year: body.year ?? null,
      posterPath: body.posterPath ?? null,
      overview: body.overview ?? null,
      source: 'manual',
    });
    const itemId = ctx.lists.addLocalItem(id, { titleId, mediaType: body.mediaType, title: body.title, year: body.year ?? null, tmdbId: body.tmdbId, season: body.season, episode: body.episode, episodeTitle: body.episodeTitle });
    if (itemId < 0) throw new ApiError(409, 'already_in_list', 'That is already on this list.');
    void triggerJob(ctx, 'metadata', 'event');
    return { itemId, list: listView(ctx, ctx.lists.get(id)!) };
  });

  app.delete('/lists/:id/items/:itemId', async (req) => {
    const u = requireUser(req);
    const p = parse(z.object({ id: z.coerce.number().int().positive(), itemId: z.coerce.number().int().positive() }), req.params);
    editableList(u.id, p.id);
    if (!ctx.lists.removeItem(p.id, p.itemId)) throw new ApiError(404, 'not_found', 'Entry not found.');
    return { list: listView(ctx, ctx.lists.get(p.id)!) };
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
