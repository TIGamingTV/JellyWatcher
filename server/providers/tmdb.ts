import { z } from 'zod';
import { HttpClient, type FetchLike } from '../http/client.js';
import { ProviderError } from '../http/errors.js';
import type { MatchCandidate, MediaType } from '../domain/matching.js';
import type { ListFetchResult, SourceItem } from './types.js';

/**
 * TMDb API v3 adapter (Bearer "API Read Access Token"). Used for metadata and identifier resolution.
 * "This product uses the TMDB API but is not endorsed or certified by TMDB."
 */

export const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';

export type DiscoverKind = 'trending' | 'movies' | 'tv';

const Result = z.object({
  id: z.number(),
  media_type: z.string().nullish(),
  title: z.string().nullish(),
  name: z.string().nullish(),
  original_title: z.string().nullish(),
  original_name: z.string().nullish(),
  release_date: z.string().nullish(),
  first_air_date: z.string().nullish(),
  poster_path: z.string().nullish(),
  backdrop_path: z.string().nullish(),
  overview: z.string().nullish(),
  popularity: z.number().nullish(),
});

const yearOf = (d: string | null | undefined) => (d && /^\d{4}/.test(d) ? Number(d.slice(0, 4)) : null);

export function toCandidate(raw: z.infer<typeof Result>, mediaType: MediaType): MatchCandidate {
  return {
    tmdbId: raw.id,
    mediaType,
    title: raw.title ?? raw.name ?? '',
    originalTitle: raw.original_title ?? raw.original_name ?? null,
    year: yearOf(raw.release_date ?? raw.first_air_date),
    posterPath: raw.poster_path ?? null,
    overview: raw.overview ?? null,
    popularity: raw.popularity ?? null,
  };
}

export interface TitleMetadata {
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  originalTitle: string | null;
  year: number | null;
  releaseDate: string | null;
  overview: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  genres: string[];
  runtime: number | null;
  imdbId: string | null;
  tvdbId: number | null;
  seasons?: { seasonNumber: number; name: string | null; episodeCount: number | null; airDate: string | null }[];
  /** Regular-season totals (specials excluded); shows only. */
  episodeCount?: number | null;
  seasonCount?: number | null;
}

/** One episode from a season's details. */
export interface EpisodeMetadata {
  episode: number;
  name: string | null;
  airDate: string | null;
  /** Minutes; null when the source does not say (Seerr never does). */
  runtime: number | null;
}

/** The episodes of each season; seasons the source could not find are left out. */
export type SeasonEpisodes = Map<number, EpisodeMetadata[]>;

const SeasonDetails = z.object({
  episodes: z
    .array(z.object({ episode_number: z.number(), name: z.string().nullish(), air_date: z.string().nullish(), runtime: z.number().nullish() }))
    .nullish(),
});

/** Seasons appended to one show request (TMDb allows 20 appends per request). */
const SEASONS_PER_REQUEST = 20;

/** Regular-season episode and season totals, preferring the per-season breakdown. */
export function showTotals(seasons: TitleMetadata['seasons'], numberOfEpisodes?: number | null, numberOfSeasons?: number | null) {
  const regular = (seasons ?? []).filter((s) => s.seasonNumber > 0);
  const summed = regular.reduce((n, s) => n + (s.episodeCount ?? 0), 0);
  return {
    episodeCount: summed > 0 ? summed : (numberOfEpisodes ?? null),
    seasonCount: regular.length > 0 ? regular.length : (numberOfSeasons ?? null),
  };
}

const Details = z.object({
  id: z.number(),
  title: z.string().nullish(),
  name: z.string().nullish(),
  original_title: z.string().nullish(),
  original_name: z.string().nullish(),
  release_date: z.string().nullish(),
  first_air_date: z.string().nullish(),
  overview: z.string().nullish(),
  poster_path: z.string().nullish(),
  backdrop_path: z.string().nullish(),
  genres: z.array(z.object({ name: z.string() })).nullish(),
  runtime: z.number().nullish(),
  episode_run_time: z.array(z.number()).nullish(),
  number_of_episodes: z.number().nullish(),
  number_of_seasons: z.number().nullish(),
  last_episode_to_air: z.object({ runtime: z.number().nullish() }).nullish(),
  imdb_id: z.string().nullish(),
  external_ids: z.object({ imdb_id: z.string().nullish(), tvdb_id: z.number().nullish() }).nullish(),
  seasons: z
    .array(z.object({ season_number: z.number(), name: z.string().nullish(), episode_count: z.number().nullish(), air_date: z.string().nullish() }))
    .nullish(),
});

/** Accepts themoviedb.org/list/<id>[-slug] links (any language prefix or query). */
export function parseTmdbListUrl(input: string): number | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (!/^(www\.)?themoviedb\.org$/i.test(url.hostname)) return null;
  const m = url.pathname.match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?list\/(\d{1,10})(?:-[^/]*)?\/?$/i);
  return m ? Number(m[1]) : null;
}

const ListResult = Result.extend({ media_type: z.string().nullish() });
const ListPage = z.object({
  id: z.number(),
  name: z.string().nullish(),
  description: z.string().nullish(),
  public: z.boolean().nullish(),
  created_by: z.object({ username: z.string().nullish(), name: z.string().nullish() }).nullish(),
  total_pages: z.number().nullish(),
  total_results: z.number().nullish(),
  results: z.array(ListResult),
  comments: z.record(z.string(), z.string().nullish()).nullish(),
});

export function tmdbListItem(r: z.infer<typeof ListResult>, position: number, comments?: Record<string, string | null | undefined> | null): SourceItem | null {
  const type = r.media_type === 'movie' ? 'movie' : r.media_type === 'tv' ? 'tv' : null;
  if (!type) return null;
  return {
    sourceKey: `tmdb:${type}:${r.id}`,
    title: r.title ?? r.name ?? `TMDb ${r.id}`,
    year: yearOf(r.release_date ?? r.first_air_date),
    mediaType: type,
    tmdbId: r.id,
    sourceUrl: `https://www.themoviedb.org/${type}/${r.id}`,
    position,
    notes: comments?.[`${type}:${r.id}`]?.slice(0, 2000) || null,
  };
}

export class TmdbClient {
  readonly http: HttpClient;
  /** API v4, used for lists (same read access token). */
  private readonly v4: HttpClient;

  constructor(token: string, fetchImpl?: FetchLike) {
    this.http = new HttpClient({
      provider: 'tmdb',
      baseUrl: 'https://api.themoviedb.org/3',
      headers: () => ({ Authorization: `Bearer ${token}` }),
      minIntervalMs: 30,
      retries: 3,
      fetchImpl,
    });
    this.v4 = new HttpClient({ provider: 'tmdb', baseUrl: 'https://api.themoviedb.org/4', headers: () => ({ Authorization: `Bearer ${token}` }), minIntervalMs: 30, retries: 3, fetchImpl });
  }

  /** Reads a whole public list in its own order (pages of 20). */
  async list(listId: number): Promise<ListFetchResult> {
    const items: SourceItem[] = [];
    let skipped = 0;
    let first: z.infer<typeof ListPage> | null = null;
    for (let page = 1; page <= 250; page++) {
      let data: unknown;
      try {
        data = (await this.v4.get(`/list/${listId}`, { page })).data;
      } catch (err) {
        if (err instanceof ProviderError && err.kind === 'not_found') throw new ProviderError('tmdb', 'not_found', 'No TMDb list was found at that link.');
        if (err instanceof ProviderError && (err.kind === 'auth' || err.kind === 'forbidden')) {
          throw new ProviderError('tmdb', 'forbidden', 'That TMDb list is private, or the TMDb token in Integrations is not valid.');
        }
        throw err;
      }
      const p = ListPage.safeParse(data);
      if (!p.success) throw new ProviderError('tmdb', 'invalid_response');
      first ??= p.data;
      for (const r of p.data.results) {
        const item = tmdbListItem(r, items.length + skipped + 1, p.data.comments);
        if (item) items.push(item);
        else skipped++;
      }
      if (page >= (p.data.total_pages ?? 1) || p.data.results.length === 0) break;
    }
    const l = first!;
    return {
      info: {
        externalId: `list:${l.id}`,
        name: l.name || `TMDb list ${l.id}`,
        kind: 'public',
        description: l.description || null,
        ownerName: l.created_by?.username ?? l.created_by?.name ?? null,
        url: `https://www.themoviedb.org/list/${l.id}`,
        itemCount: l.total_results ?? null,
      },
      items,
      skipped,
    };
  }

  async validate(): Promise<void> {
    await this.http.get('/configuration', undefined, { retries: 0 });
  }

  async find(externalId: string, source: 'imdb_id' | 'tvdb_id'): Promise<MatchCandidate[]> {
    const res = await this.http.get(`/find/${encodeURIComponent(externalId)}`, { external_source: source });
    const data = z.object({ movie_results: z.array(Result).nullish(), tv_results: z.array(Result).nullish() }).parse(res.data);
    return [...(data.movie_results ?? []).map((r) => toCandidate(r, 'movie')), ...(data.tv_results ?? []).map((r) => toCandidate(r, 'tv'))];
  }

  async search(mediaType: MediaType, query: string, year?: number | null): Promise<MatchCandidate[]> {
    const params: Record<string, string | number> = { query, include_adult: 'false', page: 1 };
    if (year) params[mediaType === 'movie' ? 'year' : 'first_air_date_year'] = year;
    const res = await this.http.get(`/search/${mediaType}`, params);
    const data = z.object({ results: z.array(Result) }).parse(res.data);
    return data.results.map((r) => toCandidate(r, mediaType));
  }

  async searchMulti(query: string, page = 1): Promise<{ results: MatchCandidate[]; totalPages: number }> {
    const res = await this.http.get('/search/multi', { query, include_adult: 'false', page });
    const data = z.object({ results: z.array(Result), total_pages: z.number().nullish() }).parse(res.data);
    return {
      results: data.results.filter((r) => r.media_type === 'movie' || r.media_type === 'tv').map((r) => toCandidate(r, r.media_type as MediaType)),
      totalPages: data.total_pages ?? 1,
    };
  }

  /** Trending titles this week, or popular movies / shows. */
  async discover(kind: DiscoverKind, page = 1): Promise<{ results: MatchCandidate[]; totalPages: number }> {
    const path = kind === 'trending' ? '/trending/all/week' : kind === 'movies' ? '/movie/popular' : '/tv/popular';
    const res = await this.http.get(path, { page, include_adult: 'false' });
    const data = z.object({ results: z.array(Result), total_pages: z.number().nullish() }).parse(res.data);
    const fixed: MediaType | null = kind === 'movies' ? 'movie' : kind === 'tv' ? 'tv' : null;
    return {
      results: data.results
        .map((r) => ({ r, t: (fixed ?? r.media_type) as MediaType }))
        .filter(({ t }) => t === 'movie' || t === 'tv')
        .map(({ r, t }) => toCandidate(r, t)),
      totalPages: Math.min(data.total_pages ?? 1, 500),
    };
  }

  async details(mediaType: MediaType, tmdbId: number): Promise<TitleMetadata | null> {
    try {
      const res = await this.http.get(`/${mediaType}/${tmdbId}`, { append_to_response: 'external_ids' });
      const p = Details.safeParse(res.data);
      if (!p.success) throw new ProviderError('tmdb', 'invalid_response');
      const d = p.data;
      const release = d.release_date ?? d.first_air_date ?? null;
      const seasons = d.seasons?.map((s) => ({ seasonNumber: s.season_number, name: s.name ?? null, episodeCount: s.episode_count ?? null, airDate: s.air_date ?? null }));
      return {
        tmdbId: d.id,
        mediaType,
        title: d.title ?? d.name ?? 'Untitled',
        originalTitle: d.original_title ?? d.original_name ?? null,
        year: yearOf(release),
        releaseDate: release || null,
        overview: d.overview || null,
        posterPath: d.poster_path ?? null,
        backdropPath: d.backdrop_path ?? null,
        genres: (d.genres ?? []).map((g) => g.name),
        runtime: d.runtime || d.episode_run_time?.[0] || d.last_episode_to_air?.runtime || null,
        imdbId: d.imdb_id ?? d.external_ids?.imdb_id ?? null,
        tvdbId: d.external_ids?.tvdb_id ?? null,
        seasons,
        ...(mediaType === 'tv' ? showTotals(seasons, d.number_of_episodes, d.number_of_seasons) : {}),
      };
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'not_found') return null;
      throw err;
    }
  }

  /** Episode lists of a show's seasons, up to 20 seasons per request (append_to_response). */
  async seasonEpisodes(tvId: number, seasons: number[]): Promise<SeasonEpisodes> {
    const out: SeasonEpisodes = new Map();
    for (let i = 0; i < seasons.length; i += SEASONS_PER_REQUEST) {
      const chunk = seasons.slice(i, i + SEASONS_PER_REQUEST);
      const res = await this.http.get(`/tv/${tvId}`, { append_to_response: chunk.map((n) => `season/${n}`).join(',') });
      const data = (res.data ?? {}) as Record<string, unknown>;
      for (const n of chunk) {
        const p = SeasonDetails.safeParse(data[`season/${n}`]);
        if (!p.success || !p.data.episodes) continue;
        out.set(
          n,
          p.data.episodes.map((e) => ({ episode: e.episode_number, name: e.name || null, airDate: e.air_date || null, runtime: e.runtime || null })),
        );
      }
    }
    return out;
  }
}
