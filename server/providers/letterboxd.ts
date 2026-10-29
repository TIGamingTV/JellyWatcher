import { XMLParser } from 'fast-xml-parser';
import { unzipSync } from 'fflate';
import { HttpClient, type FetchLike } from '../http/client.js';
import { ProviderError } from '../http/errors.js';
import { decodeText, headerIndex, parseCsvRows, toFloat, toInt } from './csv.js';
import { attr, metaContent } from './html.js';
import type { ListFetchResult, SourceItem, SourceListInfo } from './types.js';

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

// ---- Public lists and watchlists by link -------------------------------------------------------

/** A public Letterboxd list (slug) or watchlist (slug null) of a member. */
export interface LetterboxdPageRef {
  user: string;
  slug: string | null;
}

const LB_SLUG = /^[a-z0-9][a-z0-9-]{0,150}$/i;

/** Parses letterboxd.com/<user>/list/<slug>/… and /<user>/watchlist/… links; 'short' for boxd.it links. */
export function parseLetterboxdUrl(input: string): LetterboxdPageRef | 'short' | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (/^boxd\.it$/i.test(url.hostname)) return /^\/[A-Za-z0-9]{2,12}\/?$/.test(url.pathname) ? 'short' : null;
  if (!/^(www\.)?letterboxd\.com$/i.test(url.hostname)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  const user = parts[0];
  if (!user || !LETTERBOXD_USERNAME.test(user)) return null;
  if (parts[1] === 'watchlist') return { user: user.toLowerCase(), slug: null };
  if (parts[1] === 'list' && parts[2] && LB_SLUG.test(parts[2])) return { user: user.toLowerCase(), slug: parts[2].toLowerCase() };
  return null;
}

export const letterboxdPageUrl = (ref: LetterboxdPageRef) => `https://letterboxd.com/${ref.user}/${ref.slug ? `list/${ref.slug}` : 'watchlist'}/`;

/** Reads the films of one page of a list or watchlist, in page order, plus the number of pages. */
export function parseLetterboxdPage(html: string, basePath?: string): { films: { slug: string; title: string; year: number | null }[]; pages: number; title: string | null; description: string | null } {
  const films: { slug: string; title: string; year: number | null }[] = [];
  const seen = new Set<string>();
  for (const tag of html.match(/<[a-z]+\s[^>]*data-(?:item|film)-slug=[^>]*>/gi) ?? []) {
    const slug = attr(tag, 'data-item-slug') ?? attr(tag, 'data-film-slug');
    if (!slug || seen.has(slug)) continue;
    const name = attr(tag, 'data-item-name') ?? attr(tag, 'data-item-full-display-name') ?? attr(tag, 'data-film-name') ?? slug;
    const m = name.match(/^(.*?)\s*\((\d{4})\)$/);
    seen.add(slug);
    films.push({ slug, title: (m ? m[1]! : name).trim(), year: m ? Number(m[2]) : null });
  }
  let pages = 1;
  const esc = (basePath ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const m of html.matchAll(new RegExp(`${esc}${basePath ? '' : '/'}page/(\\d{1,4})/?["']`, 'gi'))) pages = Math.max(pages, Number(m[1]));
  return { films, pages, title: metaContent(html, 'og:title'), description: metaContent(html, 'og:description') };
}

export class LetterboxdWebClient {
  private readonly http: HttpClient;

  constructor(private readonly fetchImpl?: FetchLike) {
    this.http = new HttpClient({ provider: 'letterboxd', baseUrl: 'https://letterboxd.com', fetchImpl, retries: 2, minIntervalMs: 400, timeoutMs: 20_000 });
  }

  private async page(path: string): Promise<string> {
    try {
      return (await this.http.get<string>(path, undefined, { responseType: 'text', headers: { Accept: 'text/html,application/xhtml+xml' } })).data;
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'not_found') throw new ProviderError('letterboxd', 'not_found', 'No public Letterboxd list was found at that link. Private lists can be imported from an export.');
      if (err instanceof ProviderError && err.kind === 'forbidden') {
        throw new ProviderError('letterboxd', 'forbidden', 'Letterboxd refused the request (it may be challenging automated traffic). Try again later, or upload an export.');
      }
      throw err;
    }
  }

  /** Follows a boxd.it short link to the list it points at. */
  async resolveShort(url: string): Promise<LetterboxdPageRef | null> {
    const http = new HttpClient({ provider: 'letterboxd', baseUrl: 'https://boxd.it', retries: 1, fetchImpl: this.fetchImpl });
    const res = await http.get<string>(new URL(url).pathname, undefined, { responseType: 'text', headers: { Accept: 'text/html' } });
    const target = metaContent(res.data, 'og:url');
    const ref = target ? parseLetterboxdUrl(target) : null;
    return ref && ref !== 'short' ? ref : null;
  }

  async list(ref: LetterboxdPageRef, ownUsername?: string | null): Promise<ListFetchResult> {
    const base = letterboxdPageUrl(ref).replace('https://letterboxd.com', '');
    const first = parseLetterboxdPage(await this.page(base), base);
    const films = [...first.films];
    const pages = Math.min(first.pages, 100);
    for (let p = 2; p <= pages; p++) films.push(...parseLetterboxdPage(await this.page(`${base}page/${p}/`), base).films);
    if (films.length === 0 && /Just a moment|challenge-platform/i.test(first.title ?? '')) {
      throw new ProviderError('letterboxd', 'forbidden', 'Letterboxd is challenging automated traffic right now. Try again later, or upload an export.');
    }
    const items: SourceItem[] = [];
    const keys = new Set<string>();
    for (const f of films) {
      const sourceUrl = `https://letterboxd.com/film/${f.slug}/`;
      if (keys.has(sourceUrl)) continue;
      keys.add(sourceUrl);
      items.push({ sourceKey: sourceUrl, title: f.title, year: f.year, mediaType: 'movie', sourceUrl, position: items.length + 1 });
    }
    const url = letterboxdPageUrl(ref);
    const own = Boolean(ownUsername && ownUsername.toLowerCase() === ref.user);
    const info: SourceListInfo = ref.slug
      ? {
          externalId: `list:${url.toLowerCase().replace(/\/+$/, '')}`,
          name: first.title?.trim() || ref.slug.replace(/-/g, ' '),
          kind: own ? 'owned' : 'public',
          description: first.description?.trim() || null,
          ownerName: ref.user,
          url,
          itemCount: items.length,
        }
      : {
          // Your own watchlist replaces an uploaded one; someone else's is a public list.
          externalId: own ? 'watchlist' : `watchlist:${ref.user}`,
          name: own ? 'Letterboxd Watchlist' : first.title?.trim() || `${ref.user}’s Watchlist`,
          kind: own ? 'watchlist' : 'public',
          ownerName: ref.user,
          url,
          itemCount: items.length,
        };
    return { info, items, skipped: 0 };
  }
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
