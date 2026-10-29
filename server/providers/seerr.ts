import { z } from 'zod';
import { HttpClient, type FetchLike } from '../http/client.js';
import { ProviderError } from '../http/errors.js';
import type { MatchCandidate, MediaType } from '../domain/matching.js';

/**
 * Seerr (Overseerr / Jellyseerr compatible) API adapter. Verified against seerr-team/seerr v3.5:
 *  - base {url}/api/v1, header X-Api-Key; X-API-User acts on behalf of another Seerr user
 *  - POST /request: 201 created, 202 no seasons available, 403 permission/quota/blocklist, 409 duplicate
 */

const MediaInfo = z.object({
  id: z.number().nullish(),
  tmdbId: z.number().nullish(),
  tvdbId: z.number().nullish(),
  imdbId: z.string().nullish(),
  mediaType: z.string().nullish(),
  status: z.number().nullish(),
  status4k: z.number().nullish(),
  jellyfinMediaId: z.string().nullish(),
  seasons: z.array(z.object({ seasonNumber: z.number(), status: z.number().nullish(), status4k: z.number().nullish() })).nullish(),
  requests: z.array(z.unknown()).nullish(),
});
export type SeerrMediaInfo = z.infer<typeof MediaInfo>;

const SeerrUser = z.object({
  id: z.number(),
  displayName: z.string().nullish(),
  username: z.string().nullish(),
  jellyfinUsername: z.string().nullish(),
  jellyfinUserId: z.string().nullish(),
  plexUsername: z.string().nullish(),
  email: z.string().nullish(),
  permissions: z.number().nullish(),
  userType: z.number().nullish(),
  avatar: z.string().nullish(),
});
export type SeerrUserJson = z.infer<typeof SeerrUser>;

const RequestJson = z.object({
  id: z.number(),
  status: z.number(),
  is4k: z.boolean().nullish(),
  createdAt: z.string().nullish(),
  updatedAt: z.string().nullish(),
  type: z.string().nullish(),
  media: MediaInfo.nullish(),
  seasons: z.array(z.object({ seasonNumber: z.number(), status: z.number().nullish() })).nullish(),
  requestedBy: SeerrUser.nullish(),
});
export type SeerrRequestJson = z.infer<typeof RequestJson>;

const PageInfo = z.object({ pages: z.number(), page: z.number().nullish(), results: z.number().nullish() });

const Genre = z.object({ id: z.number().nullish(), name: z.string() });
const Details = z.object({
  id: z.number(),
  title: z.string().nullish(),
  name: z.string().nullish(),
  originalTitle: z.string().nullish(),
  originalName: z.string().nullish(),
  releaseDate: z.string().nullish(),
  firstAirDate: z.string().nullish(),
  overview: z.string().nullish(),
  posterPath: z.string().nullish(),
  backdropPath: z.string().nullish(),
  genres: z.array(Genre).nullish(),
  runtime: z.number().nullish(),
  episodeRunTime: z.array(z.number()).nullish(),
  numberOfEpisodes: z.number().nullish(),
  numberOfSeasons: z.number().nullish(),
  lastEpisodeToAir: z.object({ runtime: z.number().nullish() }).nullish(),
  imdbId: z.string().nullish(),
  externalIds: z.object({ imdbId: z.string().nullish(), tvdbId: z.number().nullish() }).nullish(),
  seasons: z
    .array(z.object({ seasonNumber: z.number(), name: z.string().nullish(), episodeCount: z.number().nullish(), airDate: z.string().nullish() }))
    .nullish(),
  mediaInfo: MediaInfo.nullish(),
});
export type SeerrDetails = z.infer<typeof Details>;

const SearchResult = z.object({
  id: z.number(),
  mediaType: z.string(),
  title: z.string().nullish(),
  name: z.string().nullish(),
  originalTitle: z.string().nullish(),
  originalName: z.string().nullish(),
  releaseDate: z.string().nullish(),
  firstAirDate: z.string().nullish(),
  posterPath: z.string().nullish(),
  overview: z.string().nullish(),
  popularity: z.number().nullish(),
  mediaInfo: MediaInfo.nullish(),
});

export interface SeerrSearchHit extends MatchCandidate {
  mediaInfo: SeerrMediaInfo | null;
}

/** Encodes a query the same way Seerr's own web client does (encodeURIExtraParams). */
export function encodeSeerrQuery(q: string): string {
  return encodeURIComponent(q).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

const yearOf = (d: string | null | undefined) => (d && /^\d{4}/.test(d) ? Number(d.slice(0, 4)) : null);

export interface CreateRequestInput {
  mediaType: MediaType;
  tmdbId: number;
  tvdbId?: number | null;
  seasons?: number[] | 'all';
  is4k?: boolean;
}

export type CreateRequestResult =
  | { ok: true; request: SeerrRequestJson }
  | { ok: false; code: 'duplicate' | 'forbidden' | 'no_seasons' | 'failed'; message: string };

export class SeerrClient {
  readonly http: HttpClient;

  constructor(baseUrl: string, apiKey: string, fetchImpl?: FetchLike) {
    this.http = new HttpClient({
      provider: 'seerr',
      baseUrl: `${baseUrl.replace(/\/+$/, '')}/api/v1`,
      headers: () => ({ 'X-Api-Key': apiKey }),
      timeoutMs: 20_000,
      fetchImpl,
    });
  }

  private asUser(userId?: number | null): Record<string, string> {
    return userId ? { 'X-API-User': String(userId) } : {};
  }

  async status() {
    const res = await this.http.get('/status');
    return z.object({ version: z.string(), commitTag: z.string().nullish(), updateAvailable: z.boolean().nullish() }).parse(res.data);
  }

  async me() {
    const res = await this.http.get('/auth/me');
    return SeerrUser.parse(res.data);
  }

  async publicSettings() {
    const res = await this.http.get('/settings/public');
    return z
      .object({ applicationTitle: z.string().nullish(), applicationUrl: z.string().nullish(), mediaServerType: z.number().nullish(), partialRequestsEnabled: z.boolean().nullish() })
      .parse(res.data);
  }

  async users(): Promise<SeerrUserJson[]> {
    const out: SeerrUserJson[] = [];
    for (let skip = 0, page = 0; page < 50; page++, skip += 100) {
      const res = await this.http.get('/user', { take: 100, skip });
      const data = z.object({ pageInfo: PageInfo, results: z.array(SeerrUser) }).parse(res.data);
      out.push(...data.results);
      if (page + 1 >= data.pageInfo.pages || data.results.length === 0) break;
    }
    return out;
  }

  async search(query: string, page = 1, asUser?: number | null): Promise<{ hits: SeerrSearchHit[]; totalPages: number }> {
    const res = await this.http.get(`/search?query=${encodeSeerrQuery(query)}`, { page }, { headers: this.asUser(asUser) });
    return this.parseResults(res.data);
  }

  /** Seerr's own discover feeds (trending, popular movies, popular shows). */
  async discover(kind: 'trending' | 'movies' | 'tv', page = 1): Promise<{ hits: SeerrSearchHit[]; totalPages: number }> {
    const res = await this.http.get(`/discover/${kind}`, { page });
    return this.parseResults(res.data, kind === 'movies' ? 'movie' : kind === 'tv' ? 'tv' : undefined);
  }

  private parseResults(raw: unknown, fallbackType?: MediaType): { hits: SeerrSearchHit[]; totalPages: number } {
    const data = z.object({ totalPages: z.number().nullish(), results: z.array(z.unknown()) }).parse(raw);
    const hits: SeerrSearchHit[] = [];
    for (const item of data.results) {
      const withType = fallbackType && item && typeof item === 'object' && !('mediaType' in item) ? { ...item, mediaType: fallbackType } : item;
      const r = SearchResult.safeParse(withType);
      if (!r.success || (r.data.mediaType !== 'movie' && r.data.mediaType !== 'tv')) continue;
      const d = r.data;
      hits.push({
        tmdbId: d.id,
        mediaType: d.mediaType as MediaType,
        title: d.title ?? d.name ?? '',
        originalTitle: d.originalTitle ?? d.originalName ?? null,
        year: yearOf(d.releaseDate ?? d.firstAirDate),
        posterPath: d.posterPath ?? null,
        overview: d.overview ?? null,
        popularity: d.popularity ?? null,
        mediaInfo: d.mediaInfo ?? null,
      });
    }
    return { hits, totalPages: data.totalPages ?? 1 };
  }

  async details(mediaType: MediaType, tmdbId: number, asUser?: number | null): Promise<SeerrDetails> {
    const res = await this.http.get(`/${mediaType === 'movie' ? 'movie' : 'tv'}/${tmdbId}`, undefined, { headers: this.asUser(asUser) });
    const parsed = Details.safeParse(res.data);
    if (!parsed.success) throw new ProviderError('seerr', 'invalid_response');
    return parsed.data;
  }

  async createRequest(input: CreateRequestInput, asUser: number | null): Promise<CreateRequestResult> {
    const body: Record<string, unknown> = { mediaType: input.mediaType, mediaId: input.tmdbId, is4k: input.is4k ?? false };
    if (input.mediaType === 'tv') {
      body.seasons = input.seasons ?? 'all';
      if (input.tvdbId) body.tvdbId = input.tvdbId;
    }
    try {
      const res = await this.http.post('/request', body, { headers: this.asUser(asUser), acceptStatus: [202] });
      if (res.status === 202) {
        const msg = z.object({ message: z.string().nullish() }).safeParse(res.data);
        return { ok: false, code: 'no_seasons', message: msg.success && msg.data.message ? msg.data.message : 'No seasons are available to request.' };
      }
      const parsed = RequestJson.safeParse(res.data);
      if (!parsed.success) throw new ProviderError('seerr', 'invalid_response');
      return { ok: true, request: parsed.data };
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      const serverMsg = z.object({ message: z.string() }).safeParse(err.body);
      const detail = serverMsg.success ? serverMsg.data.message : undefined;
      if (err.status === 409) return { ok: false, code: 'duplicate', message: detail ?? 'This title has already been requested.' };
      if (err.status === 403) {
        if (detail && /csrf/i.test(detail)) {
          return { ok: false, code: 'failed', message: 'Seerr rejected the request because CSRF protection is enabled. Disable “CSRF Protection” in Seerr › Settings › Network for API access.' };
        }
        return { ok: false, code: 'forbidden', message: detail ?? 'Your Seerr account is not allowed to make this request (permissions, quota or blocklist).' };
      }
      if (err.kind === 'auth') throw err;
      return { ok: false, code: 'failed', message: detail ?? err.message };
    }
  }

  async request(id: number): Promise<SeerrRequestJson | null> {
    try {
      const res = await this.http.get(`/request/${id}`);
      const parsed = RequestJson.safeParse(res.data);
      if (!parsed.success) throw new ProviderError('seerr', 'invalid_response');
      return parsed.data;
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'not_found') return null;
      throw err;
    }
  }

  /** Most recently modified requests first. */
  async requests(maxItems = 1000): Promise<SeerrRequestJson[]> {
    const out: SeerrRequestJson[] = [];
    for (let skip = 0; skip < maxItems; skip += 100) {
      const res = await this.http.get('/request', { take: 100, skip, filter: 'all', sort: 'modified', sortDirection: 'desc' });
      const data = z.object({ pageInfo: PageInfo, results: z.array(z.unknown()) }).parse(res.data);
      for (const r of data.results) {
        const p = RequestJson.safeParse(r);
        if (p.success) out.push(p.data);
      }
      if (data.results.length < 100) break;
    }
    return out;
  }

  /** All media Seerr tracks (requested or detected as available). */
  async media(maxItems = 20_000): Promise<SeerrMediaInfo[]> {
    const out: SeerrMediaInfo[] = [];
    for (let skip = 0; skip < maxItems; skip += 100) {
      const res = await this.http.get('/media', { take: 100, skip, filter: 'all', sort: 'modified' });
      const data = z.object({ pageInfo: PageInfo, results: z.array(z.unknown()) }).parse(res.data);
      for (const r of data.results) {
        const p = MediaInfo.safeParse(r);
        if (p.success) out.push(p.data);
      }
      if (data.results.length < 100) break;
    }
    return out;
  }
}

/** Seerr permission bits (server/lib/permissions.ts). */
export const SeerrPermission = {
  ADMIN: 2,
  MANAGE_REQUESTS: 16,
  REQUEST: 32,
  AUTO_APPROVE: 128,
  AUTO_APPROVE_MOVIE: 256,
  AUTO_APPROVE_TV: 512,
  REQUEST_MOVIE: 262144,
  REQUEST_TV: 524288,
} as const;

export function seerrCan(permissions: number | null | undefined, mediaType: MediaType): { request: boolean; autoApprove: boolean } {
  const p = permissions ?? 0;
  const has = (bit: number) => (p & SeerrPermission.ADMIN) !== 0 || (p & bit) !== 0;
  const request = has(SeerrPermission.REQUEST) || has(mediaType === 'movie' ? SeerrPermission.REQUEST_MOVIE : SeerrPermission.REQUEST_TV);
  const autoApprove =
    has(SeerrPermission.MANAGE_REQUESTS) ||
    has(SeerrPermission.AUTO_APPROVE) ||
    has(mediaType === 'movie' ? SeerrPermission.AUTO_APPROVE_MOVIE : SeerrPermission.AUTO_APPROVE_TV);
  return { request, autoApprove };
}
