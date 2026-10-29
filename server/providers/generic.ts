import type { MediaType } from '../domain/matching.js';
import { animeItem, type AnimeIds } from './anime.js';
import { headerIndex, parseCsvRows, toFloat, toInt } from './csv.js';
import { UploadError } from './letterboxd.js';
import type { ListFetchResult, SourceItem } from './types.js';

/**
 * Tolerant CSV import for files that carry ids (TMDb, MDBList, Simkl and similar exports). Columns are
 * found by name, with the aliases those services and common tools use. A status column splits the
 * file into one list per status still to watch.
 */

export type WatchStatus = 'plan' | 'watching' | 'hold' | 'completed' | 'dropped';
export const STATUS_LABEL: Record<WatchStatus, string> = { plan: 'Plan to Watch', watching: 'Watching', hold: 'On Hold', completed: 'Completed', dropped: 'Dropped' };
/** Statuses imported as lists; completed and dropped are history, not something to watch. */
export const KEEP_STATUSES: WatchStatus[] = ['plan', 'watching', 'hold'];

export function normalizeStatus(raw: string | null | undefined): WatchStatus | null {
  const s = (raw ?? '').toLowerCase().replace(/[\s_-]+/g, '');
  if (!s) return null;
  if (['plantowatch', 'planning', 'planned', 'watchlist', 'ptw', 'wanttowatch', 'towatch'].includes(s)) return 'plan';
  if (['watching', 'current', 'currentlywatching', 'inprogress'].includes(s)) return 'watching';
  if (['hold', 'onhold', 'paused'].includes(s)) return 'hold';
  if (['completed', 'watched', 'finished', 'complete', 'seen'].includes(s)) return 'completed';
  if (['dropped', 'notinteresting', 'abandoned'].includes(s)) return 'dropped';
  return null;
}

export function mediaTypeOf(raw: string | null | undefined): MediaType | 'anime' | null {
  const t = (raw ?? '').toLowerCase().replace(/[\s_-]+/g, '');
  if (['movie', 'movies', 'film', 'films', 'feature'].includes(t)) return 'movie';
  if (['tv', 'show', 'shows', 'series', 'tvshow', 'tvseries', 'tvshows', 'miniseries'].includes(t)) return 'tv';
  if (t === 'anime') return 'anime';
  return null;
}

const IMDB = /\b(tt\d{5,10})\b/;

export interface GenericOptions {
  /** Provider name used in list names, e.g. "Simkl". */
  source: string;
  /** List name when the file has no status column. */
  fallbackName: string;
  urlFor?: (item: { tmdbId: number | null; mediaType: MediaType | null; imdbId: string | null; simklId: number | null }) => string | null;
  anime?: AnimeIds | null;
}

export function parseIdCsv(text: string, opts: GenericOptions): ListFetchResult[] {
  const rows = parseCsvRows(text).filter((r) => r.some((c) => c));
  const header = rows[0];
  if (!header) throw new UploadError('The file is empty.');
  const col = (...aliases: string[]) => headerIndex(header, aliases);
  const iTmdb = col('tmdb', 'tmdb id', 'tmdb_id', 'tmdbid', 'themoviedb id', 'id (tmdb)');
  const iImdb = col('imdb', 'imdb id', 'imdb_id', 'imdbid', 'const', 'url');
  const iTvdb = col('tvdb', 'tvdb id', 'tvdb_id', 'tvdbid');
  const iMal = col('mal', 'mal id', 'mal_id', 'malid', 'myanimelist id');
  const iAnilist = col('anilist', 'anilist id', 'anilist_id');
  const iSimkl = col('simkl', 'simkl id', 'simkl_id');
  const iTitle = col('title', 'name', 'original title', 'original_title');
  const iYear = col('year', 'release year', 'release_year', 'startyear');
  const iDate = col('release date', 'release_date', 'first air date', 'first_air_date', 'released');
  const iType = col('type', 'media type', 'mediatype', 'media_type', 'kind', 'title type');
  const iStatus = col('status', 'watchlist', 'list', 'list status');
  const iPos = col('position', 'rank', '#', 'order');
  const iNotes = col('memo', 'notes', 'comment', 'description');
  const iRating = col('rating', 'your rating', 'user rating');
  const iAdded = col('added', 'date added', 'added_at', 'created', 'listed at', 'listed_at');
  if (iTmdb < 0 && iImdb < 0 && iTvdb < 0 && iMal < 0 && iTitle < 0) {
    throw new UploadError('No usable columns found. The file needs a TMDb ID, IMDb ID, TVDB ID or title column.');
  }

  const groups = new Map<string, SourceItem[]>();
  let skipped = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    const cell = (i: number) => (i >= 0 ? (row[i] ?? '').trim() : '');
    const status = iStatus >= 0 ? normalizeStatus(cell(iStatus)) : null;
    if (status && !KEEP_STATUSES.includes(status)) {
      skipped++;
      continue;
    }
    const group = iStatus >= 0 && status ? status : '';
    const list = groups.get(group) ?? [];
    const kind = mediaTypeOf(cell(iType));
    const tmdbId = toInt(cell(iTmdb)) || null;
    const imdbId = cell(iImdb).match(IMDB)?.[1] ?? null;
    const tvdbId = toInt(cell(iTvdb)) || null;
    const mal = toInt(cell(iMal)) || null;
    const anilist = toInt(cell(iAnilist)) || null;
    const simkl = toInt(cell(iSimkl)) || null;
    const title = cell(iTitle);
    const year = toInt(cell(iYear)) ?? toInt(cell(iDate).slice(0, 4));
    if (!title && !tmdbId && !imdbId && !tvdbId && !mal) {
      skipped++;
      continue;
    }
    const position = toInt(cell(iPos)) ?? list.length + 1;
    const common = {
      notes: cell(iNotes) || null,
      rating: toFloat(cell(iRating)),
      listedAt: cell(iAdded) || null,
    };
    let item: SourceItem | null;
    if (kind === 'anime' || ((mal || anilist) && !tmdbId && !imdbId)) {
      item = animeItem(
        {
          key: mal ? `mal:${mal}` : anilist ? `anilist:${anilist}` : simkl ? `simkl:${simkl}` : `t:${title.toLowerCase()}|${year ?? ''}`,
          title: title || `Anime ${mal ?? anilist}`,
          year,
          format: kind === 'anime' ? null : kind,
          ids: { mal, anilist, simkl },
          sourceUrl: mal ? `https://myanimelist.net/anime/${mal}` : null,
          position,
          tmdbId,
          imdbId,
          tvdbId,
        },
        opts.anime ?? null,
      );
      if (item) item = { ...item, ...common };
    } else {
      const mediaType = kind ?? (tvdbId && !tmdbId ? 'tv' : null);
      // A bare TMDb id is ambiguous (movies and shows are numbered separately): it needs a type.
      const exactTmdb = tmdbId && mediaType ? tmdbId : null;
      item = {
        sourceKey: exactTmdb ? `tmdb:${mediaType}:${exactTmdb}` : imdbId ? `imdb:${imdbId}` : simkl ? `simkl:${simkl}` : tvdbId ? `tvdb:${tvdbId}` : `t:${mediaType ?? '?'}:${title.toLowerCase()}|${year ?? ''}`,
        title: title || imdbId || `TMDb ${tmdbId}`,
        year,
        mediaType,
        tmdbId: exactTmdb,
        imdbId,
        tvdbId,
        sourceUrl: opts.urlFor?.({ tmdbId: exactTmdb, mediaType, imdbId, simklId: simkl }) ?? null,
        position,
        ...common,
      };
    }
    if (!item) {
      skipped++;
      continue;
    }
    list.push(item);
    groups.set(group, list);
  }
  if (groups.size === 0) {
    throw new UploadError(skipped > 0 ? `Nothing to import: all ${skipped} entries are completed, dropped or unusable.` : 'The file contains no titles.');
  }
  const out = [...groups].map(([group, items]): ListFetchResult => {
    const status = group as WatchStatus | '';
    const name = status ? `${opts.source} ${STATUS_LABEL[status]}` : opts.fallbackName;
    return {
      info: { externalId: status === 'plan' ? 'watchlist' : status ? `upload:${status}` : `upload:${name.toLowerCase()}`, name, kind: status === 'plan' ? 'watchlist' : 'upload' },
      items,
      skipped: 0,
    };
  });
  out[0]!.skipped = skipped;
  return out;
}
