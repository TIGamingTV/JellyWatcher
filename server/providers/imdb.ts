import type { MediaType } from '../domain/matching.js';
import { headerIndex, parseCsvRows, toFloat, toInt } from './csv.js';
import { UploadError } from './letterboxd.js';
import type { ListFetchResult, SourceItem } from './types.js';

/**
 * IMDb adapter. IMDb has no API for personal lists and blocks automated access, so this only parses
 * the CSV produced by IMDb's own "Export" action. Column names are matched case-insensitively with
 * aliases because the export format has changed over time.
 */

const IMDB_ID = /\b(tt\d{5,10})\b/;

/** Maps IMDb "Title Type" values (camelCase or display labels) to a media type, or 'skip'. */
export function mapImdbTitleType(raw: string | undefined): MediaType | 'skip' | null {
  if (!raw) return null;
  const t = raw.toLowerCase().replace(/[\s_-]+/g, '');
  if (['movie', 'feature', 'tvmovie', 'video', 'short', 'tvshort', 'tvspecial', 'documentary', 'musicvideo'].includes(t)) return 'movie';
  if (['tvseries', 'tvminiseries', 'series', 'miniseries', 'tv'].includes(t)) return 'tv';
  if (['tvepisode', 'episode', 'videogame', 'game', 'podcastseries', 'podcastepisode', 'podcast'].includes(t)) return 'skip';
  return null;
}

export function parseImdbCsv(text: string, fallbackName: string): ListFetchResult {
  const rows = parseCsvRows(text).filter((r) => r.some((c) => c));
  const header = rows[0];
  if (!header) throw new UploadError('The file is empty.');
  const iConst = headerIndex(header, ['const', 'tconst', 'imdb id', 'imdbid', 'id']);
  const iTitle = headerIndex(header, ['title', 'primary title', 'name']);
  const iOrig = headerIndex(header, ['original title']);
  const iYear = headerIndex(header, ['year', 'release year', 'start year']);
  const iType = headerIndex(header, ['title type', 'type']);
  const iUrl = headerIndex(header, ['url']);
  const iPos = headerIndex(header, ['position', '#']);
  const iCreated = headerIndex(header, ['created', 'date added']);
  const iRated = headerIndex(header, ['your rating']);
  const iDesc = headerIndex(header, ['description']);
  if (iConst < 0 && iUrl < 0 && iTitle < 0) {
    throw new UploadError('This does not look like an IMDb export (expected Const, URL or Title columns).');
  }

  const items: SourceItem[] = [];
  let skipped = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    const idRaw = (iConst >= 0 ? row[iConst] : '') || (iUrl >= 0 ? row[iUrl] : '') || '';
    const imdbId = idRaw.match(IMDB_ID)?.[1] ?? null;
    const title = (iTitle >= 0 ? row[iTitle] : '') || (iOrig >= 0 ? row[iOrig] : '') || '';
    const type = mapImdbTitleType(iType >= 0 ? row[iType] : undefined);
    if (type === 'skip' || (!imdbId && !title)) {
      skipped++;
      continue;
    }
    items.push({
      sourceKey: imdbId ?? `${title.toLowerCase()}|${row[iYear] ?? ''}`,
      title: title || imdbId!,
      year: iYear >= 0 ? toInt(row[iYear]) : null,
      mediaType: type,
      imdbId,
      sourceUrl: imdbId ? `https://www.imdb.com/title/${imdbId}/` : null,
      position: iPos >= 0 ? toInt(row[iPos]) : r,
      listedAt: iCreated >= 0 ? row[iCreated] || null : null,
      rating: iRated >= 0 ? toFloat(row[iRated]) : null,
      notes: iDesc >= 0 ? row[iDesc] || null : null,
    });
  }
  if (items.length === 0 && skipped === 0) throw new UploadError('The file contains no titles.');
  return { info: { externalId: `upload:${fallbackName.toLowerCase()}`, name: fallbackName, kind: 'upload' }, items, skipped };
}
