import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from 'pino';
import type { MediaType } from '../domain/matching.js';
import { HttpClient, type FetchLike } from '../http/client.js';
import type { SourceItem } from './types.js';

/**
 * Anime ids → TMDb. MyAnimeList, AniList and Simkl list every anime season as its own entry, while
 * TMDb (and so Jellyfin and Seerr) treat them as seasons of one show. The community-maintained
 * Fribb/anime-lists mapping links each entry to its TMDb show and season (or TMDb movie). It is
 * downloaded on first use, cached in the data folder and refreshed weekly. Without it, anime are
 * matched by title like any other entry.
 * Verified 2026-10: entries carry mal_id, anilist_id, simkl_id, themoviedb_id {tv: n} | {movie: [n]},
 * season {tmdb}, episode_offset {tmdb}, tvdb_id and imdb_id [].
 */

export const ANIME_LIST_URL = 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json';
const MAX_AGE_MS = 7 * 86400_000;
const RETRY_AFTER_FAILURE_MS = 3600_000;

export interface AnimeMapping {
  tmdbTv?: number;
  tmdbMovie?: number;
  /** TMDb season of a show entry; 0 for specials. */
  season?: number;
  /** Episodes of that season that come before this entry (second cour of a split season). */
  offset?: number;
  tvdb?: number;
  imdb?: string;
}

type Compact = [mal: number | null, anilist: number | null, simkl: number | null, mapping: AnimeMapping];

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);

/** Reduces the upstream file to the fields JellyWatcher uses. */
export function compactAnimeList(raw: unknown): Compact[] {
  if (!Array.isArray(raw)) throw new Error('unexpected anime list format');
  const out: Compact[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object') continue;
    const tmdb = (r.themoviedb_id ?? {}) as { tv?: unknown; movie?: unknown };
    const movie = Array.isArray(tmdb.movie) ? num(tmdb.movie[0]) : num(tmdb.movie);
    const season = (r.season ?? {}) as { tmdb?: unknown };
    const offset = (r.episode_offset ?? {}) as { tmdb?: unknown };
    const imdb = Array.isArray(r.imdb_id) ? r.imdb_id[0] : r.imdb_id;
    const m: AnimeMapping = {
      tmdbTv: num(tmdb.tv),
      tmdbMovie: movie,
      season: typeof season.tmdb === 'number' && season.tmdb >= 0 ? season.tmdb : undefined,
      offset: num(offset.tmdb),
      tvdb: num(r.tvdb_id),
      imdb: typeof imdb === 'string' && /^tt\d+$/.test(imdb) ? imdb : undefined,
    };
    if (!m.tmdbTv && !m.tmdbMovie && !m.tvdb && !m.imdb) continue;
    const mal = num(r.mal_id) ?? null;
    const anilist = num(r.anilist_id) ?? null;
    const simkl = num(r.simkl_id) ?? null;
    if (mal === null && anilist === null && simkl === null) continue;
    for (const k of Object.keys(m) as (keyof AnimeMapping)[]) if (m[k] === undefined) delete m[k];
    out.push([mal, anilist, simkl, m]);
  }
  return out;
}

export class AnimeIds {
  private byMal = new Map<number, AnimeMapping>();
  private byAnilist = new Map<number, AnimeMapping>();
  private bySimkl = new Map<number, AnimeMapping>();
  /** TMDb shows that more than one anime entry maps to (several seasons or cours). */
  private split = new Set<number>();
  private loaded = false;
  private loading: Promise<boolean> | null = null;
  private failedAt = 0;
  private readonly http: HttpClient;
  private readonly source: URL;

  constructor(private readonly opts: { cacheFile?: string | null; fetchImpl?: FetchLike; log?: Logger; url?: string } = {}) {
    this.source = new URL(opts.url ?? ANIME_LIST_URL);
    this.http = new HttpClient({ provider: 'anime-lists', baseUrl: this.source.origin, fetchImpl: opts.fetchImpl, timeoutMs: 60_000, retries: 1 });
  }

  get ready(): boolean {
    return this.loaded;
  }

  /** Loads the mapping (cache first, then download). Never throws; false when unavailable. */
  async load(): Promise<boolean> {
    const age = this.cacheAge();
    if (this.loaded && (age === null || age < MAX_AGE_MS)) return true;
    if (this.loading) return this.loading;
    this.loading = this.doLoad().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private cacheAge(): number | null {
    if (!this.opts.cacheFile) return null;
    try {
      return Date.now() - fs.statSync(this.opts.cacheFile).mtimeMs;
    } catch {
      return null;
    }
  }

  private async doLoad(): Promise<boolean> {
    const file = this.opts.cacheFile;
    const age = this.cacheAge();
    if (file && age !== null && age < MAX_AGE_MS && this.readCache(file)) return true;
    if (Date.now() - this.failedAt > RETRY_AFTER_FAILURE_MS || !this.loaded) {
      try {
        const res = await this.http.get<unknown>(this.source.pathname);
        const rows = compactAnimeList(res.data);
        this.index(rows);
        if (file) {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, JSON.stringify(rows));
        }
        return true;
      } catch (err) {
        this.failedAt = Date.now();
        this.opts.log?.warn({ err: (err as Error).message }, 'anime id mapping unavailable; anime are matched by title');
      }
    }
    // A stale cache beats nothing.
    return this.loaded || Boolean(file && this.readCache(file));
  }

  private readCache(file: string): boolean {
    try {
      this.index(JSON.parse(fs.readFileSync(file, 'utf8')) as Compact[]);
      return true;
    } catch {
      return false;
    }
  }

  /** Replaces the mapping (also used by tests). */
  index(rows: Compact[]): void {
    this.byMal = new Map();
    this.byAnilist = new Map();
    this.bySimkl = new Map();
    const count = new Map<number, number>();
    for (const [mal, anilist, simkl, m] of rows) {
      if (mal !== null) this.byMal.set(mal, m);
      if (anilist !== null) this.byAnilist.set(anilist, m);
      if (simkl !== null) this.bySimkl.set(simkl, m);
      // Specials (season 0) don't make a one-season show "split".
      if (m.tmdbTv && (m.season === undefined || m.season >= 1)) count.set(m.tmdbTv, (count.get(m.tmdbTv) ?? 0) + 1);
    }
    this.split = new Set([...count].filter(([, n]) => n > 1).map(([id]) => id));
    this.loaded = true;
  }

  lookup(ids: { mal?: number | null; anilist?: number | null; simkl?: number | null }): AnimeMapping | undefined {
    return (ids.mal ? this.byMal.get(ids.mal) : undefined) ?? (ids.anilist ? this.byAnilist.get(ids.anilist) : undefined) ?? (ids.simkl ? this.bySimkl.get(ids.simkl) : undefined);
  }

  isSplit(tmdbTv: number): boolean {
    return this.split.has(tmdbTv);
  }
}

/** Anime formats as reported by MyAnimeList / AniList / Simkl. */
export function animeMediaType(format: string | null | undefined): MediaType | 'skip' | null {
  const f = (format ?? '').toLowerCase().replace(/[\s_-]+/g, '');
  if (f === 'movie') return 'movie';
  if (['music', 'cm', 'pv', 'manga', 'novel', 'oneshot', 'lightnovel'].includes(f)) return 'skip';
  if (['tv', 'tvshort', 'tvspecial', 'ova', 'ona', 'special', 'show', 'series'].includes(f)) return 'tv';
  return null;
}

export interface AnimeEntry {
  key: string;
  title: string;
  year: number | null;
  format: string | null;
  episodes?: number | null;
  /** Minutes per episode. */
  duration?: number | null;
  ids: { mal?: number | null; anilist?: number | null; simkl?: number | null };
  sourceUrl: string | null;
  position: number;
  notes?: string | null;
  listedAt?: string | null;
  imdbId?: string | null;
  tmdbId?: number | null;
  tvdbId?: number | null;
}

/**
 * Turns an anime list entry into a source item. With a mapping, later seasons of a show (and split
 * cours) become season entries of the TMDb show, named after the anime entry.
 */
export function animeItem(e: AnimeEntry, map: AnimeIds | null): SourceItem | null {
  const type = animeMediaType(e.format);
  if (type === 'skip') return null;
  const base: SourceItem = {
    sourceKey: e.key,
    title: e.title,
    year: e.year,
    mediaType: type,
    sourceUrl: e.sourceUrl,
    position: e.position,
    notes: e.notes ?? null,
    listedAt: e.listedAt ?? null,
    runtime: e.duration ?? null,
    imdbId: e.imdbId ?? null,
    tmdbId: e.tmdbId ?? null,
    tvdbId: e.tvdbId ?? null,
  };
  const m = map?.ready ? map.lookup(e.ids) : undefined;
  if (!m) return { ...base, episodes: type === 'tv' ? (e.episodes ?? null) : null };
  if (m.tmdbMovie && (type === 'movie' || !m.tmdbTv)) return { ...base, mediaType: 'movie', tmdbId: m.tmdbMovie, imdbId: m.imdb ?? base.imdbId, episodes: null };
  if (m.tmdbTv) {
    const season = m.season;
    // One-season shows stay whole; later seasons, split cours and specials become season entries.
    const asSeason = season !== undefined && (season !== 1 || (m.offset ?? 0) > 0 || map!.isSplit(m.tmdbTv));
    return {
      ...base,
      mediaType: 'tv',
      tmdbId: m.tmdbTv,
      tvdbId: m.tvdb ?? base.tvdbId,
      imdbId: null, // anime IMDb ids point at the whole franchise; the TMDb id is exact
      seasonNumber: asSeason ? season : null,
      episodeTitle: asSeason ? e.title : null,
      episodes: e.episodes ?? null,
    };
  }
  if (m.tvdb) return { ...base, mediaType: 'tv', tvdbId: m.tvdb, episodes: e.episodes ?? null };
  return { ...base, imdbId: m.imdb ?? base.imdbId, episodes: type === 'tv' ? (e.episodes ?? null) : null };
}
