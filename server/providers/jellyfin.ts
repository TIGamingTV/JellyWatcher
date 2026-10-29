import crypto from 'node:crypto';
import { z } from 'zod';
import { HttpClient, type FetchLike } from '../http/client.js';
import { ProviderError } from '../http/errors.js';

/**
 * Jellyfin API adapter (12.x, compatible with 10.10+). Uses only the
 * `Authorization: MediaBrowser ...` header, since legacy X-Emby-Token / api_key auth is disabled in 12.0.
 * JellyWatcher never writes library data to Jellyfin. The only other calls are sign-in / sign-out
 * (password and Quick Connect) and, once during the guided setup, creating its own API key.
 */

const CLIENT = 'JellyWatcher';
const PAGE = 400;

const q = (v: string) => `"${encodeURIComponent(v)}"`;

export function mediaBrowserHeader(opts: { token?: string; deviceId: string; version: string; device?: string }): string {
  const parts = [`Client=${q(CLIENT)}`, `Device=${q(opts.device ?? 'JellyWatcher Server')}`, `DeviceId=${q(opts.deviceId)}`, `Version=${q(opts.version)}`];
  if (opts.token) parts.push(`Token=${q(opts.token)}`);
  return `MediaBrowser ${parts.join(', ')}`;
}

const ProviderIds = z.record(z.string(), z.string().nullish()).nullish();
const UserData = z
  .object({
    Played: z.boolean().nullish(),
    PlayCount: z.number().nullish(),
    PlayedPercentage: z.number().nullish(),
    UnplayedItemCount: z.number().nullish(),
    PlaybackPositionTicks: z.number().nullish(),
    LastPlayedDate: z.string().nullish(),
    IsFavorite: z.boolean().nullish(),
  })
  .nullish();
const Item = z.object({
  Id: z.string(),
  Name: z.string().nullish(),
  ServerId: z.string().nullish(),
  Type: z.string().nullish(),
  ProductionYear: z.number().nullish(),
  ProviderIds,
  ImageTags: z.record(z.string(), z.string()).nullish(),
  DateCreated: z.string().nullish(),
  RecursiveItemCount: z.number().nullish(),
  ChildCount: z.number().nullish(),
  RunTimeTicks: z.number().nullish(),
  Overview: z.string().nullish(),
  Genres: z.array(z.string()).nullish(),
  SeriesId: z.string().nullish(),
  SeriesName: z.string().nullish(),
  ParentIndexNumber: z.number().nullish(),
  IndexNumber: z.number().nullish(),
  UserData,
});
export type JellyfinItemJson = z.infer<typeof Item>;
const ItemsResult = z.object({ Items: z.array(z.unknown()), TotalRecordCount: z.number().nullish(), StartIndex: z.number().nullish() });

const User = z.object({ Id: z.string(), Name: z.string(), Policy: z.object({ IsAdministrator: z.boolean().nullish(), IsDisabled: z.boolean().nullish() }).nullish() });
export type JellyfinUserJson = z.infer<typeof User>;

/** A Jellyfin sign-in session (password or Quick Connect). */
export interface JellyfinSignIn {
  token: string;
  deviceId: string;
  userId: string;
  name: string;
  isAdmin: boolean;
  disabled: boolean;
}

export interface NormalizedJellyfinItem {
  id: string;
  serverId: string | null;
  mediaType: 'movie' | 'tv';
  name: string;
  year: number | null;
  tmdbId: number | null;
  imdbId: string | null;
  tvdbId: number | null;
  imageTag: string | null;
  dateCreated: string | null;
  episodeCount: number | null;
  /** Movie runtime, or the typical episode runtime of a series. */
  runtimeTicks: number | null;
  overview: string | null;
  genres: string[];
}

function providerId(ids: Record<string, string | null | undefined> | null | undefined, key: string): string | null {
  if (!ids) return null;
  const hit = Object.entries(ids).find(([k]) => k.toLowerCase() === key);
  const v = hit?.[1]?.trim();
  return v ? v : null;
}

const toNum = (v: string | null) => (v && /^\d+$/.test(v) ? Number(v) : null);

export function normalizeItem(raw: unknown): NormalizedJellyfinItem | null {
  const p = Item.safeParse(raw);
  if (!p.success) return null;
  const i = p.data;
  const mediaType = i.Type === 'Movie' ? 'movie' : i.Type === 'Series' ? 'tv' : null;
  if (!mediaType) return null;
  const imdb = providerId(i.ProviderIds, 'imdb');
  return {
    id: i.Id,
    serverId: i.ServerId ?? null,
    mediaType,
    name: i.Name ?? 'Untitled',
    year: i.ProductionYear ?? null,
    tmdbId: toNum(providerId(i.ProviderIds, 'tmdb')),
    imdbId: imdb && /^tt\d+$/.test(imdb) ? imdb : null,
    tvdbId: toNum(providerId(i.ProviderIds, 'tvdb')),
    imageTag: i.ImageTags?.Primary ?? null,
    dateCreated: i.DateCreated ?? null,
    episodeCount: mediaType === 'tv' ? (i.RecursiveItemCount ?? null) : null,
    runtimeTicks: i.RunTimeTicks ?? null,
    overview: i.Overview ?? null,
    genres: i.Genres ?? [],
  };
}

export interface NormalizedUserData {
  itemId: string;
  played: boolean;
  playCount: number | null;
  playedPercentage: number | null;
  unplayedCount: number | null;
  positionTicks: number | null;
  runtimeTicks: number | null;
  lastPlayedAt: string | null;
  isFavorite: boolean;
  episodeCount: number | null;
}

export function normalizeUserData(raw: unknown): NormalizedUserData | null {
  const p = Item.safeParse(raw);
  if (!p.success || !p.data.UserData) return null;
  const u = p.data.UserData;
  return {
    itemId: p.data.Id,
    played: u.Played ?? false,
    playCount: u.PlayCount ?? null,
    playedPercentage: u.PlayedPercentage ?? null,
    unplayedCount: u.UnplayedItemCount ?? null,
    positionTicks: u.PlaybackPositionTicks ?? null,
    runtimeTicks: p.data.RunTimeTicks ?? null,
    lastPlayedAt: u.LastPlayedDate ?? null,
    isFavorite: u.IsFavorite ?? false,
    episodeCount: p.data.Type === 'Series' ? (p.data.RecursiveItemCount ?? null) : null,
  };
}

export interface NormalizedEpisode {
  id: string;
  season: number;
  episode: number;
  /** Last episode number for multi-episode files (S01E01-E02), else the same as episode. */
  episodeEnd: number;
  runtimeTicks: number | null;
  played: boolean;
  lastPlayedAt: string | null;
}

export function normalizeEpisode(raw: unknown): NormalizedEpisode | null {
  const p = Item.extend({ IndexNumberEnd: z.number().nullish(), LocationType: z.string().nullish() }).safeParse(raw);
  if (!p.success) return null;
  const e = p.data;
  if (e.Type !== 'Episode' || e.ParentIndexNumber == null || e.IndexNumber == null) return null;
  if (e.LocationType === 'Virtual') return null; // missing-episode placeholders are not in the library
  return {
    id: e.Id,
    season: e.ParentIndexNumber,
    episode: e.IndexNumber,
    episodeEnd: Math.max(e.IndexNumber, e.IndexNumberEnd ?? e.IndexNumber),
    runtimeTicks: e.RunTimeTicks ?? null,
    played: e.UserData?.Played ?? false,
    lastPlayedAt: e.UserData?.LastPlayedDate ?? null,
  };
}

export class JellyfinClient {
  readonly http: HttpClient;

  constructor(
    readonly baseUrl: string,
    private readonly apiKey: string | null,
    private readonly deviceId: string,
    private readonly version: string,
    fetchImpl?: FetchLike,
  ) {
    this.http = new HttpClient({
      provider: 'jellyfin',
      baseUrl,
      headers: () => ({ Authorization: mediaBrowserHeader({ token: this.apiKey ?? undefined, deviceId, version }) }),
      timeoutMs: 30_000,
      fetchImpl,
    });
  }

  async publicInfo() {
    const res = await this.http.get('/System/Info/Public', undefined, { retries: 0 });
    const parsed = z.object({ ServerName: z.string().nullish(), Version: z.string().nullish(), Id: z.string().nullish(), ProductName: z.string().nullish() }).safeParse(res.data);
    if (!parsed.success) throw new ProviderError('jellyfin', 'invalid_response', 'The address responded, but not like a Jellyfin server.');
    return parsed.data;
  }

  async systemInfo() {
    const res = await this.http.get('/System/Info', undefined, { retries: 0 });
    return z.object({ ServerName: z.string().nullish(), Version: z.string().nullish(), Id: z.string().nullish() }).parse(res.data);
  }

  async users(): Promise<JellyfinUserJson[]> {
    const res = await this.http.get('/Users');
    return z.array(User).parse(res.data);
  }

  /** Device id for one person's sign-in, so their Jellyfin sessions don't replace each other. */
  signInDeviceId(seed: string): string {
    return `${this.deviceId}-${crypto.createHash('sha256').update(seed.toLowerCase()).digest('hex').slice(0, 12)}`;
  }

  private anonymous(deviceId: string, device = 'JellyWatcher Sign-In') {
    return { Authorization: mediaBrowserHeader({ deviceId, version: this.version, device }) };
  }

  private asSession(token: string, deviceId: string, device = 'JellyWatcher Sign-In') {
    return { Authorization: mediaBrowserHeader({ deviceId, version: this.version, device, token }) };
  }

  private parseAuth(data: unknown, deviceId: string): JellyfinSignIn {
    const d = z.object({ AccessToken: z.string(), User: User }).parse(data);
    return { token: d.AccessToken, deviceId, userId: d.User.Id, name: d.User.Name, isAdmin: d.User.Policy?.IsAdministrator ?? false, disabled: d.User.Policy?.IsDisabled ?? false };
  }

  /** Signs in with a username and password. The caller must end the returned session. */
  async authenticateByName(username: string, password: string, deviceId = this.signInDeviceId(username)): Promise<JellyfinSignIn> {
    try {
      const res = await this.http.request({ method: 'POST', path: '/Users/AuthenticateByName', body: { Username: username, Pw: password }, headers: this.anonymous(deviceId) });
      return this.parseAuth(res.data, deviceId);
    } catch (err) {
      if (err instanceof ProviderError && (err.status === 401 || err.status === 400)) {
        throw new ProviderError('jellyfin', 'auth', 'Jellyfin rejected that username or password.');
      }
      throw err;
    }
  }

  /** Ends a sign-in session; JellyWatcher keeps no Jellyfin user tokens. */
  async endSession(s: Pick<JellyfinSignIn, 'token' | 'deviceId'>): Promise<void> {
    await this.http.request({ method: 'POST', path: '/Sessions/Logout', headers: this.asSession(s.token, s.deviceId) }).catch(() => undefined);
  }

  /**
   * Verifies a person's Jellyfin credentials. The resulting session token is revoked immediately;
   * only the user id is kept.
   */
  async verifyCredentials(username: string, password: string): Promise<{ userId: string; name: string; isAdmin: boolean }> {
    const s = await this.authenticateByName(username, password);
    await this.endSession(s);
    return { userId: s.userId, name: s.name, isAdmin: s.isAdmin };
  }

  /** Whether Quick Connect is turned on in Jellyfin (Dashboard › General › Quick Connect). */
  async quickConnectEnabled(): Promise<boolean> {
    const res = await this.http.request({ path: '/QuickConnect/Enabled', headers: this.anonymous(this.deviceId), retries: 0, timeoutMs: 4000 });
    return res.data === true || res.data === 'true';
  }

  /** Starts a Quick Connect request: the code is entered in a signed-in Jellyfin app to approve it. */
  async quickConnectInitiate(deviceId: string): Promise<{ secret: string; code: string }> {
    try {
      const res = await this.http.request({ method: 'POST', path: '/QuickConnect/Initiate', headers: this.anonymous(deviceId) });
      const d = z.object({ Secret: z.string(), Code: z.string() }).parse(res.data);
      return { secret: d.Secret, code: d.Code };
    } catch (err) {
      if (err instanceof ProviderError && (err.status === 401 || err.status === 403)) {
        throw new ProviderError('jellyfin', 'forbidden', 'Quick Connect is turned off on this Jellyfin server. Turn it on in Jellyfin › Dashboard › General.');
      }
      throw err;
    }
  }

  /** 'pending' until approved in Jellyfin, 'expired' once Jellyfin forgot the request. */
  async quickConnectState(secret: string, deviceId: string): Promise<'pending' | 'approved' | 'expired'> {
    try {
      const res = await this.http.request({ path: '/QuickConnect/Connect', query: { secret }, headers: this.anonymous(deviceId), retries: 0 });
      return z.object({ Authenticated: z.boolean().nullish() }).parse(res.data).Authenticated ? 'approved' : 'pending';
    } catch (err) {
      if (err instanceof ProviderError && (err.status === 404 || err.status === 400 || err.status === 401)) return 'expired';
      throw err;
    }
  }

  /** Completes an approved Quick Connect request. The caller must end the returned session. */
  async authenticateWithQuickConnect(secret: string, deviceId: string): Promise<JellyfinSignIn> {
    const res = await this.http.request({ method: 'POST', path: '/Users/AuthenticateWithQuickConnect', body: { Secret: secret }, headers: this.anonymous(deviceId) });
    return this.parseAuth(res.data, deviceId);
  }

  /** Creates a server API key with an administrator's session (used by the guided setup). */
  async createApiKey(s: Pick<JellyfinSignIn, 'token' | 'deviceId'>, app = CLIENT): Promise<string> {
    const headers = this.asSession(s.token, s.deviceId);
    await this.http.request({ method: 'POST', path: '/Auth/Keys', query: { app }, headers });
    const res = await this.http.request({ path: '/Auth/Keys', headers });
    const keys = z
      .object({ Items: z.array(z.object({ AccessToken: z.string(), AppName: z.string().nullish(), DateCreated: z.string().nullish() })) })
      .parse(res.data)
      .Items.filter((k) => k.AppName === app)
      .sort((a, b) => (b.DateCreated ?? '').localeCompare(a.DateCreated ?? ''));
    if (!keys[0]) throw new ProviderError('jellyfin', 'invalid_response', 'Jellyfin did not return the new API key.');
    return keys[0].AccessToken;
  }

  /** Iterates the whole movie + series library page by page. */
  async *libraryPages(userId?: string): AsyncGenerator<{ items: unknown[]; total: number }> {
    for (let start = 0; ; start += PAGE) {
      const res = await this.http.get('/Items', {
        includeItemTypes: 'Movie,Series',
        recursive: true,
        fields: 'ProviderIds,DateCreated,RecursiveItemCount,Overview,Genres',
        enableUserData: Boolean(userId),
        enableImageTypes: 'Primary',
        imageTypeLimit: 1,
        startIndex: start,
        limit: PAGE,
        sortBy: 'SortName',
        sortOrder: 'Ascending',
        enableTotalRecordCount: true,
        ...(userId ? { userId } : {}),
      });
      const data = ItemsResult.safeParse(res.data);
      if (!data.success) throw new ProviderError('jellyfin', 'invalid_response');
      yield { items: data.data.Items, total: data.data.TotalRecordCount ?? 0 };
      if (data.data.Items.length < PAGE) break;
    }
  }

  /** Every episode of a series, with the user's played state when a user id is given. */
  async episodes(seriesId: string, userId?: string): Promise<NormalizedEpisode[]> {
    const res = await this.http.get(`/Shows/${encodeURIComponent(seriesId)}/Episodes`, {
      fields: 'ProviderIds',
      enableUserData: Boolean(userId),
      enableImages: false,
      ...(userId ? { userId } : {}),
    });
    const data = ItemsResult.safeParse(res.data);
    if (!data.success) throw new ProviderError('jellyfin', 'invalid_response');
    return data.data.Items.map(normalizeEpisode).filter((e): e is NormalizedEpisode => e !== null);
  }

  async image(itemId: string, opts: { tag?: string; maxWidth: number }): Promise<{ data: Buffer; contentType: string }> {
    const res = await this.http.request<Buffer>({
      path: `/Items/${encodeURIComponent(itemId)}/Images/Primary`,
      query: { maxWidth: opts.maxWidth, quality: 85, ...(opts.tag ? { tag: opts.tag } : {}) },
      responseType: 'buffer',
      headers: { Accept: 'image/*' },
    });
    return { data: res.data, contentType: res.headers.get('content-type') ?? 'image/jpeg' };
  }

  webUrl(itemId: string, serverId: string | null, publicBase?: string | null): string {
    const base = (publicBase || this.baseUrl).replace(/\/+$/, '');
    return `${base}/web/#/details?id=${encodeURIComponent(itemId)}${serverId ? `&serverId=${encodeURIComponent(serverId)}` : ''}`;
  }
}
