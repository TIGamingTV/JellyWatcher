import { XMLParser } from 'fast-xml-parser';
import { gunzipSync } from 'fflate';
import { z } from 'zod';
import { HttpClient, type FetchLike } from '../http/client.js';
import { ProviderError } from '../http/errors.js';
import { animeItem, type AnimeIds } from './anime.js';
import { decodeText, toInt } from './csv.js';
import { UploadError } from './letterboxd.js';
import type { ListFetchResult, SourceItem } from './types.js';

/**
 * MyAnimeList adapter.
 * - Public anime lists by link: the JSON the list page itself loads
 *   (myanimelist.net/animelist/<user>/load.json?status=<n>&offset=<k>, 300 entries per page). No
 *   client id needed. Verified 2026-10.
 * - The XML export (Profile › Export Lists), usually gzipped.
 */

export const MAL_STATUS: Record<number, string> = { 1: 'Watching', 2: 'Completed', 3: 'On Hold', 4: 'Dropped', 6: 'Plan to Watch', 7: 'All Anime' };
const MAL_USER = /^[\w-]{2,32}$/;
const PAGE = 300;

/** Accepts myanimelist.net/animelist/<user> links; the status parameter picks the list (default Plan to Watch). */
export function parseMalListUrl(input: string): { user: string; status: number } | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (!/^(www\.)?myanimelist\.net$/i.test(url.hostname)) return null;
  const m = url.pathname.match(/^\/animelist\/([^/]+)\/?$/i);
  if (!m || !MAL_USER.test(decodeURIComponent(m[1]!))) return null;
  const status = Number(url.searchParams.get('status') ?? 6);
  return { user: decodeURIComponent(m[1]!), status: MAL_STATUS[status] ? status : 6 };
}

const Entry = z.object({
  anime_id: z.number(),
  anime_title: z.union([z.string(), z.number()]).nullish(),
  anime_title_eng: z.union([z.string(), z.number()]).nullish(),
  anime_num_episodes: z.number().nullish(),
  anime_media_type_string: z.string().nullish(),
  anime_start_date_string: z.string().nullish(),
  notes: z.string().nullish(),
  created_at: z.number().nullish(),
  status: z.number().nullish(),
});

/** "04-08-11" (MM-DD-YY) → 2011. */
export function malYear(s: string | null | undefined): number | null {
  const m = s?.match(/^\d{2}-\d{2}-(\d{2})$/) ?? s?.match(/^(\d{4})-/);
  if (!m) return null;
  const y = Number(m[1]);
  if (m[1]!.length === 4) return y || null;
  const now = new Date().getFullYear() % 100;
  return y <= now + 2 ? 2000 + y : 1900 + y;
}

const text = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());

export function malEntryItem(raw: unknown, position: number, map: AnimeIds | null): SourceItem | null {
  const p = Entry.safeParse(raw);
  if (!p.success) return null;
  const e = p.data;
  const eng = text(e.anime_title_eng);
  return animeItem(
    {
      key: `mal:${e.anime_id}`,
      title: eng || text(e.anime_title) || `MAL ${e.anime_id}`,
      year: malYear(e.anime_start_date_string),
      format: e.anime_media_type_string ?? null,
      episodes: e.anime_num_episodes || null,
      ids: { mal: e.anime_id },
      sourceUrl: `https://myanimelist.net/anime/${e.anime_id}`,
      position,
      notes: e.notes || null,
      listedAt: e.created_at ? new Date(e.created_at * 1000).toISOString() : null,
    },
    map,
  );
}

export class MalClient {
  private readonly http: HttpClient;

  constructor(fetchImpl?: FetchLike) {
    this.http = new HttpClient({ provider: 'myanimelist', baseUrl: 'https://myanimelist.net', fetchImpl, retries: 2, minIntervalMs: 500 });
  }

  async list(user: string, status: number, map: AnimeIds | null): Promise<ListFetchResult> {
    if (!MAL_USER.test(user)) throw new ProviderError('myanimelist', 'bad_request', 'That is not a valid MyAnimeList username.');
    const items: SourceItem[] = [];
    let skipped = 0;
    for (let page = 0; page < 40; page++) {
      let data: unknown;
      try {
        data = (await this.http.get<unknown>(`/animelist/${encodeURIComponent(user)}/load.json`, { status, offset: page * PAGE })).data;
      } catch (err) {
        if (err instanceof ProviderError && (err.kind === 'bad_request' || err.kind === 'not_found' || err.kind === 'forbidden')) {
          throw new ProviderError('myanimelist', 'not_found', 'That MyAnimeList list was not found or is private.');
        }
        throw err;
      }
      if (!Array.isArray(data)) throw new ProviderError('myanimelist', 'invalid_response');
      for (const raw of data) {
        const item = malEntryItem(raw, items.length + skipped + 1, map);
        if (item) items.push(item);
        else skipped++;
      }
      if (data.length < PAGE) break;
    }
    const label = MAL_STATUS[status] ?? 'Anime List';
    return {
      info: {
        externalId: `animelist:${user.toLowerCase()}:${status}`,
        name: `${user}’s ${label}`,
        kind: status === 6 ? 'watchlist' : 'public',
        ownerName: user,
        url: `https://myanimelist.net/animelist/${user}?status=${status}`,
      },
      items,
      skipped,
    };
  }
}

const xml = new XMLParser({ ignoreAttributes: true, processEntities: true, htmlEntities: true, parseTagValue: false, isArray: (name) => name === 'anime' });

/** Statuses imported from exports: what is still to watch. Completed and dropped are history. */
const KEEP: Record<string, string> = { 'watching': 'Watching', 'plan to watch': 'Plan to Watch', 'on-hold': 'On Hold', 'on hold': 'On Hold', '1': 'Watching', '6': 'Plan to Watch', '3': 'On Hold' };

/** Reads a MyAnimeList XML export (plain or gzipped); one list per status still to watch. */
export function parseMalExport(buf: Uint8Array, provider: 'myanimelist' | 'anilist', map: AnimeIds | null): ListFetchResult[] {
  let data = buf;
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      data = gunzipSync(buf);
    } catch {
      throw new UploadError('The .gz file could not be unpacked.');
    }
  }
  let doc: any;
  try {
    doc = xml.parse(decodeText(data));
  } catch {
    throw new UploadError('This is not a valid XML file.');
  }
  const root = doc?.myanimelist;
  if (!root) throw new UploadError('This does not look like a MyAnimeList export (no <myanimelist> element).');
  const anime: Record<string, unknown>[] = root.anime ?? [];
  if (anime.length === 0) throw new UploadError('The file contains no anime. Export your anime list, not your manga list.');
  const user = text(root.myinfo?.user_name) || null;

  const groups = new Map<string, SourceItem[]>();
  let skipped = 0;
  for (const a of anime) {
    const status = KEEP[text(a.my_status).toLowerCase()];
    if (!status) {
      skipped++;
      continue;
    }
    const id = toInt(text(a.series_animedb_id));
    const title = text(a.series_title);
    if (!id || !title) {
      skipped++;
      continue;
    }
    const list = groups.get(status) ?? [];
    const item = animeItem(
      {
        key: `mal:${id}`,
        title,
        year: null,
        format: text(a.series_type) || null,
        episodes: toInt(text(a.series_episodes)) || null,
        ids: { mal: id },
        sourceUrl: `https://myanimelist.net/anime/${id}`,
        position: list.length + 1,
        notes: text(a.my_comments) || null,
      },
      map,
    );
    if (!item) {
      skipped++;
      continue;
    }
    list.push(item);
    groups.set(status, list);
  }
  const source = provider === 'anilist' ? 'AniList' : 'MyAnimeList';
  const out: ListFetchResult[] = [...groups].map(([status, items]) => ({
    info: {
      externalId: status === 'Plan to Watch' ? 'watchlist' : `upload:${status.toLowerCase()}`,
      name: `${source} ${status}`,
      kind: status === 'Plan to Watch' ? 'watchlist' : 'upload',
      ownerName: user,
    },
    items,
    skipped: 0,
  }));
  if (out.length === 0) throw new UploadError(`Nothing to import: the export has no Watching, Plan to Watch or On Hold entries (${skipped} completed or dropped).`);
  out[0]!.skipped = skipped;
  return out;
}
