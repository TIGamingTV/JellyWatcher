import { z } from 'zod';
import { HttpClient, type FetchLike } from '../http/client.js';
import { ProviderError } from '../http/errors.js';
import { metaContent } from './html.js';
import type { ListFetchResult, SourceItem } from './types.js';

/**
 * MDBList adapter. Every public list has a JSON feed at <list url>/json (no API key), in list order,
 * with the TMDb id (`id`), IMDb id, TVDB id, media type and release year. Verified 2026-10.
 */

const SLUG = /^[\w.~-]{1,100}$/;

/** Accepts mdblist.com/lists/<user>/<list> links. */
export function parseMdblistUrl(input: string): { user: string; slug: string } | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (!/^(www\.)?mdblist\.com$/i.test(url.hostname)) return null;
  const parts = url.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  if (parts[0] !== 'lists' || !parts[1] || !parts[2] || !SLUG.test(parts[1]) || !SLUG.test(parts[2]) || ['json', 'csv'].includes(parts[2])) return null;
  return { user: parts[1], slug: parts[2] };
}

const Entry = z.object({
  id: z.number().nullish(),
  rank: z.number().nullish(),
  title: z.string().nullish(),
  imdb_id: z.string().nullish(),
  tvdbid: z.number().nullish(),
  mediatype: z.string().nullish(),
  release_year: z.number().nullish(),
});

export function mdblistItem(raw: unknown, position: number): SourceItem | null {
  const p = Entry.safeParse(raw);
  if (!p.success) return null;
  const e = p.data;
  const mediaType = e.mediatype === 'movie' ? 'movie' : e.mediatype === 'show' ? 'tv' : null;
  if (!mediaType || (!e.id && !e.imdb_id)) return null;
  const imdbId = e.imdb_id && /^tt\d+$/.test(e.imdb_id) ? e.imdb_id : null;
  return {
    sourceKey: e.id ? `tmdb:${mediaType}:${e.id}` : `imdb:${imdbId}`,
    title: e.title || imdbId || `TMDb ${e.id}`,
    year: e.release_year ?? null,
    mediaType,
    tmdbId: e.id ?? null,
    imdbId,
    tvdbId: mediaType === 'tv' ? (e.tvdbid ?? null) : null,
    sourceUrl: e.id ? `https://www.themoviedb.org/${mediaType}/${e.id}` : imdbId ? `https://www.imdb.com/title/${imdbId}/` : null,
    position,
  };
}

const titleCase = (slug: string) => slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export class MdblistClient {
  private readonly http: HttpClient;

  constructor(fetchImpl?: FetchLike) {
    this.http = new HttpClient({ provider: 'mdblist', baseUrl: 'https://mdblist.com', fetchImpl, retries: 2, timeoutMs: 30_000 });
  }

  async list(user: string, slug: string): Promise<ListFetchResult> {
    if (!SLUG.test(user) || !SLUG.test(slug)) throw new ProviderError('mdblist', 'bad_request', 'That is not an MDBList list link.');
    let data: unknown;
    try {
      data = (await this.http.get<unknown>(`/lists/${encodeURIComponent(user)}/${encodeURIComponent(slug)}/json`)).data;
    } catch (err) {
      if (err instanceof ProviderError && (err.kind === 'not_found' || err.kind === 'forbidden')) throw new ProviderError('mdblist', 'not_found', 'That MDBList list was not found or is private.');
      if (err instanceof ProviderError && err.kind === 'invalid_response') throw new ProviderError('mdblist', 'not_found', 'That MDBList list was not found or is private.');
      throw err;
    }
    if (!Array.isArray(data)) throw new ProviderError('mdblist', 'not_found', 'That MDBList list was not found or is private.');
    const items: SourceItem[] = [];
    let skipped = 0;
    for (const raw of data) {
      const item = mdblistItem(raw, items.length + skipped + 1);
      if (item) items.push(item);
      else skipped++;
    }
    // The feed has no list name; the page title has ("<name>, a list by <owner>"). Best effort.
    let name = titleCase(slug);
    let owner = user;
    try {
      const page = await this.http.get<string>(`/lists/${encodeURIComponent(user)}/${encodeURIComponent(slug)}`, undefined, { responseType: 'text', retries: 0, headers: { Accept: 'text/html' } });
      const og = metaContent(page.data, 'og:title');
      const m = og?.match(/^(.*), a list by (.*)$/);
      if (m?.[1]) {
        name = m[1].trim().slice(0, 120);
        owner = m[2]!.trim().slice(0, 80) || user;
      } else if (og) name = og.trim().slice(0, 120);
    } catch {
      /* keep the name from the link */
    }
    return {
      info: {
        externalId: `list:${user.toLowerCase()}/${slug.toLowerCase()}`,
        name,
        kind: 'public',
        ownerName: owner,
        url: `https://mdblist.com/lists/${user}/${slug}`,
        itemCount: data.length,
      },
      items,
      skipped,
    };
  }
}
