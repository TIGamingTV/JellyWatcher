import { describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { parseEntries, parseTraktListUrl, tokensFromResponse } from '../server/providers/trakt';
import { parseLetterboxdCsv, parseLetterboxdRss, parseLetterboxdZip, UploadError } from '../server/providers/letterboxd';
import { ImdbClient, imdbGqlItem, mapImdbTitleType, parseImdbCsv, parseImdbListUrl, resolveEpisodeItems } from '../server/providers/imdb';
import { isTimeline } from '../server/services/lists';
import { mediaBrowserHeader, normalizeItem, normalizeUserData } from '../server/providers/jellyfin';
import { encodeSeerrQuery, seerrCan } from '../server/providers/seerr';
import { HttpClient, normalizeServiceUrl, parseRetryAfter } from '../server/http/client';
import { TmdbClient } from '../server/providers/tmdb';
import { ProviderError } from '../server/http/errors';

describe('Trakt', () => {
  it('parses list entries and skips unsupported types', () => {
    const { items, skipped } = parseEntries([
      { rank: 1, id: 101, listed_at: '2024-01-01T00:00:00.000Z', type: 'movie', movie: { title: 'Star Wars', year: 1977, ids: { trakt: 12, slug: 'star-wars-1977', imdb: 'tt0076759', tmdb: 11 } } },
      { rank: 2, id: 102, type: 'show', show: { title: 'Severance', year: 2022, ids: { trakt: 5, slug: 'severance', tvdb: 371980, tmdb: 95396, imdb: null } } },
      { rank: 3, id: 103, type: 'episode', episode: { title: 'Pilot' } },
      { rank: 4, id: 104, type: 'person', person: { name: 'X' } },
      { nonsense: true },
    ]);
    expect(items).toHaveLength(2);
    expect(skipped).toBe(3);
    expect(items[0]).toMatchObject({ sourceKey: 'movie:12', mediaType: 'movie', tmdbId: 11, imdbId: 'tt0076759', position: 1, sourceUrl: 'https://trakt.tv/movies/star-wars-1977' });
    expect(items[1]).toMatchObject({ mediaType: 'tv', tvdbId: 371980, tmdbId: 95396 });
  });

  it('keeps seasons and episodes as parts of their show, in list order', () => {
    const show = { title: 'Dragons: Riders of Berk', year: 2012, ids: { trakt: 9, slug: 'riders', tmdb: 44305 }, runtime: 22 };
    const { items, skipped } = parseEntries([
      { id: 1, type: 'movie', movie: { title: 'How to Train Your Dragon', year: 2010, runtime: 98, ids: { trakt: 1, tmdb: 10191 } } },
      { id: 2, type: 'season', season: { number: 1, episode_count: 20, ids: { trakt: 55 } }, show },
      { id: 3, type: 'episode', episode: { season: 2, number: 5, title: 'Race to Fireworm Island', runtime: 23, ids: { trakt: 77 } }, show },
      { id: 4, type: 'season', season: {}, show },
    ]);
    expect(skipped).toBe(1);
    expect(items.map((i) => [i.position, i.sourceKey, i.mediaType, i.seasonNumber ?? null, i.episodeNumber ?? null, i.runtime])).toEqual([
      [1, 'movie:1', 'movie', null, null, 98],
      [2, 'season:55', 'tv', 1, null, 22],
      [3, 'episode:77', 'tv', 2, 5, 23],
    ]);
    expect(items[1]).toMatchObject({ tmdbId: 44305, episodes: 20, sourceUrl: 'https://trakt.tv/shows/riders/seasons/1' });
    expect(items[2]!.episodeTitle).toBe('Race to Fireworm Island');
  });

  it('parses list URLs from trakt.tv and app.trakt.tv only', () => {
    expect(parseTraktListUrl('https://trakt.tv/users/sean/lists/star-wars-in-machete-order')).toEqual({ kind: 'user_list', user: 'sean', list: 'star-wars-in-machete-order' });
    expect(parseTraktListUrl('https://app.trakt.tv/users/sean/lists/123?sort=rank')).toEqual({ kind: 'user_list', user: 'sean', list: '123' });
    expect(parseTraktListUrl('https://trakt.tv/lists/2142753')).toEqual({ kind: 'list_id', id: '2142753' });
    expect(parseTraktListUrl('https://trakt.tv/users/sean/watchlist')).toEqual({ kind: 'user_watchlist', user: 'sean' });
    expect(parseTraktListUrl('https://evil.example/users/a/lists/b')).toBeNull();
    expect(parseTraktListUrl('https://trakt.tv.evil.example/users/a/lists/b')).toBeNull();
    expect(parseTraktListUrl('not a url')).toBeNull();
  });

  it('computes token expiry from expires_in', () => {
    const t = tokensFromResponse({ access_token: 'a', refresh_token: 'r', expires_in: 86400, created_at: 1_700_000_000 });
    expect(t.expiresAt).toBe(new Date((1_700_000_000 + 86400) * 1000).toISOString());
  });
});

const LB_LIST = `Letterboxd list export v7
Date,Name,Tags,URL,Description
2026-01-02,Best of Mann,,https://letterboxd.com/me/list/best-of-mann/,"Michael Mann, ranked"

Position,Name,Year,URL,Description
1,Heat,1995,https://boxd.it/1aBc,
2,Thief,1981,https://boxd.it/2dEf,"Neon, rain"
3,"Collateral",2004,https://boxd.it/3gHi,
`;

describe('Letterboxd', () => {
  it('parses a list export with its metadata block', () => {
    const r = parseLetterboxdCsv(LB_LIST, 'fallback');
    expect(r.info).toMatchObject({ name: 'Best of Mann', description: 'Michael Mann, ranked', url: 'https://letterboxd.com/me/list/best-of-mann/' });
    expect(r.items.map((i) => [i.title, i.year, i.position])).toEqual([
      ['Heat', 1995, 1],
      ['Thief', 1981, 2],
      ['Collateral', 2004, 3],
    ]);
    expect(r.items[1]!.notes).toBe('Neon, rain');
    expect(r.items[0]!.mediaType).toBe('movie');
  });

  it('parses watchlist.csv and tolerates a BOM and CRLF', () => {
    const r = parseLetterboxdCsv('\uFEFFDate,Name,Year,Letterboxd URI\r\n2025-05-01,Past Lives,2023,https://boxd.it/x\r\n', 'Watchlist');
    expect(r.items).toEqual([expect.objectContaining({ title: 'Past Lives', year: 2023, sourceUrl: 'https://boxd.it/x', sourceKey: 'https://boxd.it/x' })]);
  });

  it('rejects files that are not exports', () => {
    expect(() => parseLetterboxdCsv('foo,bar\n1,2\n', 'x')).toThrow(UploadError);
  });

  it('reads watchlist and lists from the account export ZIP, ignoring deleted content', () => {
    const zip = zipSync({
      'watchlist.csv': strToU8('Date,Name,Year,Letterboxd URI\n2025-01-01,Aftersun,2022,https://boxd.it/a\n'),
      'lists/best-of-mann.csv': strToU8(LB_LIST),
      'deleted/lists/old.csv': strToU8(LB_LIST),
      'diary.csv': strToU8('Date,Name,Year\n'),
    });
    const lists = parseLetterboxdZip(zip);
    expect(lists.map((l) => l.info.name).sort()).toEqual(['Best of Mann', 'Letterboxd Watchlist']);
    expect(lists.find((l) => l.info.kind === 'watchlist')!.items[0]!.title).toBe('Aftersun');
  });

  it('parses the RSS diary with TMDb ids and skips list entries', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:letterboxd="https://letterboxd.com" xmlns:tmdb="https://themoviedb.org"><channel><title>Letterboxd - me</title>
<item><title>Heat, 1995 - ★★★★½</title><link>https://letterboxd.com/me/film/heat/</link><guid isPermaLink="false">letterboxd-watch-1</guid>
<letterboxd:watchedDate>2026-10-01</letterboxd:watchedDate><letterboxd:filmTitle>Heat</letterboxd:filmTitle><letterboxd:filmYear>1995</letterboxd:filmYear>
<letterboxd:memberRating>4.5</letterboxd:memberRating><tmdb:movieId>949</tmdb:movieId></item>
<item><title>Some list</title><guid isPermaLink="false">letterboxd-list-9</guid><description>&lt;p&gt;x&lt;/p&gt;</description></item>
</channel></rss>`;
    const r = parseLetterboxdRss(xml, 'me');
    expect(r.items).toEqual([expect.objectContaining({ sourceKey: 'letterboxd-watch-1', title: 'Heat', year: 1995, tmdbId: 949, rating: 4.5, watchedAt: '2026-10-01' })]);
    expect(r.skipped).toBe(1);
  });
});

describe('IMDb', () => {
  it('maps title types in camelCase and display form', () => {
    expect(mapImdbTitleType('movie')).toBe('movie');
    expect(mapImdbTitleType('tvMiniSeries')).toBe('tv');
    expect(mapImdbTitleType('TV Series')).toBe('tv');
    expect(mapImdbTitleType('TV Episode')).toBe('skip');
    expect(mapImdbTitleType('videoGame')).toBe('skip');
    expect(mapImdbTitleType('Something New')).toBeNull();
  });

  it('parses an export, using Const and keeping episodes for lookup', () => {
    const csv = `Position,Const,Created,Modified,Description,Title,Original Title,URL,Title Type,IMDb Rating,Runtime (mins),Year,Genres,Num Votes,Release Date,Directors,Your Rating,Date Rated
1,tt0113277,2024-01-01,2024-01-01,,Heat,Heat,https://www.imdb.com/title/tt0113277/,Movie,8.3,170,1995,"Action, Crime",700000,1995-12-15,Michael Mann,,
2,tt11280740,2024-01-02,2024-01-02,,Severance,Severance,https://www.imdb.com/title/tt11280740/,TV Series,8.7,55,2022,Drama,300000,2022-02-18,,9,2024-02-01
3,tt0959621,2024-01-03,2024-01-03,,Pilot,,https://www.imdb.com/title/tt0959621/,TV Episode,9,58,2008,,,,,,
4,tt0000001,2024-01-04,2024-01-04,,A Game,,https://www.imdb.com/title/tt0000001/,Video Game,7,0,2020,,,,,,`;
    const r = parseImdbCsv(csv, 'WATCHLIST');
    expect(r.items.map((i) => [i.imdbId, i.mediaType, i.episodeImdbId])).toEqual([
      ['tt0113277', 'movie', null],
      ['tt11280740', 'tv', null],
      ['tt0959621', 'tv', 'tt0959621'],
    ]);
    expect(r.skipped).toBe(1);
    expect(r.items[1]!.rating).toBe(9);
  });

  it('places exported episodes in their show through IMDb, and drops those it cannot place', async () => {
    const parsed = parseImdbCsv('Const,Title,Title Type,Runtime (mins)\ntt0113277,Heat,Movie,170\ntt0959621,Pilot,TV Episode,58\ntt9999999,Lost,TV Episode,\n', 'x');
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body));
      expect(body.query).toContain('titles(ids: $ids)');
      expect(body.variables.ids).toEqual(['tt0959621', 'tt9999999']);
      return new Response(
        JSON.stringify({
          data: {
            titles: [
              { id: 'tt0959621', titleText: { text: 'Pilot' }, titleType: { id: 'tvEpisode' }, runtime: { seconds: 3480 }, series: { series: { id: 'tt0903747', titleText: { text: 'Breaking Bad' }, releaseYear: { year: 2008 } }, episodeNumber: { seasonNumber: 1, episodeNumber: 1 } } },
              { id: 'tt9999999', titleText: { text: 'Lost' }, titleType: { id: 'tvEpisode' }, series: null },
            ],
          },
        }),
        { status: 200 },
      );
    });
    const r = await resolveEpisodeItems(parsed, new ImdbClient(fetchImpl));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r.items).toHaveLength(2);
    expect(r.items[1]).toMatchObject({ sourceKey: 'tt0959621', title: 'Breaking Bad', imdbId: 'tt0903747', mediaType: 'tv', seasonNumber: 1, episodeNumber: 1, episodeTitle: 'Pilot', runtime: 58, sourceUrl: 'https://www.imdb.com/title/tt0959621/' });
    expect(r.items[1]!.episodeImdbId).toBeUndefined();
    expect(r.skipped).toBe(1);
    // Nothing to look up: no request.
    const plain = parseImdbCsv('Const,Title,Title Type\ntt0113277,Heat,Movie\n', 'x');
    expect(await resolveEpisodeItems(plain, { titles: () => Promise.reject(new Error('no call expected')) })).toBe(plain);
  });

  it('recognises public list links in any locale, and nothing else', () => {
    expect(parseImdbListUrl('https://www.imdb.com/de/list/ls020816781/')).toBe('ls020816781');
    expect(parseImdbListUrl('https://m.imdb.com/list/ls020816781/?ref_=ext_shr')).toBe('ls020816781');
    expect(parseImdbListUrl('ls020816781')).toBe('ls020816781');
    expect(parseImdbListUrl('https://www.imdb.com/user/ur1/watchlist')).toBeNull();
    expect(parseImdbListUrl('https://imdb.com.evil.example/list/ls020816781/')).toBeNull();
  });

  it('maps GraphQL list entries: episodes become part of their series', () => {
    const ep = imdbGqlItem(
      {
        createdDate: '2020-01-01T00:00:00Z',
        description: null,
        listItem: { id: 'tt1', titleText: { text: 'Pilot' }, titleType: { id: 'tvEpisode' }, runtime: { seconds: 3480 }, series: { series: { id: 'tt0903747', titleText: { text: 'Breaking Bad' }, releaseYear: { year: 2008 } }, episodeNumber: { seasonNumber: 1, episodeNumber: 1 } } },
      },
      7,
    );
    expect(ep).toMatchObject({ sourceKey: 'tt1', title: 'Breaking Bad', imdbId: 'tt0903747', mediaType: 'tv', seasonNumber: 1, episodeNumber: 1, episodeTitle: 'Pilot', runtime: 58, position: 7 });
    expect(imdbGqlItem({ createdDate: null, description: null, listItem: { id: 'tt2', titleText: { text: 'A Game' }, titleType: { id: 'videoGame' } } }, 1)).toBeNull();
  });

  it('pages through a public list and reports private lists clearly', async () => {
    const page = (after: string | null) => ({
      data: {
        list: {
          id: 'ls1234567',
          name: { originalText: 'Order' },
          visibility: { id: 'PUBLIC' },
          items: {
            total: 2,
            pageInfo: { hasNextPage: after === null, endCursor: 'next' },
            edges: [{ node: { listItem: { id: after ? 'tt0000002' : 'tt0000001', titleText: { text: after ? 'B' : 'A' }, titleType: { id: 'movie' } } } }],
          },
        },
      },
    });
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const vars = JSON.parse(String(init!.body)).variables;
      if (vars.id === 'ls7654321') return new Response(JSON.stringify({ errors: [{ extensions: { code: 'FORBIDDEN' } }], data: { list: null } }), { status: 200 });
      return new Response(JSON.stringify(page(vars.after)), { status: 200 });
    });
    const r = await new ImdbClient(fetchImpl).list('ls1234567');
    expect(r.items.map((i) => [i.title, i.position])).toEqual([
      ['A', 1],
      ['B', 2],
    ]);
    expect(r.info).toMatchObject({ externalId: 'list:ls1234567', kind: 'public', url: 'https://www.imdb.com/list/ls1234567/' });
    expect((fetchImpl.mock.calls[0]![1]!.headers as Record<string, string>)['x-imdb-client-name']).toBe('jellywatcher');
    await expect(new ImdbClient(fetchImpl).list('ls7654321')).rejects.toMatchObject({ kind: 'forbidden' });
  });

  it('accepts minimal files with only a URL column', () => {
    const r = parseImdbCsv('URL\nhttps://www.imdb.com/title/tt0133093/\n', 'x');
    expect(r.items[0]!.imdbId).toBe('tt0133093');
  });
});

describe('Lists', () => {
  it('shows every list as a timeline unless the person chose the grid', () => {
    expect(isTimeline({ display: 'auto' })).toBe(true);
    expect(isTimeline({ display: 'timeline' })).toBe(true);
    expect(isTimeline({ display: 'grid' })).toBe(false);
  });
});

describe('Jellyfin', () => {
  it('builds the MediaBrowser authorization header with quoted, encoded values', () => {
    expect(mediaBrowserHeader({ token: 'abc', deviceId: 'dev 1', version: '0.1.0' })).toBe(
      'MediaBrowser Client="JellyWatcher", Device="JellyWatcher%20Server", DeviceId="dev%201", Version="0.1.0", Token="abc"',
    );
  });

  it('normalises items and provider ids case-insensitively', () => {
    const i = normalizeItem({ Id: 'a'.repeat(32), Name: 'Heat', Type: 'Movie', ProductionYear: 1995, ProviderIds: { Tmdb: '949', IMDB: 'tt0113277', Tvdb: '' }, ImageTags: { Primary: 'tag1' } });
    expect(i).toMatchObject({ mediaType: 'movie', tmdbId: 949, imdbId: 'tt0113277', tvdbId: null, imageTag: 'tag1' });
    expect(normalizeItem({ Id: 'b', Type: 'Episode' })).toBeNull();
    expect(normalizeItem({ nope: 1 })).toBeNull();
  });

  it('extracts user data for series', () => {
    const u = normalizeUserData({ Id: 'x', Type: 'Series', RecursiveItemCount: 20, UserData: { Played: false, UnplayedItemCount: 5, PlayedPercentage: 75 } });
    expect(u).toMatchObject({ itemId: 'x', played: false, unplayedCount: 5, episodeCount: 20 });
  });
});

describe('Seerr', () => {
  it('encodes queries like the Seerr web client', () => {
    expect(encodeSeerrQuery("Pan's Labyrinth (2006)!")).toBe('Pan%27s%20Labyrinth%20%282006%29%21');
    expect(encodeSeerrQuery('imdb:tt0133093')).toBe('imdb%3Att0133093');
  });
  it('derives permissions from the bitmask', () => {
    expect(seerrCan(2, 'movie')).toEqual({ request: true, autoApprove: true });
    expect(seerrCan(32, 'tv')).toEqual({ request: true, autoApprove: false });
    expect(seerrCan(262144 | 256, 'movie')).toEqual({ request: true, autoApprove: true });
    expect(seerrCan(262144, 'tv')).toEqual({ request: false, autoApprove: false });
  });
});

describe('TMDb', () => {
  it('reads the episodes of many seasons with 20 appended per request', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      const appended = new URL(url).searchParams.get('append_to_response')!.split(',');
      const body: Record<string, unknown> = { id: 1 };
      for (const a of appended) {
        const n = Number(a.split('/')[1]);
        // No specials: TMDb leaves the key out.
        if (n > 0) body[a] = { episodes: [{ episode_number: 1, name: `S${n}E1`, air_date: '2020-01-01', runtime: 42 }, { episode_number: 2, name: '', air_date: '', runtime: 0 }] };
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const seasons = Array.from({ length: 25 }, (_, i) => i);
    const out = await new TmdbClient('token', fetchImpl).seasonEpisodes(42, seasons);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('/3/tv/42?append_to_response=season%2F0%2Cseason%2F1');
    expect(out.has(0)).toBe(false);
    expect(out.size).toBe(24);
    expect(out.get(24)).toEqual([
      { episode: 1, name: 'S24E1', airDate: '2020-01-01', runtime: 42 },
      { episode: 2, name: null, airDate: null, runtime: null },
    ]);
  });
});

describe('HttpClient', () => {
  it('appends parameters without re-encoding a query string that is already in the path', () => {
    const c = new HttpClient({ provider: 't', baseUrl: 'http://x/api/v1/' });
    expect(c.buildUrl('/search?query=past%20lives%3A%20it%27s', { page: 2 })).toBe('http://x/api/v1/search?query=past%20lives%3A%20it%27s&page=2');
    expect(c.buildUrl('/search/multi', { query: 'past lives', page: 1, skip: undefined })).toBe('http://x/api/v1/search/multi?query=past%20lives&page=1');
    expect(c.buildUrl('/status')).toBe('http://x/api/v1/status');
  });

  it('retries 429 honouring Retry-After, then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    const c = new HttpClient({ provider: 't', baseUrl: 'http://x', fetchImpl, retries: 2 });
    const r = await c.get<{ ok: boolean }>('/a');
    expect(r.data.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry POST by default and classifies auth errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{"message":"nope"}', { status: 401 }));
    const c = new HttpClient({ provider: 't', baseUrl: 'http://x', fetchImpl });
    await expect(c.post('/a', {})).rejects.toMatchObject({ kind: 'auth', status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports network failures and invalid JSON distinctly', async () => {
    const c1 = new HttpClient({ provider: 't', baseUrl: 'http://x', retries: 0, fetchImpl: () => Promise.reject(new TypeError('fetch failed')) });
    await expect(c1.get('/')).rejects.toMatchObject({ kind: 'network' });
    const c2 = new HttpClient({ provider: 't', baseUrl: 'http://x', fetchImpl: async () => new Response('<html>', { status: 200 }) });
    await expect(c2.get('/')).rejects.toBeInstanceOf(ProviderError);
  });

  it('times out', async () => {
    const c = new HttpClient({
      provider: 't',
      baseUrl: 'http://x',
      retries: 0,
      timeoutMs: 20,
      fetchImpl: (_u, init) => new Promise((_r, rej) => init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('t'), { name: 'TimeoutError' })))),
    });
    await expect(c.get('/')).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('parses Retry-After seconds and dates', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(new Date(Date.now() + 5000).toUTCString())).toBeGreaterThan(3000);
  });
});

describe('normalizeServiceUrl', () => {
  it('accepts LAN and container hosts, rejects unsafe forms', () => {
    expect(normalizeServiceUrl('http://jellyfin:8096/')).toBe('http://jellyfin:8096');
    expect(normalizeServiceUrl(' https://media.example.com/jf ')).toBe('https://media.example.com/jf');
    expect(() => normalizeServiceUrl('ftp://x')).toThrow();
    expect(() => normalizeServiceUrl('http://user:pw@host')).toThrow();
    expect(() => normalizeServiceUrl('http://host/?api_key=1')).toThrow();
    expect(() => normalizeServiceUrl('jellyfin:8096')).toThrow();
  });
});
