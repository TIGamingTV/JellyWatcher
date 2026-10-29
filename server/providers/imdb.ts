import { z } from 'zod';
import type { MediaType } from '../domain/matching.js';
import { HttpClient, type FetchLike } from '../http/client.js';
import { ProviderError } from '../http/errors.js';
import { headerIndex, parseCsvRows, toFloat, toInt } from './csv.js';
import { UploadError } from './letterboxd.js';
import type { ListFetchResult, SourceItem } from './types.js';

/**
 * IMDb adapter.
 * - Public lists (imdb.com/list/ls…) are read through IMDb's public GraphQL endpoint, which the
 *   IMDb website itself uses. It needs no account or key, keeps the list order and includes
 *   episodes with their show. IMDb permits only limited, non-commercial use of this data.
 *   Verified 2026-10: POST https://api.graphql.imdb.com/, requires an `x-imdb-client-name` header.
 * - Private lists and watchlists are imported from the CSV that IMDb's "Export" action produces.
 *   Column names are matched case-insensitively with aliases because the format has changed. The
 *   CSV lists episodes by their own id only; their show and numbers are looked up through the same
 *   GraphQL endpoint (`titles(ids:)`, verified 2026-10) before the list is saved.
 */

export const IMDB_GRAPHQL = 'https://api.graphql.imdb.com';
const IMDB_LIST_ID = /^ls\d{6,12}$/;

/** Accepts imdb.com list links (any locale prefix, mobile host) or a bare list id. */
export function parseImdbListUrl(input: string): string | null {
  const raw = input.trim();
  if (IMDB_LIST_ID.test(raw)) return raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!/^((www|m)\.)?imdb\.com$/i.test(url.hostname)) return null;
  const m = url.pathname.match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?list\/(ls\d{6,12})\/?/i);
  return m ? m[1]!.toLowerCase() : null;
}

const LIST_QUERY = `query JellyWatcherList($id: ID!, $first: Int!, $after: ID) {
  list(id: $id) {
    id
    name { originalText }
    description { originalText { plainText } }
    author { username { text } }
    visibility { id }
    items(first: $first, after: $after) {
      total
      pageInfo { hasNextPage endCursor }
      edges { node {
        createdDate
        description { originalText { plainText } }
        listItem { ... on Title {
          id
          titleText { text }
          releaseYear { year }
          titleType { id }
          runtime { seconds }
          episodes { episodes(first: 0) { total } displayableSeasons(first: 0) { total } }
          series { series { id titleText { text } releaseYear { year } } episodeNumber { seasonNumber episodeNumber } }
        } }
      } }
    }
  }
}`;

const Text = z.object({ text: z.string().nullish() }).nullish();
const PlainText = z.object({ originalText: z.object({ plainText: z.string().nullish() }).nullish() }).nullish();
const GqlTitle = z.object({
  id: z.string().nullish(),
  titleText: Text,
  releaseYear: z.object({ year: z.number().nullish() }).nullish(),
  titleType: z.object({ id: z.string().nullish() }).nullish(),
  runtime: z.object({ seconds: z.number().nullish() }).nullish(),
  episodes: z
    .object({ episodes: z.object({ total: z.number().nullish() }).nullish(), displayableSeasons: z.object({ total: z.number().nullish() }).nullish() })
    .nullish(),
  series: z
    .object({
      series: z.object({ id: z.string(), titleText: Text, releaseYear: z.object({ year: z.number().nullish() }).nullish() }).nullish(),
      episodeNumber: z.object({ seasonNumber: z.number().nullish(), episodeNumber: z.number().nullish() }).nullish(),
    })
    .nullish(),
});
const GqlList = z.object({
  id: z.string(),
  name: z.object({ originalText: z.string().nullish() }).nullish(),
  description: PlainText,
  author: z.object({ username: Text }).nullish(),
  visibility: z.object({ id: z.string().nullish() }).nullish(),
  items: z.object({
    total: z.number().nullish(),
    pageInfo: z.object({ hasNextPage: z.boolean().nullish(), endCursor: z.string().nullish() }).nullish(),
    edges: z.array(z.object({ node: z.object({ createdDate: z.string().nullish(), description: PlainText, listItem: GqlTitle.nullish() }) })),
  }),
});
const GqlResponse = z.object({
  data: z.object({ list: GqlList.nullish() }).nullish(),
  errors: z.array(z.object({ message: z.string().nullish(), extensions: z.object({ code: z.string().nullish() }).nullish() })).nullish(),
});

const minutes = (seconds: number | null | undefined) => (seconds && seconds > 0 ? Math.round(seconds / 60) : null);

/** An episode as part of its show (the show's id and name, plus the episode's numbers); null when it has no show or numbers. */
function episodeOfShow(t: z.infer<typeof GqlTitle>): Pick<SourceItem, 'title' | 'year' | 'mediaType' | 'imdbId' | 'seasonNumber' | 'episodeNumber' | 'episodeTitle' | 'runtime'> | null {
  const show = t.series?.series;
  const ep = t.series?.episodeNumber;
  if (!show || ep?.seasonNumber == null || ep.episodeNumber == null) return null; // games, podcasts, unknown seasons
  return {
    title: show.titleText?.text || show.id,
    year: show.releaseYear?.year ?? null,
    mediaType: 'tv',
    imdbId: show.id,
    seasonNumber: ep.seasonNumber,
    episodeNumber: ep.episodeNumber,
    episodeTitle: t.titleText?.text ?? null,
    runtime: minutes(t.runtime?.seconds),
  };
}

/** Converts one GraphQL list entry to a source item; returns null for types that cannot be shown. */
export function imdbGqlItem(node: z.infer<typeof GqlList>['items']['edges'][number]['node'], position: number): SourceItem | null {
  const t = node.listItem;
  if (!t?.id) return null;
  const type = mapImdbTitleType(t.titleType?.id ?? undefined);
  const notes = node.description?.originalText?.plainText?.slice(0, 2000) || null;
  const base = { position, listedAt: node.createdDate ?? null, notes, sourceUrl: `https://www.imdb.com/title/${t.id}/` };
  if (type === 'skip') {
    const ep = episodeOfShow(t);
    return ep ? { ...base, sourceKey: t.id, ...ep } : null;
  }
  return {
    ...base,
    sourceKey: t.id,
    title: t.titleText?.text || t.id,
    year: t.releaseYear?.year ?? null,
    mediaType: type,
    imdbId: t.id,
    runtime: minutes(t.runtime?.seconds),
    episodes: type === 'tv' ? (t.episodes?.episodes?.total ?? null) : null,
    seasons: type === 'tv' ? (t.episodes?.displayableSeasons?.total ?? null) : null,
  };
}

export class ImdbClient {
  private readonly http: HttpClient;

  constructor(fetchImpl?: FetchLike) {
    this.http = new HttpClient({ provider: 'imdb', baseUrl: IMDB_GRAPHQL, headers: () => ({ 'x-imdb-client-name': 'jellywatcher' }), retries: 2, minIntervalMs: 250, fetchImpl });
  }

  /** Reads a whole public list in list order (pages of 250). */
  async list(listId: string): Promise<ListFetchResult> {
    if (!IMDB_LIST_ID.test(listId)) throw new ProviderError('imdb', 'bad_request', 'That is not an IMDb list id.');
    const items: SourceItem[] = [];
    let skipped = 0;
    let after: string | null = null;
    let meta: z.infer<typeof GqlList> | null = null;
    for (let page = 0; page < 40; page++) {
      const res = await this.http.post<unknown>('/', { query: LIST_QUERY, variables: { id: listId, first: 250, after } }, { retries: 2 });
      const parsed = GqlResponse.safeParse(res.data);
      if (!parsed.success) throw new ProviderError('imdb', 'invalid_response');
      const code = parsed.data.errors?.[0]?.extensions?.code;
      const list = parsed.data.data?.list;
      if (!list) {
        if (code === 'FORBIDDEN') throw new ProviderError('imdb', 'forbidden', 'That IMDb list is private. Make it public on IMDb, or upload its CSV export.');
        if (code === 'RESOURCE_NOT_FOUND' || code === 'NOT_FOUND') throw new ProviderError('imdb', 'not_found', 'No IMDb list was found at that link.');
        throw new ProviderError('imdb', 'invalid_response', parsed.data.errors?.[0]?.message ?? undefined);
      }
      meta ??= list;
      for (const edge of list.items.edges) {
        const item = imdbGqlItem(edge.node, items.length + skipped + 1);
        if (item) items.push(item);
        else skipped++;
      }
      const next = list.items.pageInfo;
      if (!next?.hasNextPage || !next.endCursor || list.items.edges.length === 0) break;
      after = next.endCursor;
    }
    const m = meta!;
    if (m.visibility?.id && m.visibility.id !== 'PUBLIC') throw new ProviderError('imdb', 'forbidden', 'That IMDb list is private. Make it public on IMDb, or upload its CSV export.');
    return {
      info: {
        externalId: `list:${m.id}`,
        name: m.name?.originalText || m.id,
        kind: 'public',
        description: m.description?.originalText?.plainText || null,
        ownerName: m.author?.username?.text ?? null,
        url: `https://www.imdb.com/list/${m.id}/`,
        itemCount: m.items.total ?? null,
      },
      items,
      skipped,
    };
  }

  /** Looks titles up by id (100 per call). Unknown ids are left out of the result. */
  async titles(ids: string[]): Promise<Map<string, z.infer<typeof GqlTitle>>> {
    const out = new Map<string, z.infer<typeof GqlTitle>>();
    const wanted = [...new Set(ids.filter((id) => IMDB_TITLE_ID.test(id)))];
    for (let i = 0; i < wanted.length; i += 100) {
      const res = await this.http.post<unknown>('/', { query: TITLES_QUERY, variables: { ids: wanted.slice(i, i + 100) } }, { retries: 2 });
      const parsed = GqlTitlesResponse.safeParse(res.data);
      if (!parsed.success) throw new ProviderError('imdb', 'invalid_response');
      for (const t of parsed.data.data?.titles ?? []) if (t?.id) out.set(t.id, t);
    }
    return out;
  }
}

const IMDB_TITLE_ID = /^tt\d{5,10}$/;
const TITLES_QUERY = `query JellyWatcherTitles($ids: [ID!]!) {
  titles(ids: $ids) {
    id
    titleText { text }
    titleType { id }
    runtime { seconds }
    series { series { id titleText { text } releaseYear { year } } episodeNumber { seasonNumber episodeNumber } }
  }
}`;
const GqlTitlesResponse = z.object({ data: z.object({ titles: z.array(GqlTitle.nullable()).nullish() }).nullish() });

/**
 * Turns episodes that are only known by their own IMDb id (CSV exports) into entries of their show,
 * like the list link does. Episodes IMDb cannot place (no show or no numbers) are dropped and
 * counted as skipped rather than matched by their episode title, which would find unrelated movies.
 * Throws a ProviderError when IMDb cannot be reached, so nothing is saved half-resolved.
 */
export async function resolveEpisodeItems(result: ListFetchResult, client: Pick<ImdbClient, 'titles'>): Promise<ListFetchResult> {
  const pending = result.items.filter((i) => i.episodeImdbId);
  if (pending.length === 0) return result;
  const found = await client.titles(pending.map((i) => i.episodeImdbId!));
  const items: SourceItem[] = [];
  let skipped = result.skipped;
  for (const item of result.items) {
    if (!item.episodeImdbId) {
      items.push(item);
      continue;
    }
    const t = found.get(item.episodeImdbId);
    const ep = t ? episodeOfShow(t) : null;
    if (!ep) {
      skipped++;
      continue;
    }
    const { episodeImdbId: _, ...rest } = item;
    items.push({ ...rest, ...ep, runtime: rest.runtime ?? ep.runtime, sourceUrl: rest.sourceUrl ?? `https://www.imdb.com/title/${item.episodeImdbId}/` });
  }
  return { ...result, items, skipped };
}

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

/** True for IMDb "Title Type" values of TV episodes. */
export function isImdbEpisodeType(raw: string | undefined): boolean {
  const t = (raw ?? '').toLowerCase().replace(/[\s_-]+/g, '');
  return t === 'tvepisode' || t === 'episode';
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
  const iRuntime = headerIndex(header, ['runtime (mins)', 'runtime']);
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
    const rawType = iType >= 0 ? row[iType] : undefined;
    const type = mapImdbTitleType(rawType);
    const episode = isImdbEpisodeType(rawType) && imdbId !== null;
    if ((type === 'skip' && !episode) || (!imdbId && !title)) {
      skipped++;
      continue;
    }
    items.push({
      sourceKey: imdbId ?? `${title.toLowerCase()}|${row[iYear] ?? ''}`,
      title: title || imdbId!,
      year: iYear >= 0 ? toInt(row[iYear]) : null,
      mediaType: episode ? 'tv' : (type as MediaType | null),
      imdbId,
      sourceUrl: imdbId ? `https://www.imdb.com/title/${imdbId}/` : null,
      position: iPos >= 0 ? toInt(row[iPos]) : r,
      listedAt: iCreated >= 0 ? row[iCreated] || null : null,
      rating: iRated >= 0 ? toFloat(row[iRated]) : null,
      notes: iDesc >= 0 ? row[iDesc] || null : null,
      runtime: iRuntime >= 0 ? toInt(row[iRuntime]) : null,
      // The show and episode numbers are looked up by resolveEpisodeItems.
      episodeImdbId: episode ? imdbId : null,
    });
  }
  if (items.length === 0 && skipped === 0) throw new UploadError('The file contains no titles.');
  return { info: { externalId: `upload:${fallbackName.toLowerCase()}`, name: fallbackName, kind: 'upload' }, items, skipped };
}
