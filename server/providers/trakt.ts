import { z } from 'zod';
import { HttpClient, type FetchLike } from '../http/client.js';
import { ProviderError } from '../http/errors.js';
import type { ListFetchResult, SourceItem, SourceListInfo } from './types.js';

/**
 * Trakt API v2 adapter.
 * Verified 2026-10: base https://api.trakt.tv, OAuth on https://auth.trakt.tv, headers trakt-api-key +
 * trakt-api-version: 2, page limit max 250, 500 GET / 5 min rate limit, single-use refresh tokens.
 */

export const TRAKT_API = 'https://api.trakt.tv';
export const TRAKT_AUTH = 'https://auth.trakt.tv';
const PAGE_LIMIT = 250;
const MAX_PAGES = 100;
/** Extended info adds runtimes, used for a list's total watch time. */
const FULL = { extended: 'full' };

const Ids = z.object({
  trakt: z.number().nullish(),
  slug: z.string().nullish(),
  imdb: z.string().nullish(),
  tmdb: z.number().nullish(),
  tvdb: z.number().nullish(),
});
const Media = z.object({ title: z.string().nullish(), year: z.number().nullish(), ids: Ids, runtime: z.number().nullish(), aired_episodes: z.number().nullish() });
const Season = z.object({ number: z.number().nullish(), ids: Ids.partial().nullish(), episode_count: z.number().nullish() });
const Episode = z.object({ season: z.number().nullish(), number: z.number().nullish(), title: z.string().nullish(), ids: Ids.partial().nullish(), runtime: z.number().nullish() });
const ListEntry = z.object({
  rank: z.number().nullish(),
  id: z.number().nullish(),
  listed_at: z.string().nullish(),
  notes: z.string().nullish(),
  type: z.string(),
  movie: Media.nullish(),
  show: Media.nullish(),
  season: Season.nullish(),
  episode: Episode.nullish(),
});
const TraktUser = z.object({ username: z.string().nullish(), name: z.string().nullish(), ids: z.object({ slug: z.string().nullish() }).nullish() });
const TraktList = z.object({
  name: z.string(),
  description: z.string().nullish(),
  privacy: z.string().nullish(),
  item_count: z.number().nullish(),
  likes: z.number().nullish(),
  ids: z.object({ trakt: z.number(), slug: z.string().nullish() }),
  user: TraktUser.nullish(),
});

export type TraktListJson = z.infer<typeof TraktList>;

export interface TraktTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scope?: string;
}

const TokenResponse = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
  created_at: z.number().optional(),
  scope: z.string().optional(),
});

export function tokensFromResponse(raw: unknown): TraktTokens {
  const t = TokenResponse.parse(raw);
  const created = t.created_at ? t.created_at * 1000 : Date.now();
  return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: new Date(created + t.expires_in * 1000).toISOString(), scope: t.scope };
}

export type DevicePollResult =
  | { status: 'authorized'; tokens: TraktTokens }
  | { status: 'pending' | 'slow_down' | 'expired' | 'denied' | 'invalid' | 'used' };

export interface TraktListRef {
  kind: 'user_list' | 'list_id' | 'user_watchlist';
  user?: string;
  list?: string;
  id?: string;
}

/** Parses trakt.tv / app.trakt.tv list URLs. Returns null if the URL is not a Trakt list. */
export function parseTraktListUrl(input: string): TraktListRef | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (!/^(www\.|app\.)?trakt\.tv$/i.test(url.hostname)) return null;
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const safe = (s: string | undefined) => (s && /^[\w.\-~@]+$/.test(s) ? s : undefined);
  if (parts[0] === 'users' && parts[2] === 'lists' && safe(parts[1]) && safe(parts[3])) {
    return { kind: 'user_list', user: parts[1], list: parts[3] };
  }
  if (parts[0] === 'users' && parts[2] === 'watchlist' && safe(parts[1])) return { kind: 'user_watchlist', user: parts[1] };
  if (parts[0] === 'lists' && parts[1] && /^\d+$/.test(parts[1])) return { kind: 'list_id', id: parts[1] };
  return null;
}

/**
 * Parses list / watchlist entries. Movies and shows map to titles; seasons and episodes map to their
 * show with the season (and episode) number, so watch-order lists keep every step. Entries without a
 * rank keep the order the API returned them in.
 */
export function parseEntries(raw: unknown): { items: SourceItem[]; skipped: number } {
  if (!Array.isArray(raw)) throw new ProviderError('trakt', 'invalid_response');
  const items: SourceItem[] = [];
  let skipped = 0;
  raw.forEach((row, index) => {
    const parsed = ListEntry.safeParse(row);
    if (!parsed.success) {
      skipped++;
      return;
    }
    const e = parsed.data;
    const media = e.type === 'movie' ? e.movie : ['show', 'season', 'episode'].includes(e.type) ? e.show : null;
    if (!media || !media.title) {
      skipped++;
      return;
    }
    const base = {
      title: media.title,
      year: media.year ?? null,
      tmdbId: media.ids.tmdb ?? null,
      imdbId: media.ids.imdb ?? null,
      tvdbId: media.ids.tvdb ?? null,
      position: e.rank ?? index + 1,
      listedAt: e.listed_at ?? null,
      notes: e.notes ?? null,
    };
    const slug = media.ids.slug;
    const showKey = media.ids.trakt ?? slug ?? media.title;
    if (e.type === 'movie') {
      items.push({ ...base, sourceKey: `movie:${showKey}`, mediaType: 'movie', runtime: media.runtime ?? null, sourceUrl: slug ? `https://trakt.tv/movies/${slug}` : null });
    } else if (e.type === 'show') {
      items.push({ ...base, sourceKey: `show:${showKey}`, mediaType: 'tv', runtime: media.runtime ?? null, episodes: media.aired_episodes ?? null, sourceUrl: slug ? `https://trakt.tv/shows/${slug}` : null });
    } else if (e.type === 'season') {
      const n = e.season?.number;
      if (n == null) {
        skipped++;
        return;
      }
      items.push({
        ...base,
        sourceKey: `season:${e.season?.ids?.trakt ?? `${showKey}:${n}`}`,
        mediaType: 'tv',
        seasonNumber: n,
        episodes: e.season?.episode_count ?? null,
        runtime: media.runtime ?? null,
        sourceUrl: slug ? `https://trakt.tv/shows/${slug}/seasons/${n}` : null,
      });
    } else {
      const s = e.episode?.season;
      const n = e.episode?.number;
      if (s == null || n == null) {
        skipped++;
        return;
      }
      items.push({
        ...base,
        sourceKey: `episode:${e.episode?.ids?.trakt ?? `${showKey}:${s}x${n}`}`,
        mediaType: 'tv',
        seasonNumber: s,
        episodeNumber: n,
        episodeTitle: e.episode?.title ?? null,
        runtime: e.episode?.runtime ?? media.runtime ?? null,
        sourceUrl: slug ? `https://trakt.tv/shows/${slug}/seasons/${s}/episodes/${n}` : null,
      });
    }
  });
  return { items, skipped };
}

export function listInfoFromJson(l: TraktListJson, kind: SourceListInfo['kind']): SourceListInfo {
  const owner = l.user?.ids?.slug ?? l.user?.username ?? null;
  return {
    externalId: `list:${l.ids.trakt}`,
    name: l.name,
    kind,
    description: l.description ?? null,
    ownerName: l.user?.name || l.user?.username || owner,
    url: owner && l.ids.slug ? `https://trakt.tv/users/${owner}/lists/${l.ids.slug}` : `https://trakt.tv/lists/${l.ids.trakt}`,
    itemCount: l.item_count ?? null,
    likes: l.likes ?? null,
  };
}

export class TraktClient {
  readonly api: HttpClient;
  private readonly auth: HttpClient;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string | undefined,
    fetchImpl?: FetchLike,
  ) {
    const headers = () => ({ 'trakt-api-key': clientId, 'trakt-api-version': '2' });
    this.api = new HttpClient({ provider: 'trakt', baseUrl: TRAKT_API, headers, minIntervalMs: 650, retries: 3, fetchImpl });
    this.auth = new HttpClient({ provider: 'trakt', baseUrl: TRAKT_AUTH, headers, fetchImpl });
  }

  private bearer(token?: string): Record<string, string> {
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async deviceCode() {
    const res = await this.auth.post('/oauth/device/code', { client_id: this.clientId });
    return z
      .object({ device_code: z.string(), user_code: z.string(), verification_url: z.string(), expires_in: z.number(), interval: z.number() })
      .parse(res.data);
  }

  async pollDevice(deviceCode: string): Promise<DevicePollResult> {
    const res = await this.auth.post(
      '/oauth/device/token',
      { code: deviceCode, client_id: this.clientId, ...(this.clientSecret ? { client_secret: this.clientSecret } : {}) },
      { acceptStatus: [400, 404, 409, 410, 418, 429] },
    );
    switch (res.status) {
      case 200:
        return { status: 'authorized', tokens: tokensFromResponse(res.data) };
      case 400:
        return { status: 'pending' };
      case 404:
        return { status: 'invalid' };
      case 409:
        return { status: 'used' };
      case 410:
        return { status: 'expired' };
      case 418:
        return { status: 'denied' };
      default:
        return { status: 'slow_down' };
    }
  }

  async refresh(refreshToken: string): Promise<TraktTokens> {
    try {
      const res = await this.auth.post('/oauth/token', {
        refresh_token: refreshToken,
        client_id: this.clientId,
        ...(this.clientSecret ? { client_secret: this.clientSecret } : {}),
        grant_type: 'refresh_token',
      });
      return tokensFromResponse(res.data);
    } catch (err) {
      if (err instanceof ProviderError && (err.status === 400 || err.status === 401)) {
        throw new ProviderError('trakt', 'auth', 'Trakt sign-in expired. Connect your Trakt account again.', { status: err.status });
      }
      throw err;
    }
  }

  async revoke(accessToken: string): Promise<void> {
    await this.auth.post('/oauth/revoke', { token: accessToken, client_id: this.clientId, ...(this.clientSecret ? { client_secret: this.clientSecret } : {}) });
  }

  async settings(token: string) {
    const res = await this.api.get('/users/settings', undefined, { headers: this.bearer(token) });
    return z
      .object({
        user: z.object({ username: z.string(), name: z.string().nullish(), ids: z.object({ slug: z.string() }), vip: z.boolean().nullish() }),
        limits: z.unknown().optional(),
      })
      .parse(res.data);
  }

  /** Paginates an endpoint until the last page. Always sends page + limit as Trakt requires. */
  async paginate(path: string, token?: string, query: Record<string, string> = {}): Promise<unknown[]> {
    const out: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await this.api.get<unknown[]>(path, { page, limit: PAGE_LIMIT, ...query }, { headers: this.bearer(token) });
      if (!Array.isArray(res.data)) throw new ProviderError('trakt', 'invalid_response');
      out.push(...res.data);
      const pageCount = Number(res.headers.get('x-pagination-page-count') ?? '1');
      if (res.data.length === 0 || page >= pageCount) break;
    }
    return out;
  }

  // All types in one request so `rank` is one ordering across movies, shows, seasons and episodes.
  async watchlist(token: string): Promise<ListFetchResult> {
    const r = parseEntries(await this.paginate('/sync/watchlist', token, FULL));
    return { info: { externalId: 'watchlist', name: 'Trakt Watchlist', kind: 'watchlist', url: 'https://trakt.tv/users/me/watchlist' }, ...r };
  }

  async publicUserWatchlist(user: string, token?: string): Promise<ListFetchResult> {
    const u = encodeURIComponent(user);
    const r = parseEntries(await this.paginate(`/users/${u}/watchlist`, token, FULL));
    return { info: { externalId: `watchlist:${user.toLowerCase()}`, name: `${user}’s Watchlist`, kind: 'public', ownerName: user, url: `https://trakt.tv/users/${u}/watchlist` }, ...r };
  }

  async myLists(token: string): Promise<SourceListInfo[]> {
    const res = await this.api.get('/users/me/lists', undefined, { headers: this.bearer(token) });
    return z.array(TraktList).parse(res.data).map((l) => listInfoFromJson(l, 'owned'));
  }

  async likedLists(token: string): Promise<SourceListInfo[]> {
    const rows = await this.paginate('/users/likes/lists', token);
    return rows
      .map((r) => z.object({ list: TraktList }).safeParse(r))
      .filter((r) => r.success)
      .map((r) => listInfoFromJson(r.data.list, 'liked'));
  }

  async listInfo(ref: TraktListRef, token?: string): Promise<TraktListJson> {
    const path = ref.kind === 'list_id' ? `/lists/${encodeURIComponent(ref.id!)}` : `/users/${encodeURIComponent(ref.user!)}/lists/${encodeURIComponent(ref.list!)}`;
    const res = await this.api.get(path, undefined, { headers: this.bearer(token) });
    const parsed = TraktList.safeParse(res.data);
    if (!parsed.success) throw new ProviderError('trakt', 'invalid_response');
    return parsed.data;
  }

  /** Items of a list by its numeric Trakt id. Public lists need only the client id. */
  async listItems(traktListId: number, token?: string, ownerSlug?: string): Promise<{ items: SourceItem[]; skipped: number }> {
    // The /lists/{id} route only serves public lists; for the user's own (possibly private) lists
    // use the /users/{slug}/lists/{id} route with the user's token.
    const path = ownerSlug && token ? `/users/${encodeURIComponent(ownerSlug)}/lists/${traktListId}/items` : `/lists/${traktListId}/items`;
    return parseEntries(await this.paginate(path, token, FULL));
  }

  async searchLists(query: string): Promise<SourceListInfo[]> {
    const res = await this.api.get('/search/list', { query, page: 1, limit: 30 });
    return this.parseWrappedLists(res.data, 'public');
  }

  async trendingLists(): Promise<SourceListInfo[]> {
    const res = await this.api.get('/lists/trending', { page: 1, limit: 30 });
    return this.parseWrappedLists(res.data, 'public');
  }

  async popularLists(): Promise<SourceListInfo[]> {
    const res = await this.api.get('/lists/popular', { page: 1, limit: 30 });
    return this.parseWrappedLists(res.data, 'public');
  }

  private parseWrappedLists(data: unknown, kind: SourceListInfo['kind']): SourceListInfo[] {
    if (!Array.isArray(data)) throw new ProviderError('trakt', 'invalid_response');
    return data
      .map((r) => z.object({ list: TraktList }).safeParse(r))
      .filter((r) => r.success)
      .map((r) => listInfoFromJson(r.data.list, kind));
  }
}
