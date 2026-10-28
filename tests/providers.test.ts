import { describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { parseEntries, parseTraktListUrl, tokensFromResponse } from '../server/providers/trakt';
import { parseLetterboxdCsv, parseLetterboxdRss, parseLetterboxdZip, UploadError } from '../server/providers/letterboxd';
import { mapImdbTitleType, parseImdbCsv } from '../server/providers/imdb';
import { mediaBrowserHeader, normalizeItem, normalizeUserData } from '../server/providers/jellyfin';
import { encodeSeerrQuery, seerrCan } from '../server/providers/seerr';
import { HttpClient, normalizeServiceUrl, parseRetryAfter } from '../server/http/client';
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

  it('parses an export, using Const and skipping episodes', () => {
    const csv = `Position,Const,Created,Modified,Description,Title,Original Title,URL,Title Type,IMDb Rating,Runtime (mins),Year,Genres,Num Votes,Release Date,Directors,Your Rating,Date Rated
1,tt0113277,2024-01-01,2024-01-01,,Heat,Heat,https://www.imdb.com/title/tt0113277/,Movie,8.3,170,1995,"Action, Crime",700000,1995-12-15,Michael Mann,,
2,tt11280740,2024-01-02,2024-01-02,,Severance,Severance,https://www.imdb.com/title/tt11280740/,TV Series,8.7,55,2022,Drama,300000,2022-02-18,,9,2024-02-01
3,tt0000001,2024-01-03,2024-01-03,,Some Episode,,https://www.imdb.com/title/tt0000001/,TV Episode,7,30,2020,,,,,,`;
    const r = parseImdbCsv(csv, 'WATCHLIST');
    expect(r.items.map((i) => [i.imdbId, i.mediaType])).toEqual([
      ['tt0113277', 'movie'],
      ['tt11280740', 'tv'],
    ]);
    expect(r.skipped).toBe(1);
    expect(r.items[1]!.rating).toBe(9);
  });

  it('accepts minimal files with only a URL column', () => {
    const r = parseImdbCsv('URL\nhttps://www.imdb.com/title/tt0133093/\n', 'x');
    expect(r.items[0]!.imdbId).toBe('tt0133093');
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

describe('HttpClient', () => {
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
