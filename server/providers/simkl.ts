import { unzipSync } from 'fflate';
import type { MediaType } from '../domain/matching.js';
import { animeItem, type AnimeIds } from './anime.js';
import { decodeText } from './csv.js';
import { KEEP_STATUSES, STATUS_LABEL, normalizeStatus, parseIdCsv, type WatchStatus } from './generic.js';
import { MAX_UNZIPPED_BYTES, MAX_ZIP_ENTRIES, UploadError } from './letterboxd.js';
import type { ListFetchResult, SourceItem } from './types.js';

/**
 * Simkl exports. Simkl shares lists only with apps a person signs in to, so JellyWatcher imports the
 * export instead: the CSV, or the JSON backup, whose entries look like the API's /sync/all-items
 * ({ movies: [{ status, movie: { title, year, ids } }], shows: [...], anime: [...] }).
 */

const simklUrl = (type: string, id: number | null) => (id ? `https://simkl.com/${type}/${id}` : null);

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function parseSimklJson(raw: unknown, anime: AnimeIds | null): ListFetchResult[] {
  if (!raw || typeof raw !== 'object') throw new UploadError('This is not a Simkl JSON export.');
  const root = raw as Record<string, unknown>;
  const groups = new Map<WatchStatus, SourceItem[]>();
  let skipped = 0;
  let seen = 0;
  for (const [section, fallbackType] of [
    ['movies', 'movie'],
    ['shows', 'tv'],
    ['anime', 'anime'],
  ] as const) {
    const entries = root[section];
    if (!Array.isArray(entries)) continue;
    for (const e of entries as Record<string, unknown>[]) {
      seen++;
      const media = (e.movie ?? e.show ?? e.anime) as Record<string, unknown> | undefined;
      const status = normalizeStatus(str(e.status) ?? str(e.watchlist));
      if (!media || !status || !KEEP_STATUSES.includes(status)) {
        skipped++;
        continue;
      }
      const ids = (media.ids ?? {}) as Record<string, unknown>;
      const title = str(media.title);
      const simkl = num(ids.simkl) ?? num(ids.simkl_id);
      const list = groups.get(status) ?? [];
      const listedAt = str(e.added_to_watchlist_at) ?? str(e.last_watched_at);
      let item: SourceItem | null;
      if (fallbackType === 'anime') {
        const animeType = str(e.anime_type);
        item = animeItem(
          {
            key: `simkl:${simkl ?? title}`,
            title: title ?? `Simkl ${simkl}`,
            year: num(media.year),
            format: animeType === 'movie' ? 'movie' : animeType ? 'tv' : null,
            episodes: num(e.total_episodes_count),
            ids: { simkl, mal: num(ids.mal), anilist: num(ids.anilist) },
            sourceUrl: simklUrl('anime', simkl),
            position: list.length + 1,
            listedAt,
            tmdbId: num(ids.tmdb),
            imdbId: str(ids.imdb),
            tvdbId: num(ids.tvdb),
          },
          anime,
        );
      } else {
        const mediaType: MediaType = fallbackType;
        const imdbId = str(ids.imdb);
        const tmdbId = num(ids.tmdb);
        if (!title && !imdbId && !tmdbId) item = null;
        else
          item = {
            sourceKey: simkl ? `simkl:${simkl}` : imdbId ? `imdb:${imdbId}` : `tmdb:${mediaType}:${tmdbId}`,
            title: title ?? imdbId ?? `TMDb ${tmdbId}`,
            year: num(media.year),
            mediaType,
            tmdbId,
            imdbId,
            tvdbId: num(ids.tvdb),
            sourceUrl: simklUrl(mediaType === 'movie' ? 'movies' : 'tv', simkl),
            position: list.length + 1,
            listedAt,
          };
      }
      if (!item) {
        skipped++;
        continue;
      }
      list.push(item);
      groups.set(status, list);
    }
  }
  if (seen === 0) throw new UploadError('This does not look like a Simkl export (no movies, shows or anime).');
  return toLists(groups, skipped);
}

function toLists(groups: Map<WatchStatus, SourceItem[]>, skipped: number): ListFetchResult[] {
  const out = [...groups].map(([status, items]): ListFetchResult => ({
    info: { externalId: status === 'plan' ? 'watchlist' : `upload:${status}`, name: `Simkl ${STATUS_LABEL[status]}`, kind: status === 'plan' ? 'watchlist' : 'upload' },
    items,
    skipped: 0,
  }));
  if (out.length === 0) throw new UploadError(`Nothing to import: all ${skipped} entries are completed, dropped or unusable.`);
  out[0]!.skipped = skipped;
  return out;
}

const urlFor = ({ simklId, mediaType }: { simklId: number | null; mediaType: MediaType | null }) => simklUrl(mediaType === 'movie' ? 'movies' : 'tv', simklId);

/** Reads a Simkl export: CSV, JSON, or a ZIP containing either. */
export function parseSimklExport(filename: string, buf: Uint8Array, anime: AnimeIds | null): ListFetchResult[] {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.zip')) {
    let files: Record<string, Uint8Array>;
    let count = 0;
    let total = 0;
    try {
      files = unzipSync(buf, {
        filter: (f) => {
          if (!/\.(json|csv)$/i.test(f.name) || f.name.startsWith('__MACOSX/')) return false;
          // fflate never unpacks more than the declared size, so this caps memory use.
          count++;
          total += f.originalSize;
          if (count > MAX_ZIP_ENTRIES || total > MAX_UNZIPPED_BYTES) throw new UploadError('The archive is too large.');
          return true;
        },
      });
    } catch (err) {
      if (err instanceof UploadError) throw err;
      throw new UploadError('The ZIP file could not be read.');
    }
    const names = Object.keys(files).sort((a, b) => Number(b.endsWith('.json')) - Number(a.endsWith('.json')));
    if (names.length === 0) throw new UploadError('No CSV or JSON file was found in the archive.');
    return parseSimklExport(names[0]!, files[names[0]!]!, anime);
  }
  const text = decodeText(buf);
  if (lower.endsWith('.json')) {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new UploadError('The JSON file could not be read.');
    }
    return parseSimklJson(raw, anime);
  }
  if (lower.endsWith('.csv')) return parseIdCsv(text, { source: 'Simkl', fallbackName: 'Simkl Watchlist', urlFor, anime });
  throw new UploadError('Upload the Simkl export as CSV, JSON or ZIP.');
}
