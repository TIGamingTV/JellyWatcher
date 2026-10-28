import { XMLParser } from 'fast-xml-parser';
import { unzipSync } from 'fflate';
import { HttpClient, type FetchLike } from '../http/client.js';
import { ProviderError } from '../http/errors.js';
import { decodeText, headerIndex, parseCsvRows, toFloat, toInt } from './csv.js';
import type { ListFetchResult, SourceItem } from './types.js';

/**
 * Letterboxd adapter. Letterboxd's API is not available to personal projects, so this adapter only
 * reads data the member provides: their account export (ZIP), single list exports (CSV), and their
 * public RSS feed (recent diary entries, which include TMDb ids).
 */

const MAX_ZIP_ENTRIES = 2000;
const MAX_UNZIPPED_BYTES = 80 * 1024 * 1024;

export const LETTERBOXD_USERNAME = /^[A-Za-z0-9_]{1,40}$/;

export class UploadError extends Error {}

function itemsFromRows(rows: string[][], headerRow: number): { items: SourceItem[]; skipped: number } {
  const header = rows[headerRow] ?? [];
  const iName = headerIndex(header, ['name', 'title']);
  const iYear = headerIndex(header, ['year']);
  const iUri = headerIndex(header, ['letterboxd uri', 'url', 'uri']);
  const iPos = headerIndex(header, ['position']);
  const iDate = headerIndex(header, ['date']);
  const iDesc = headerIndex(header, ['description']);
  const iRating = headerIndex(header, ['rating']);
  if (iName < 0) throw new UploadError('The file has no "Name" column. Upload an unmodified Letterboxd export.');

  const items: SourceItem[] = [];
  let skipped = 0;
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r]!;
    if (row.every((c) => !c)) {
      // A blank line ends the item block in list exports.
      if (items.length > 0) break;
      continue;
    }
    const title = row[iName]?.trim();
    if (!title) {
      skipped++;
      continue;
    }
    const year = toInt(row[iYear]);
    const uri = iUri >= 0 ? row[iUri]?.trim() || null : null;
    items.push({
      sourceKey: uri ?? `${title.toLowerCase()}|${year ?? ''}`,
      title,
      year,
      mediaType: 'movie',
      sourceUrl: uri,
      position: iPos >= 0 ? toInt(row[iPos]) : items.length + 1,
      listedAt: iDate >= 0 ? row[iDate] || null : null,
      notes: iDesc >= 0 ? row[iDesc] || null : null,
      rating: iRating >= 0 ? toFloat(row[iRating]) : null,
    });
  }
  return { items, skipped };
}

/** Finds the row that heads the film table: it must contain Name and Year. */
function findItemHeader(rows: string[][]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (headerIndex(row, ['name']) >= 0 && headerIndex(row, ['year']) >= 0) {
      // In list exports the metadata block also has a Name column; the film table follows it.
      return i;
    }
  }
  return -1;
}

/**
 * Parses a Letterboxd CSV: either a simple table (watchlist.csv) or a list export, which starts with a
 * "Letterboxd list export" line and a metadata block (Date, Name, Tags, URL, Description).
 */
export function parseLetterboxdCsv(text: string, fallbackName: string): ListFetchResult {
  const rows = parseCsvRows(text);
  if (rows.length === 0) throw new UploadError('The file is empty.');
  let name = fallbackName;
  let description: string | null = null;
  let url: string | null = null;

  if (/^letterboxd list export/i.test(rows[0]?.[0] ?? '')) {
    const metaHeader = rows[1] ?? [];
    const meta = rows[2] ?? [];
    const iN = headerIndex(metaHeader, ['name']);
    const iU = headerIndex(metaHeader, ['url']);
    const iD = headerIndex(metaHeader, ['description']);
    if (iN >= 0 && meta[iN]) name = meta[iN]!;
    if (iU >= 0 && meta[iU]) url = meta[iU]!;
    if (iD >= 0 && meta[iD]) description = meta[iD]!;
  }
  const headerRow = findItemHeader(rows);
  if (headerRow < 0) throw new UploadError('This does not look like a Letterboxd export (missing Name and Year columns).');
  const { items, skipped } = itemsFromRows(rows, headerRow);
  const externalId = url ? `list:${url.toLowerCase().replace(/\/+$/, '')}` : `upload:${name.toLowerCase()}`;
  return { info: { externalId, name, kind: 'upload', description, url }, items, skipped };
}

/**
 * Parses the account export ZIP. Imports watchlist.csv and every lists/*.csv. Diary, ratings and
 * watched films are not imported as watchlists.
 */
export function parseLetterboxdZip(buf: Uint8Array): ListFetchResult[] {
  let total = 0;
  let count = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(buf, {
      filter: (f) => {
        count++;
        total += f.originalSize;
        if (count > MAX_ZIP_ENTRIES || total > MAX_UNZIPPED_BYTES) throw new UploadError('The archive is too large.');
        const lower = f.name.toLowerCase();
        if (lower.includes('deleted/') || lower.includes('orphaned/') || lower.startsWith('__macosx/')) return false;
        return lower.endsWith('watchlist.csv') || (/(^|\/)lists\/[^/]+\.csv$/.test(lower));
      },
    });
  } catch (err) {
    if (err instanceof UploadError) throw err;
    throw new UploadError('The ZIP file could not be read.');
  }
  const out: ListFetchResult[] = [];
  for (const [path, data] of Object.entries(files)) {
    const lower = path.toLowerCase();
    if (lower.endsWith('watchlist.csv') && !lower.includes('lists/')) {
      const res = parseLetterboxdCsv(decodeText(data), 'Letterboxd Watchlist');
      out.push({ ...res, info: { ...res.info, externalId: 'watchlist', name: 'Letterboxd Watchlist', kind: 'watchlist' } });
    } else {
      const base = path.split('/').pop()!.replace(/\.csv$/i, '').replace(/[-_]+/g, ' ');
      out.push(parseLetterboxdCsv(decodeText(data), base));
    }
  }
  if (out.length === 0) throw new UploadError('No watchlist.csv or lists were found in the archive.');
  return out;
}

const xml = new XMLParser({ ignoreAttributes: true, processEntities: true, htmlEntities: true, parseTagValue: false });

/** Parses the public RSS feed; only diary/review entries with film data are returned. */
export function parseLetterboxdRss(text: string, username: string): ListFetchResult {
  let doc: any;
  try {
    doc = xml.parse(text);
  } catch {
    throw new ProviderError('letterboxd', 'invalid_response');
  }
  const channel = doc?.rss?.channel;
  if (!channel) throw new ProviderError('letterboxd', 'invalid_response');
  const rawItems = Array.isArray(channel.item) ? channel.item : channel.item ? [channel.item] : [];
  const items: SourceItem[] = [];
  let skipped = 0;
  for (const it of rawItems) {
    const title = it['letterboxd:filmTitle'];
    if (!title) {
      skipped++; // list announcements and other entries
      continue;
    }
    const guid = typeof it.guid === 'string' ? it.guid : String(it.guid?.['#text'] ?? it.link ?? title);
    items.push({
      sourceKey: guid,
      title: String(title),
      year: toInt(String(it['letterboxd:filmYear'] ?? '')),
      mediaType: 'movie',
      tmdbId: toInt(String(it['tmdb:movieId'] ?? '')),
      sourceUrl: typeof it.link === 'string' ? it.link : null,
      watchedAt: it['letterboxd:watchedDate'] ? String(it['letterboxd:watchedDate']) : null,
      rating: toFloat(String(it['letterboxd:memberRating'] ?? '')),
      position: items.length + 1,
    });
  }
  return {
    info: {
      externalId: 'rss:diary',
      name: 'Letterboxd Diary',
      kind: 'diary',
      description: 'Your most recent diary entries from your public Letterboxd RSS feed.',
      ownerName: username,
      url: `https://letterboxd.com/${username}/`,
    },
    items,
    skipped,
  };
}

export class LetterboxdRssClient {
  private readonly http: HttpClient;

  constructor(fetchImpl?: FetchLike) {
    this.http = new HttpClient({ provider: 'letterboxd', baseUrl: 'https://letterboxd.com', fetchImpl, retries: 2 });
  }

  async diary(username: string): Promise<ListFetchResult> {
    if (!LETTERBOXD_USERNAME.test(username)) throw new ProviderError('letterboxd', 'bad_request', 'That is not a valid Letterboxd username.');
    try {
      const res = await this.http.get<string>(`/${username}/rss/`, undefined, {
        responseType: 'text',
        headers: { Accept: 'application/rss+xml, application/xml;q=0.9' },
      });
      return parseLetterboxdRss(res.data, username);
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'not_found') {
        throw new ProviderError('letterboxd', 'not_found', 'No public Letterboxd profile was found for that username.');
      }
      if (err instanceof ProviderError && err.kind === 'forbidden') {
        throw new ProviderError('letterboxd', 'forbidden', 'Letterboxd refused the RSS request (it may be challenging automated traffic). Try again later.');
      }
      throw err;
    }
  }
}
