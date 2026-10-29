import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { AnimeIds, animeItem, animeMediaType, compactAnimeList } from '../server/providers/anime';
import { parseAnilistUrl } from '../server/providers/anilist';
import { normalizeStatus, parseIdCsv } from '../server/providers/generic';
import { decodeHtml } from '../server/providers/html';
import { parseLetterboxdPage, parseLetterboxdUrl, UploadError } from '../server/providers/letterboxd';
import { mdblistItem, parseMdblistUrl } from '../server/providers/mdblist';
import { malYear, parseMalExport, parseMalListUrl } from '../server/providers/myanimelist';
import { parseSimklExport } from '../server/providers/simkl';
import { parseTmdbListUrl, tmdbListItem } from '../server/providers/tmdb';
import { autoOrder } from '../server/services/timeline';
import { greeting, seasonName } from '../web/src/lib/format';

const mapping = () => {
  const ids = new AnimeIds();
  ids.index(
    compactAnimeList([
      { mal_id: 16498, anilist_id: 16498, themoviedb_id: { tv: 1429 }, season: { tmdb: 1 } },
      { mal_id: 25777, anilist_id: 20958, themoviedb_id: { tv: 1429 }, season: { tmdb: 2 } },
      { mal_id: 38524, anilist_id: 104578, themoviedb_id: { tv: 1429 }, season: { tmdb: 3 }, episode_offset: { tmdb: 12 } },
      { mal_id: 199, anilist_id: 199, imdb_id: ['tt0245429'], themoviedb_id: { movie: [129] } },
      { mal_id: 9776, anilist_id: 9776, themoviedb_id: { tv: 42000 }, season: { tmdb: 1 } },
      { mal_id: 5, tvdb_id: 1234 },
      { mal_id: 6 }, // no ids: dropped
    ]),
  );
  return ids;
};

describe('link parsing', () => {
  it('recognises Letterboxd lists, watchlists and short links only on letterboxd.com', () => {
    expect(parseLetterboxdUrl('https://letterboxd.com/Dave/list/best-of-2026/')).toEqual({ user: 'dave', slug: 'best-of-2026' });
    expect(parseLetterboxdUrl('https://letterboxd.com/dave/list/best-of-2026/detail/by/release/page/3/')).toEqual({ user: 'dave', slug: 'best-of-2026' });
    expect(parseLetterboxdUrl('https://www.letterboxd.com/dave/watchlist/')).toEqual({ user: 'dave', slug: null });
    expect(parseLetterboxdUrl('https://boxd.it/aB3x')).toBe('short');
    expect(parseLetterboxdUrl('https://letterboxd.com/film/heat-1995/')).toBeNull();
    expect(parseLetterboxdUrl('https://letterboxd.com.evil.example/dave/list/x/')).toBeNull();
  });

  it('recognises TMDb, MDBList, MyAnimeList and AniList links', () => {
    expect(parseTmdbListUrl('https://www.themoviedb.org/list/1-the-marvel-universe')).toBe(1);
    expect(parseTmdbListUrl('https://www.themoviedb.org/list/8212345?language=de-DE')).toBe(8212345);
    expect(parseTmdbListUrl('https://www.themoviedb.org/movie/949')).toBeNull();
    expect(parseMdblistUrl('https://mdblist.com/lists/linaspurinis/top-watched-movies-of-the-week')).toEqual({ user: 'linaspurinis', slug: 'top-watched-movies-of-the-week' });
    expect(parseMdblistUrl('https://mdblist.com/lists/linaspurinis/json')).toBeNull();
    expect(parseMalListUrl('https://myanimelist.net/animelist/Xinil?status=1')).toEqual({ user: 'Xinil', status: 1 });
    expect(parseMalListUrl('https://myanimelist.net/animelist/Xinil')).toEqual({ user: 'Xinil', status: 6 });
    expect(parseMalListUrl('https://myanimelist.net/animelist/Xinil?status=99')).toEqual({ user: 'Xinil', status: 6 });
    expect(parseMalListUrl('https://myanimelist.net/mangalist/Xinil')).toBeNull();
    expect(parseAnilistUrl('https://anilist.co/user/Taro/animelist/Worth%20a%20rewatch')).toEqual({ user: 'Taro', list: 'Worth a rewatch' });
    expect(parseAnilistUrl('https://anilist.co/user/Taro/')).toEqual({ user: 'Taro', list: null });
    expect(parseAnilistUrl('https://anilist.co/user/Taro/mangalist')).toBeNull();
  });
});

describe('Letterboxd pages', () => {
  it('reads films in page order with title and year, and the page count of this list only', () => {
    const html = `<html><head><meta property="og:title" content="Rock &amp; Roll &#8217;n&#x27; Film"></head><body>
      <div class="react-component" data-item-name="Sunrise: A Song of Two Humans (1927)" data-item-slug="sunrise-a-song-of-two-humans" data-list-index="0"></div>
      <div class="react-component" data-item-name="8&#189; (1963)" data-item-slug="8-half"></div>
      <div class="react-component" data-item-name="Untitled" data-item-slug="untitled-x"></div>
      <div class="react-component" data-item-name="Sunrise: A Song of Two Humans (1927)" data-item-slug="sunrise-a-song-of-two-humans"></div>
      <a href="/dave/list/x/page/2/">2</a><a href="/dave/list/x/page/7/">7</a><a href="/other/list/y/page/40/">40</a></body></html>`;
    const p = parseLetterboxdPage(html, '/dave/list/x/');
    expect(p.films).toEqual([
      { slug: 'sunrise-a-song-of-two-humans', title: 'Sunrise: A Song of Two Humans', year: 1927 },
      { slug: '8-half', title: '8½', year: 1963 },
      { slug: 'untitled-x', title: 'Untitled', year: null },
    ]);
    expect(p.pages).toBe(7);
    expect(p.title).toBe('Rock & Roll ’n\' Film');
    expect(decodeHtml('&lt;b&gt; &amp;amp; &unknown;')).toBe('<b> &amp; &unknown;');
  });
});

describe('id-based sources', () => {
  it('maps TMDb list results and MDBList entries to exact ids', () => {
    expect(tmdbListItem({ id: 1429, media_type: 'tv', name: 'Attack on Titan', first_air_date: '2013-04-07' }, 1, { 'tv:1429': 'watch subbed' })).toMatchObject({
      sourceKey: 'tmdb:tv:1429',
      mediaType: 'tv',
      tmdbId: 1429,
      year: 2013,
      notes: 'watch subbed',
    });
    expect(tmdbListItem({ id: 1, media_type: 'person', name: 'Someone' }, 2)).toBeNull();
    expect(mdblistItem({ id: 949, title: 'Heat', imdb_id: 'tt0113277', tvdbid: 9, mediatype: 'movie', release_year: 1995 }, 1)).toMatchObject({ tmdbId: 949, imdbId: 'tt0113277', tvdbId: null, mediaType: 'movie' });
    expect(mdblistItem({ id: 95396, title: 'Severance', tvdbid: 371980, mediatype: 'show' }, 2)).toMatchObject({ mediaType: 'tv', tvdbId: 371980, sourceUrl: 'https://www.themoviedb.org/tv/95396' });
  });

  it('splits a CSV by status, skips what is completed, and needs a type for bare TMDb ids', () => {
    expect(normalizeStatus('plantowatch')).toBe('plan');
    expect(normalizeStatus('On Hold')).toBe('hold');
    expect(normalizeStatus('?')).toBeNull();
    const csv = ['SIMKL_ID,Title,Type,Year,Watchlist,TMDB,IMDB', '1,Heat,movie,1995,plantowatch,949,tt0113277', '2,Thief,movie,1981,completed,11524,', '3,Severance,tv,2022,watching,95396,', '4,Mystery,,2020,plantowatch,123,'].join('\n');
    const lists = parseIdCsv(csv, { source: 'Simkl', fallbackName: 'Simkl Watchlist' });
    expect(lists.map((l) => [l.info.name, l.info.externalId, l.items.map((i) => [i.title, i.tmdbId, i.mediaType])])).toEqual([
      ['Simkl Plan to Watch', 'watchlist', [['Heat', 949, 'movie'], ['Mystery', null, null]]],
      ['Simkl Watching', 'upload:watching', [['Severance', 95396, 'tv']]],
    ]);
    expect(lists[0]!.skipped).toBe(1);
    expect(() => parseIdCsv('a,b\n1,2', { source: 'X', fallbackName: 'X' })).toThrow(UploadError);
    // Without a status column everything is one list.
    expect(parseIdCsv('tmdb_id,media_type\n949,movie\n', { source: 'TMDb', fallbackName: 'Mann' }).map((l) => [l.info.name, l.items.length])).toEqual([['Mann', 1]]);
  });
});

describe('anime', () => {
  it('turns later seasons and split cours into season entries of the TMDb show', () => {
    const ids = mapping();
    const entry = (mal: number, format = 'TV') => animeItem({ key: `mal:${mal}`, title: `Anime ${mal}`, year: 2013, format, episodes: 12, ids: { mal }, sourceUrl: null, position: 1 }, ids);
    expect(entry(16498)).toMatchObject({ mediaType: 'tv', tmdbId: 1429, seasonNumber: 1, episodes: 12 }); // the show has more seasons
    expect(entry(25777)).toMatchObject({ tmdbId: 1429, seasonNumber: 2, episodeTitle: 'Anime 25777' });
    expect(entry(38524)).toMatchObject({ tmdbId: 1429, seasonNumber: 3 });
    expect(entry(9776)).toMatchObject({ tmdbId: 42000, seasonNumber: null, episodeTitle: null }); // one season: the whole show
    expect(entry(199, 'Movie')).toMatchObject({ mediaType: 'movie', tmdbId: 129, imdbId: 'tt0245429' });
    expect(entry(5)).toMatchObject({ mediaType: 'tv', tvdbId: 1234, tmdbId: null });
    expect(entry(6)).toMatchObject({ tmdbId: null, title: 'Anime 6' }); // unmapped: matched by title
    expect(entry(1, 'Music')).toBeNull();
    expect(animeMediaType('TV_SHORT')).toBe('tv');
    expect(animeMediaType('ONA')).toBe('tv');
  });

  it('reads the MyAnimeList export, gzipped or not', () => {
    const xml = `<myanimelist><myinfo><user_name>kana</user_name></myinfo>
      <anime><series_animedb_id>25777</series_animedb_id><series_title><![CDATA[Shingeki no Kyojin Season 2]]></series_title><series_type>TV</series_type><series_episodes>12</series_episodes><my_status>Plan to Watch</my_status></anime>
      <anime><series_animedb_id>199</series_animedb_id><series_title>Sen to Chihiro no Kamikakushi</series_title><series_type>Movie</series_type><series_episodes>1</series_episodes><my_status>Dropped</my_status></anime>
    </myanimelist>`;
    for (const buf of [strToU8(xml), gzipSync(strToU8(xml))]) {
      const [plan, ...rest] = parseMalExport(buf, 'myanimelist', mapping());
      expect(rest).toHaveLength(0);
      expect(plan!.info).toMatchObject({ name: 'MyAnimeList Plan to Watch', externalId: 'watchlist', ownerName: 'kana' });
      expect(plan!.items[0]).toMatchObject({ tmdbId: 1429, seasonNumber: 2, sourceUrl: 'https://myanimelist.net/anime/25777' });
      expect(plan!.skipped).toBe(1);
    }
    expect(() => parseMalExport(strToU8('<mangalist/>'), 'myanimelist', null)).toThrow(/MyAnimeList export/);
    expect(malYear('04-08-11')).toBe(2011);
    expect(malYear('10-03-98')).toBe(1998);
    expect(malYear(null)).toBeNull();
  });

  it('reads Simkl JSON backups including anime', () => {
    const json = JSON.stringify({
      movies: [{ status: 'plantowatch', movie: { title: 'Heat', year: 1995, ids: { simkl: 1, tmdb: 949 } } }],
      anime: [{ status: 'plantowatch', anime_type: 'tv', show: { title: 'Attack on Titan Season 2', year: 2017, ids: { simkl: 9, mal: 25777 } } }],
    });
    const [plan] = parseSimklExport('backup.json', strToU8(json), mapping());
    expect(plan!.items.map((i) => [i.title, i.tmdbId, i.seasonNumber ?? null])).toEqual([
      ['Heat', 949, null],
      ['Attack on Titan Season 2', 1429, 2],
    ]);
    expect(() => parseSimklExport('backup.json', strToU8('{"x":1}'), null)).toThrow(/Simkl export/);
  });

  it('caches the mapping on disk and uses a stale copy when the download fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jw-anime-'));
    const file = path.join(dir, 'cache', 'anime-ids.json');
    let calls = 0;
    const ok = new AnimeIds({
      cacheFile: file,
      fetchImpl: async () => {
        calls++;
        return new Response(JSON.stringify([{ mal_id: 1, themoviedb_id: { tv: 7 }, season: { tmdb: 1 } }]), { status: 200 });
      },
    });
    expect(await ok.load()).toBe(true);
    expect(ok.lookup({ mal: 1 })).toEqual({ tmdbTv: 7, season: 1 });
    expect(fs.existsSync(file)).toBe(true);

    // A fresh process reads the cache without downloading.
    const cached = new AnimeIds({ cacheFile: file, fetchImpl: async () => { calls++; throw new TypeError('offline'); } });
    expect(await cached.load()).toBe(true);
    expect(calls).toBe(1);

    // An old cache is refreshed; when that fails, the old copy is still used.
    const old = new Date(Date.now() - 30 * 86400_000);
    fs.utimesSync(file, old, old);
    const stale = new AnimeIds({ cacheFile: file, fetchImpl: async () => { calls++; throw new TypeError('offline'); } });
    expect(await stale.load()).toBe(true);
    expect(stale.lookup({ mal: 1 })?.tmdbTv).toBe(7);

    const none = new AnimeIds({ fetchImpl: async () => { throw new TypeError('offline'); } });
    expect(await none.load()).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('auto sort and greeting', () => {
  const e = (itemId: number, title: string, season: number | null, runtime: number | null, titleId = itemId) =>
    ({ itemId, position: itemId, title: { id: titleId, title }, sourceTitle: title, season, episode: null, runtime }) as never;

  it('orders by release date with seasons of a show in order and unknown dates last', () => {
    const entries = [e(1, 'B', null, 100), e(2, 'Show', 2, 300, 9), e(3, 'Unknown', null, null), e(4, 'Show', 1, 200, 9), e(5, 'A', null, 90)];
    const dates = new Map<number, string | null>([
      [1, '2001-05-01'],
      [2, '1999-01-01'],
      [3, null],
      [4, '1999-01-01'],
      [5, '1990-01-01'],
    ]);
    expect(autoOrder(entries, 'release', dates)).toEqual([5, 4, 2, 1, 3]);
    expect(autoOrder(entries, 'release_desc', dates)).toEqual([1, 4, 2, 5, 3]);
    expect(autoOrder(entries, 'title', dates)).toEqual([5, 1, 4, 2, 3]);
    expect(autoOrder(entries, 'runtime', dates)).toEqual([5, 1, 4, 2, 3]);
  });

  it('names anime season entries without repeating the show and season', () => {
    expect(seasonName('Attack on Titan Season 3 Part 2', 'Attack on Titan', 3)).toBe('Part 2');
    expect(seasonName('Severance Season 2', 'Severance', 2)).toBeNull();
    expect(seasonName('Shingeki no Kyojin Season 3', 'Attack on Titan', 3)).toBe('Shingeki no Kyojin Season 3');
    expect(seasonName(null, 'X', 1)).toBeNull();
  });

  it('says Good Day around midday', () => {
    expect([4, 6, 10, 11, 13, 14, 17, 18, 23].map((h) => greeting(h))).toEqual([
      'Good Evening',
      'Good Morning',
      'Good Morning',
      'Good Day',
      'Good Day',
      'Good Afternoon',
      'Good Afternoon',
      'Good Evening',
      'Good Evening',
    ]);
  });
});
