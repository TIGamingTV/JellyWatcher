import { z } from 'zod';
import { HttpClient, type FetchLike } from '../http/client.js';
import { ProviderError } from '../http/errors.js';
import type { MatchCandidate, MediaType } from '../domain/matching.js';

/**
 * TMDb API v3 adapter (Bearer "API Read Access Token"). Used for metadata and identifier resolution.
 * "This product uses the TMDB API but is not endorsed or certified by TMDB."
 */

export const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';

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
  imdb_id: z.string().nullish(),
  external_ids: z.object({ imdb_id: z.string().nullish(), tvdb_id: z.number().nullish() }).nullish(),
  seasons: z
    .array(z.object({ season_number: z.number(), name: z.string().nullish(), episode_count: z.number().nullish(), air_date: z.string().nullish() }))
    .nullish(),
});

export class TmdbClient {
  readonly http: HttpClient;

  constructor(token: string, fetchImpl?: FetchLike) {
    this.http = new HttpClient({
      provider: 'tmdb',
      baseUrl: 'https://api.themoviedb.org/3',
      headers: () => ({ Authorization: `Bearer ${token}` }),
      minIntervalMs: 30,
      retries: 3,
      fetchImpl,
    });
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

  async trending(mediaType: 'all' | MediaType = 'all', window: 'day' | 'week' = 'week'): Promise<MatchCandidate[]> {
    const res = await this.http.get(`/trending/${mediaType}/${window}`);
    const data = z.object({ results: z.array(Result) }).parse(res.data);
    return data.results
      .filter((r) => mediaType !== 'all' || r.media_type === 'movie' || r.media_type === 'tv')
      .map((r) => toCandidate(r, (mediaType === 'all' ? r.media_type : mediaType) as MediaType));
  }

  async details(mediaType: MediaType, tmdbId: number): Promise<TitleMetadata | null> {
    try {
      const res = await this.http.get(`/${mediaType}/${tmdbId}`, { append_to_response: 'external_ids' });
      const p = Details.safeParse(res.data);
      if (!p.success) throw new ProviderError('tmdb', 'invalid_response');
      const d = p.data;
      const release = d.release_date ?? d.first_air_date ?? null;
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
        runtime: d.runtime ?? d.episode_run_time?.[0] ?? null,
        imdbId: d.imdb_id ?? d.external_ids?.imdb_id ?? null,
        tvdbId: d.external_ids?.tvdb_id ?? null,
        seasons: d.seasons?.map((s) => ({ seasonNumber: s.season_number, name: s.name ?? null, episodeCount: s.episode_count ?? null, airDate: s.air_date ?? null })),
      };
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'not_found') return null;
      throw err;
    }
  }
}
