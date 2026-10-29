import type { MatchCandidate, MediaType } from '../domain/matching.js';
import type { SeerrClient, SeerrDetails } from '../providers/seerr.js';
import { showTotals, type DiscoverKind, type TitleMetadata, type TmdbClient } from '../providers/tmdb.js';
import type { IntegrationStore } from './integrations.js';

/**
 * Metadata source abstraction. TMDb is used directly when a token is configured; otherwise Seerr's
 * TMDb proxy provides the same data so a TMDb key is optional.
 */
export interface MetadataSource {
  readonly name: 'tmdb' | 'seerr';
  findByImdb(imdbId: string): Promise<MatchCandidate[]>;
  findByTvdb(tvdbId: number): Promise<MatchCandidate[]>;
  search(mediaType: MediaType, title: string, year: number | null): Promise<MatchCandidate[]>;
  searchAny(query: string, page: number): Promise<{ results: MatchCandidate[]; totalPages: number }>;
  discover(kind: DiscoverKind, page: number): Promise<{ results: MatchCandidate[]; totalPages: number }>;
  details(mediaType: MediaType, tmdbId: number): Promise<TitleMetadata | null>;
}

class TmdbSource implements MetadataSource {
  readonly name = 'tmdb' as const;
  constructor(private readonly c: TmdbClient) {}
  findByImdb(id: string) {
    return this.c.find(id, 'imdb_id');
  }
  findByTvdb(id: number) {
    return this.c.find(String(id), 'tvdb_id');
  }
  async search(t: MediaType, title: string, year: number | null) {
    const withYear = await this.c.search(t, title, year);
    // Release years differ between sources (festival vs. theatrical), so retry without the year.
    return withYear.length > 0 || !year ? withYear : this.c.search(t, title, null);
  }
  searchAny(q: string, page: number) {
    return this.c.searchMulti(q, page);
  }
  discover(kind: DiscoverKind, page: number) {
    return this.c.discover(kind, page);
  }
  details(t: MediaType, id: number) {
    return this.c.details(t, id);
  }
}

export function seerrDetailsToMetadata(mediaType: MediaType, d: SeerrDetails): TitleMetadata {
  const release = d.releaseDate ?? d.firstAirDate ?? null;
  const seasons = d.seasons?.map((s) => ({ seasonNumber: s.seasonNumber, name: s.name ?? null, episodeCount: s.episodeCount ?? null, airDate: s.airDate ?? null }));
  return {
    tmdbId: d.id,
    mediaType,
    title: d.title ?? d.name ?? 'Untitled',
    originalTitle: d.originalTitle ?? d.originalName ?? null,
    year: release && /^\d{4}/.test(release) ? Number(release.slice(0, 4)) : null,
    releaseDate: release || null,
    overview: d.overview || null,
    posterPath: d.posterPath ?? null,
    backdropPath: d.backdropPath ?? null,
    genres: (d.genres ?? []).map((g) => g.name),
    runtime: d.runtime || d.episodeRunTime?.[0] || d.lastEpisodeToAir?.runtime || null,
    imdbId: d.imdbId ?? d.externalIds?.imdbId ?? null,
    tvdbId: d.externalIds?.tvdbId ?? null,
    seasons,
    ...(mediaType === 'tv' ? showTotals(seasons, d.numberOfEpisodes, d.numberOfSeasons) : {}),
  };
}

class SeerrSource implements MetadataSource {
  readonly name = 'seerr' as const;
  constructor(private readonly c: SeerrClient) {}
  async findByImdb(id: string) {
    return (await this.c.search(`imdb:${id}`)).hits;
  }
  async findByTvdb(id: number) {
    return (await this.c.search(`tvdb:${id}`)).hits;
  }
  async search(t: MediaType, title: string) {
    return (await this.c.search(title)).hits.filter((h) => h.mediaType === t);
  }
  async searchAny(q: string, page: number) {
    const r = await this.c.search(q, page);
    return { results: r.hits, totalPages: r.totalPages };
  }
  async discover(kind: DiscoverKind, page: number) {
    const r = await this.c.discover(kind, page);
    return { results: r.hits, totalPages: r.totalPages };
  }
  async details(t: MediaType, id: number) {
    try {
      return seerrDetailsToMetadata(t, await this.c.details(t, id));
    } catch (err) {
      if ((err as { kind?: string }).kind === 'not_found') return null;
      throw err;
    }
  }
}

export function metadataSource(integrations: IntegrationStore): MetadataSource | null {
  const tmdb = integrations.tmdb();
  if (tmdb) return new TmdbSource(tmdb);
  const seerr = integrations.seerr();
  if (seerr) return new SeerrSource(seerr);
  return null;
}
