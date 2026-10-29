import { z } from 'zod';
import { HttpClient, type FetchLike } from '../http/client.js';
import { ProviderError } from '../http/errors.js';
import { animeItem, type AnimeIds } from './anime.js';
import type { ListFetchResult, SourceItem } from './types.js';

/**
 * AniList adapter: the official public GraphQL API (https://graphql.anilist.co), no key needed for
 * public profiles. One query returns every anime list of a user. Verified 2026-10; AniList allows
 * 90 requests per minute (30 while degraded), JellyWatcher sends one per sync.
 */

export const ANILIST_API = 'https://graphql.anilist.co';
const ANILIST_USER = /^[A-Za-z0-9_-]{2,30}$/;

/** Accepts anilist.co/user/<name>/animelist[/<list>] links. */
export function parseAnilistUrl(input: string): { user: string; list: string | null } | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (!/^(www\.)?anilist\.co$/i.test(url.hostname)) return null;
  const parts = url.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  if (parts[0]?.toLowerCase() !== 'user' || !parts[1] || !ANILIST_USER.test(parts[1])) return null;
  if (parts[2] && parts[2].toLowerCase() !== 'animelist') return null;
  const list = parts[3]?.trim();
  return { user: parts[1], list: list && list.length <= 60 ? list : null };
}

const QUERY = `query JellyWatcherAnimeLists($user: String) {
  MediaListCollection(userName: $user, type: ANIME) {
    user { name siteUrl }
    lists { name status isCustomList entries {
      id status notes createdAt
      media { id idMal format episodes duration seasonYear startDate { year } title { romaji english } siteUrl }
    } }
  }
}`;

const Media = z.object({
  id: z.number(),
  idMal: z.number().nullish(),
  format: z.string().nullish(),
  episodes: z.number().nullish(),
  duration: z.number().nullish(),
  seasonYear: z.number().nullish(),
  startDate: z.object({ year: z.number().nullish() }).nullish(),
  title: z.object({ romaji: z.string().nullish(), english: z.string().nullish() }).nullish(),
  siteUrl: z.string().nullish(),
});
const Entry = z.object({ id: z.number(), status: z.string().nullish(), notes: z.string().nullish(), createdAt: z.number().nullish(), media: Media.nullish() });
const Response = z.object({
  data: z
    .object({
      MediaListCollection: z
        .object({
          user: z.object({ name: z.string(), siteUrl: z.string().nullish() }).nullish(),
          lists: z.array(z.object({ name: z.string(), status: z.string().nullish(), isCustomList: z.boolean().nullish(), entries: z.array(Entry).nullish() })).nullish(),
        })
        .nullish(),
    })
    .nullish(),
  errors: z.array(z.object({ message: z.string().nullish(), status: z.number().nullish() })).nullish(),
});

/** Names people use for AniList's status lists. */
const STATUS_NAMES: Record<string, string> = {
  planning: 'PLANNING',
  'plan to watch': 'PLANNING',
  watching: 'CURRENT',
  current: 'CURRENT',
  completed: 'COMPLETED',
  paused: 'PAUSED',
  'on hold': 'PAUSED',
  dropped: 'DROPPED',
  rewatching: 'REPEATING',
  repeating: 'REPEATING',
};

export function anilistEntryItem(e: z.infer<typeof Entry>, position: number, map: AnimeIds | null): SourceItem | null {
  const m = e.media;
  if (!m) return null;
  return animeItem(
    {
      key: `anilist:${m.id}`,
      title: m.title?.english || m.title?.romaji || `AniList ${m.id}`,
      year: m.seasonYear ?? m.startDate?.year ?? null,
      format: m.format ?? null,
      episodes: m.episodes ?? null,
      duration: m.duration ?? null,
      ids: { anilist: m.id, mal: m.idMal ?? null },
      sourceUrl: m.siteUrl ?? `https://anilist.co/anime/${m.id}`,
      position,
      notes: e.notes?.slice(0, 2000) || null,
      listedAt: e.createdAt ? new Date(e.createdAt * 1000).toISOString() : null,
    },
    map,
  );
}

export class AnilistClient {
  private readonly http: HttpClient;

  constructor(fetchImpl?: FetchLike) {
    this.http = new HttpClient({ provider: 'anilist', baseUrl: ANILIST_API, fetchImpl, retries: 2 });
  }

  /** Reads one list of a user: a status list (Planning by default, all of its format splits) or a custom list by name. */
  async list(user: string, listName: string | null, map: AnimeIds | null): Promise<ListFetchResult> {
    if (!ANILIST_USER.test(user)) throw new ProviderError('anilist', 'bad_request', 'That is not a valid AniList username.');
    const res = await this.http.post<unknown>('/', { query: QUERY, variables: { user } }, { retries: 2, acceptStatus: [404] });
    const parsed = Response.safeParse(res.data);
    if (!parsed.success) throw new ProviderError('anilist', 'invalid_response');
    const coll = parsed.data.data?.MediaListCollection;
    if (!coll) {
      const msg = parsed.data.errors?.[0]?.message ?? '';
      if (/private/i.test(msg)) throw new ProviderError('anilist', 'forbidden', 'That AniList profile is private.');
      throw new ProviderError('anilist', 'not_found', 'No AniList user was found with that name.');
    }
    const lists = coll.lists ?? [];
    const wanted = (listName ?? 'Planning').trim().toLowerCase();
    const status = STATUS_NAMES[wanted];
    const byName = lists.filter((l) => l.name.toLowerCase() === wanted);
    const chosen = byName.length > 0 ? byName : status ? lists.filter((l) => !l.isCustomList && l.status === status) : [];
    // A known status with no list yet is simply empty; an unknown name is a mistake in the link.
    if (chosen.length === 0 && !status) {
      const names = lists.map((l) => l.name).join(', ');
      throw new ProviderError('anilist', 'not_found', `${coll.user?.name ?? user} has no anime list called “${listName}”.${names ? ` Lists: ${names}.` : ''}`);
    }
    const items: SourceItem[] = [];
    const seen = new Set<number>();
    let skipped = 0;
    for (const l of chosen) {
      for (const e of l.entries ?? []) {
        if (!e.media || seen.has(e.media.id)) continue;
        seen.add(e.media.id);
        const item = anilistEntryItem(e, items.length + skipped + 1, map);
        if (item) items.push(item);
        else skipped++;
      }
    }
    const name = coll.user?.name ?? user;
    const label = byName[0]?.name ?? (listName ? listName : 'Planning');
    const path = byName[0]?.name ?? label;
    return {
      info: {
        externalId: `animelist:${name.toLowerCase()}:${label.toLowerCase()}`,
        name: `${name}’s ${label}`,
        kind: status === 'PLANNING' ? 'watchlist' : 'public',
        ownerName: name,
        url: `https://anilist.co/user/${name}/animelist/${encodeURIComponent(path)}`,
      },
      items,
      skipped,
    };
  }
}
