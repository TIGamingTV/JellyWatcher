/**
 * In-process fakes for Jellyfin, Seerr and Trakt, modelled on the request/response shapes verified
 * in docs/integration-matrix.md. Installed as the global fetch so the real adapters are exercised.
 */

export const JF = { url: 'http://jellyfin.test:8096', key: 'jf-secret-key' };
export const SEERR = { url: 'http://seerr.test:5055', key: 'seerr-secret-key' };
export const ALICE_JF = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
export const BOB_JF = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';
export const HEAT_JF = 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3';
export const SEV_JF = 'd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4';
export const IMDB_LIST = 'ls020816781';

export interface MockState {
  jellyfinDown: boolean;
  seerrRequests: { id: number; status: number; is4k: boolean; media: { id: number; tmdbId: number; mediaType: string; status: number }; requestedBy: { id: number; displayName: string }; seasons: { seasonNumber: number }[] }[];
  seerrMedia: Map<string, { id: number; tmdbId: number; mediaType: string; status: number }>;
  seerrCalls: { method: string; path: string; apiUser: string | null; body?: unknown }[];
  traktCalls: string[];
  imdbCalls: { id: string; after: string | null }[];
  letterboxdCalls: string[];
  /** Jellyfin item ids hidden from the library (simulates deleting after watching). */
  jellyfinRemoved: Set<string>;
  logouts: number;
  /** Quick Connect: whether the pending request was approved in a Jellyfin app. */
  quickConnectEnabled: boolean;
  quickConnectApproved: boolean;
  /** API keys created through /Auth/Keys (the guided setup). */
  apiKeys: { AccessToken: string; AppName: string; DateCreated: string }[];
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

export function createMocks() {
  const state: MockState = {
    jellyfinDown: false,
    seerrRequests: [],
    seerrMedia: new Map([['movie:949', { id: 1, tmdbId: 949, mediaType: 'movie', status: 5 }]]),
    seerrCalls: [],
    traktCalls: [],
    imdbCalls: [],
    letterboxdCalls: [],
    jellyfinRemoved: new Set(),
    logouts: 0,
    quickConnectEnabled: true,
    quickConnectApproved: false,
    apiKeys: [],
  };
  const QC_SECRET = 'qc-secret-0001';

  const jellyfinItems = [
    { Id: HEAT_JF, Name: 'Heat', ServerId: 'srv1', Type: 'Movie', ProductionYear: 1995, ProviderIds: { Tmdb: '949', Imdb: 'tt0113277' }, ImageTags: { Primary: 'p1' }, DateCreated: '2026-10-01T00:00:00Z', RunTimeTicks: 170 * 600_000_000 },
    { Id: SEV_JF, Name: 'Severance', ServerId: 'srv1', Type: 'Series', ProductionYear: 2022, ProviderIds: { Tmdb: '95396', Tvdb: '371980' }, RecursiveItemCount: 19, DateCreated: '2026-10-02T00:00:00Z' },
  ];
  // Severance: season 1 (9 episodes, all watched) and season 2 (10 episodes, none watched).
  const sevEpisodes = [
    ...Array.from({ length: 9 }, (_, i) => ({ s: 1, e: i + 1, played: true })),
    ...Array.from({ length: 10 }, (_, i) => ({ s: 2, e: i + 1, played: false })),
  ].map((x) => ({
    Id: `e${x.s}${String(x.e).padStart(2, '0')}`.padEnd(32, '0'),
    Name: `Episode ${x.e}`,
    Type: 'Episode',
    SeriesId: SEV_JF,
    ParentIndexNumber: x.s,
    IndexNumber: x.e,
    RunTimeTicks: 50 * 600_000_000,
    LocationType: 'FileSystem',
    UserData: { Played: x.played, LastPlayedDate: x.played ? '2026-09-01T00:00:00Z' : null },
  }));
  const userData: Record<string, Record<string, unknown>> = {
    [HEAT_JF]: { Played: true, PlayCount: 1, PlayedPercentage: 100 },
    [SEV_JF]: { Played: false, UnplayedItemCount: 10, PlayedPercentage: 47 },
  };

  const seerrDetails = (type: string, id: number) => {
    const known: Record<string, Record<string, unknown>> = {
      'movie:949': { id: 949, title: 'Heat', releaseDate: '1995-12-15', overview: 'A crew of thieves…', posterPath: '/heat.jpg', genres: [{ id: 80, name: 'Crime' }], runtime: 170, imdbId: 'tt0113277' },
      'movie:666277': { id: 666277, title: 'Past Lives', releaseDate: '2023-06-02', overview: 'Childhood friends…', posterPath: '/past.jpg', genres: [{ id: 18, name: 'Drama' }], runtime: 106 },
      'movie:11524': { id: 11524, title: 'Thief', releaseDate: '1981-03-27', posterPath: '/thief.jpg', genres: [{ id: 80, name: 'Crime' }] },
      'movie:438631': { id: 438631, title: 'Dune', releaseDate: '2021-09-15', posterPath: '/dune.jpg', genres: [] },
      'movie:841': { id: 841, title: 'Dune', releaseDate: '1984-12-14', posterPath: '/dune84.jpg', genres: [] },
      'tv:95396': { id: 95396, name: 'Severance', firstAirDate: '2022-02-18', posterPath: '/sev.jpg', genres: [{ id: 18, name: 'Drama' }], seasons: [{ seasonNumber: 0, name: 'Specials' }, { seasonNumber: 1, name: 'Season 1', episodeCount: 9 }, { seasonNumber: 2, name: 'Season 2', episodeCount: 10 }] },
    };
    const d = known[`${type}:${id}`];
    if (!d) return null;
    const media = state.seerrMedia.get(`${type}:${id}`);
    const requests = state.seerrRequests.filter((r) => r.media.tmdbId === id && r.media.mediaType === type);
    return { ...d, mediaInfo: media ? { ...media, requests, seasons: [] } : undefined };
  };

  const searchHits: Record<string, unknown[]> = {
    'past lives': [{ id: 666277, mediaType: 'movie', title: 'Past Lives', releaseDate: '2023-06-02', posterPath: '/past.jpg' }],
    heat: [
      { id: 949, mediaType: 'movie', title: 'Heat', releaseDate: '1995-12-15', posterPath: '/heat.jpg' },
      { id: 70981, mediaType: 'movie', title: 'Heat', releaseDate: '1986-07-11' },
    ],
    'imdb:tt11280740': [{ id: 95396, mediaType: 'tv', name: 'Severance', firstAirDate: '2022-02-18', posterPath: '/sev.jpg' }],
    dune: [
      { id: 438631, mediaType: 'movie', title: 'Dune', releaseDate: '2021-09-15', posterPath: '/dune.jpg' },
      { id: 841, mediaType: 'movie', title: 'Dune', releaseDate: '1984-12-14', posterPath: '/dune84.jpg' },
    ],
  };

  const traktList = { name: 'Michael Mann', description: 'Filmography', privacy: 'public', item_count: 3, likes: 12, ids: { trakt: 777, slug: 'mann' }, user: { username: 'sean', name: 'Sean', ids: { slug: 'sean' } } };
  const traktItems = [
    { rank: 1, id: 1, listed_at: '2026-01-01T00:00:00.000Z', type: 'movie', movie: { title: 'Heat', year: 1995, ids: { trakt: 1, slug: 'heat-1995', imdb: 'tt0113277', tmdb: 949 } } },
    { rank: 2, id: 2, listed_at: '2026-01-02T00:00:00.000Z', type: 'movie', movie: { title: 'Thief', year: 1981, ids: { trakt: 2, slug: 'thief-1981', imdb: 'tt0083190', tmdb: 11524 } } },
    { rank: 3, id: 3, listed_at: '2026-01-03T00:00:00.000Z', type: 'show', show: { title: 'Severance', year: 2022, ids: { trakt: 3, slug: 'severance', tvdb: 371980, tmdb: 95396 } } },
    { rank: 4, id: 4, type: 'episode', episode: { title: 'ep' } },
  ];

  async function handle(input: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;

    // ---- Jellyfin
    if (url.origin === JF.url) {
      if (state.jellyfinDown) return new Response('down', { status: 503 });
      const auth = headers.get('authorization') ?? '';
      if (!auth.startsWith('MediaBrowser ')) return new Response('', { status: 401 });
      const authed = auth.includes(`Token="${JF.key}"`);
      if (authed && /^\/Items\/[a-f0-9]{32}\/Images\/Primary$/.test(url.pathname)) {
        return new Response(Buffer.from([0xff, 0xd8, 0xff]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
      }
      switch (url.pathname) {
        case '/System/Info/Public':
          return json({ ServerName: 'Home', Version: '12.4.0', Id: 'srv1', ProductName: 'Jellyfin Server' });
        case '/System/Info':
          return authed ? json({ ServerName: 'Home', Version: '12.4.0', Id: 'srv1' }) : new Response('', { status: 401 });
        case '/Users':
          return authed ? json([{ Id: ALICE_JF, Name: 'alice', Policy: { IsAdministrator: true } }, { Id: BOB_JF, Name: 'bob', Policy: {} }]) : new Response('', { status: 401 });
        case '/Users/AuthenticateByName':
          if (body?.Username === 'alice' && body?.Pw === 'alicepw') return json({ AccessToken: 'session-token', User: { Id: ALICE_JF, Name: 'alice', Policy: { IsAdministrator: true } }, ServerId: 'srv1' });
          if (body?.Username === 'bob' && body?.Pw === 'bobpw') return json({ AccessToken: 'bob-session', User: { Id: BOB_JF, Name: 'bob', Policy: { IsAdministrator: false } }, ServerId: 'srv1' });
          return new Response('', { status: 401 });
        case '/QuickConnect/Enabled':
          return json(state.quickConnectEnabled);
        case '/QuickConnect/Initiate':
          if (method !== 'POST') return new Response('', { status: 405 });
          if (!state.quickConnectEnabled) return new Response('Quick connect is disabled', { status: 401 });
          if (!auth.includes('DeviceId=')) return new Response('', { status: 400 });
          state.quickConnectApproved = false;
          return json({ Authenticated: false, Secret: QC_SECRET, Code: '246810', DeviceId: 'x', DateAdded: new Date().toISOString() });
        case '/QuickConnect/Connect':
          if (url.searchParams.get('secret') !== QC_SECRET) return new Response('', { status: 404 });
          return json({ Authenticated: state.quickConnectApproved, Secret: QC_SECRET, Code: '246810' });
        case '/Users/AuthenticateWithQuickConnect':
          if (body?.Secret !== QC_SECRET || !state.quickConnectApproved) return new Response('', { status: 400 });
          return json({ AccessToken: 'qc-token', User: { Id: ALICE_JF, Name: 'alice', Policy: { IsAdministrator: true } }, ServerId: 'srv1' });
        case '/Auth/Keys': {
          if (!auth.includes('Token="session-token"') && !auth.includes('Token="qc-token"')) return new Response('', { status: 401 });
          if (method === 'POST') {
            state.apiKeys.push({ AccessToken: JF.key, AppName: url.searchParams.get('app') ?? '', DateCreated: new Date().toISOString() });
            return new Response(null, { status: 204 });
          }
          return json({ Items: state.apiKeys, TotalRecordCount: state.apiKeys.length, StartIndex: 0 });
        }
        case '/Sessions/Logout':
          state.logouts++;
          return new Response(null, { status: 204 });
        case '/Items': {
          if (!authed) return new Response('', { status: 401 });
          const start = Number(url.searchParams.get('startIndex') ?? 0);
          const uid = url.searchParams.get('userId');
          const items = jellyfinItems.filter((i) => !state.jellyfinRemoved.has(i.Id)).slice(start).map((i) => (uid === ALICE_JF ? { ...i, UserData: userData[i.Id] } : uid ? { ...i, UserData: { Played: false } } : i));
          return json({ Items: items, TotalRecordCount: items.length, StartIndex: start });
        }
        case `/Shows/${SEV_JF}/Episodes`: {
          if (!authed) return new Response('', { status: 401 });
          const uid = url.searchParams.get('userId');
          return json({ Items: sevEpisodes.map((e) => (uid === ALICE_JF ? e : { ...e, UserData: { Played: false } })), TotalRecordCount: sevEpisodes.length });
        }
        case '/UserItems/Resume':
          return json({ Items: [], TotalRecordCount: 0 });
      }
      return new Response('', { status: 404 });
    }

    // ---- Seerr
    if (url.origin === SEERR.url) {
      const p = url.pathname.replace('/api/v1', '');
      state.seerrCalls.push({ method, path: p + url.search, apiUser: headers.get('x-api-user'), body });
      // Seerr validates requests with express-openapi-validator, which rejects query values that
      // contain unencoded reserved characters (a space serialised as `+` included).
      for (const pair of url.search.replace(/^\?/, '').split('&').filter(Boolean)) {
        const [name, value = ''] = pair.split('=');
        if (/[/?#[\]@!$&'()*+,;=]/.test(value)) {
          return json({ message: `Parameter '${name}' must be url encoded. Its value may not contain reserved characters.` }, 400);
        }
      }
      if (p === '/status') return json({ version: '3.5.1', commitTag: 'v3.5.1' });
      if (headers.get('x-api-key') !== SEERR.key) return json({ message: 'Unauthorized' }, 403);
      if (p === '/auth/me') return json({ id: 1, displayName: 'Admin', permissions: 2 });
      if (p === '/settings/public') return json({ applicationTitle: 'Seerr', mediaServerType: 2 });
      if (p === '/user') {
        return json({ pageInfo: { pages: 1, page: 1, results: 2 }, results: [{ id: 1, displayName: 'Admin', jellyfinUserId: ALICE_JF, permissions: 2 }, { id: 2, displayName: 'bob', jellyfinUserId: BOB_JF.toUpperCase(), permissions: 32 }] });
      }
      if (p === '/media') {
        const skip = Number(url.searchParams.get('skip') ?? 0);
        const all = [...state.seerrMedia.values()];
        return json({ pageInfo: { pages: 1 }, results: skip ? [] : all });
      }
      if (p === '/request' && method === 'GET') {
        const skip = Number(url.searchParams.get('skip') ?? 0);
        return json({ pageInfo: { pages: 1 }, results: skip ? [] : state.seerrRequests });
      }
      if (p === '/request' && method === 'POST') {
        const key = `${body.mediaType}:${body.mediaId}`;
        if (state.seerrRequests.some((r) => `${r.media.mediaType}:${r.media.tmdbId}` === key && r.status !== 3)) return json({ message: 'Request for this media already exists.' }, 409);
        const apiUser = Number(headers.get('x-api-user') ?? 1);
        const autoApprove = apiUser === 1;
        const media = state.seerrMedia.get(key) ?? { id: state.seerrMedia.size + 1, tmdbId: body.mediaId, mediaType: body.mediaType, status: autoApprove ? 3 : 2 };
        state.seerrMedia.set(key, media);
        const req = {
          id: state.seerrRequests.length + 100,
          status: autoApprove ? 2 : 1,
          is4k: false,
          media,
          requestedBy: { id: apiUser, displayName: apiUser === 1 ? 'Admin' : 'bob' },
          seasons: Array.isArray(body.seasons) ? body.seasons.map((s: number) => ({ seasonNumber: s })) : [],
          createdAt: new Date().toISOString(),
        };
        state.seerrRequests.push(req);
        return json(req, 201);
      }
      const reqMatch = p.match(/^\/request\/(\d+)$/);
      if (reqMatch) {
        const r = state.seerrRequests.find((x) => x.id === Number(reqMatch[1]));
        return r ? json(r) : json({ message: 'not found' }, 404);
      }
      if (p === '/search') {
        const q = (url.searchParams.get('query') ?? '').toLowerCase();
        return json({ page: 1, totalPages: 1, results: searchHits[q] ?? [] });
      }
      const det = p.match(/^\/(movie|tv)\/(\d+)$/);
      if (det) {
        const d = seerrDetails(det[1]!, Number(det[2]));
        return d ? json(d) : json({ message: 'not found' }, 404);
      }
      if (p === '/discover/trending' || p === '/discover/movies') {
        return json({
          page: 1,
          totalPages: 1,
          results: [
            { id: 11524, mediaType: 'movie', title: 'Thief', releaseDate: '1981-03-27', posterPath: '/thief.jpg' },
            { id: 95396, mediaType: 'tv', name: 'Severance', firstAirDate: '2022-02-18', posterPath: '/sev.jpg' },
          ],
        });
      }
      return json({ message: 'not found' }, 404);
    }

    // ---- Trakt
    if (url.origin === 'https://api.trakt.tv') {
      state.traktCalls.push(url.pathname + url.search);
      if (!headers.get('trakt-api-key') || headers.get('trakt-api-version') !== '2') return new Response('', { status: 403 });
      if (url.pathname === '/lists/trending') return json([{ like_count: 1, list: traktList }]);
      if (url.pathname === '/users/sean/lists/mann' || url.pathname === '/lists/777') return json(traktList);
      if (url.pathname === '/lists/777/items') {
        return json(traktItems, 200, { 'x-pagination-page': '1', 'x-pagination-page-count': '1', 'x-pagination-item-count': '4' });
      }
      if (url.pathname.startsWith('/users/private')) return new Response('', { status: 404 });
      return new Response('', { status: 404 });
    }

    // ---- IMDb public GraphQL (list reads)
    if (url.origin === 'https://api.graphql.imdb.com') {
      if (!headers.get('x-imdb-client-name')) return new Response('<html>403 Forbidden</html>', { status: 403 });
      const vars = body?.variables ?? {};
      state.imdbCalls.push({ id: vars.id, after: vars.after ?? null });
      if (vars.id === 'ls000000001') return json({ errors: [{ message: 'Permission denied', extensions: { code: 'FORBIDDEN' } }], data: { list: null } });
      if (vars.id !== IMDB_LIST) return json({ errors: [{ message: 'Not found', extensions: { code: 'RESOURCE_NOT_FOUND' } }], data: { list: null } });
      const t = (id: string, text: string, year: number, type: string, minutes: number, extra: Record<string, unknown> = {}) => ({
        node: { createdDate: '2026-01-01T00:00:00Z', description: null, listItem: { id, titleText: { text }, releaseYear: { year }, titleType: { id: type }, runtime: { seconds: minutes * 60 }, episodes: null, series: null, ...extra } },
      });
      const all = [
        t('tt0113277', 'Heat', 1995, 'movie', 170),
        t('tt11650328', 'Good News About Hell', 2022, 'tvEpisode', 57, { series: { series: { id: 'tt11280740', titleText: { text: 'Severance' }, releaseYear: { year: 2022 } }, episodeNumber: { seasonNumber: 1, episodeNumber: 1 } } }),
        t('tt0083190', 'Thief', 1981, 'movie', 123),
        t('tt11280740', 'Severance', 2022, 'tvSeries', 50, { episodes: { episodes: { total: 19 }, displayableSeasons: { total: 2 } } }),
        t('tt0000001', 'A Game', 2020, 'videoGame', 0),
      ];
      // Two pages to exercise the cursor.
      const page = vars.after === 'c2' ? all.slice(3) : all.slice(0, 3);
      return json({
        data: {
          list: {
            id: IMDB_LIST,
            name: { originalText: 'Mann Timeline' },
            description: null,
            author: { username: { text: 'someone' } },
            visibility: { id: 'PUBLIC' },
            items: { total: all.length, pageInfo: { hasNextPage: vars.after !== 'c2', endCursor: 'c2' }, edges: page },
          },
        },
      });
    }

    // ---- Letterboxd public list pages (HTML)
    if (url.origin === 'https://letterboxd.com') {
      state.letterboxdCalls.push(url.pathname);
      const poster = (slug: string, name: string, i: number) =>
        `<li class="posteritem" data-object-id="filmListEntry:${i}"><div class="react-component" data-component-class="LazyPoster" data-item-name="${name}" data-item-slug="${slug}" data-item-link="/film/${slug}/" data-list-index="${i}"></div></li>`;
      const page = (title: string, items: string, pager: string) =>
        `<!DOCTYPE html><html><head><meta property="og:title" content="${title}"><meta property="og:description" content="Ranked &amp; annotated"></head><body><ul>${items}</ul>${pager}</body></html>`;
      if (url.pathname === '/mann/list/michael-mann-ranked/') {
        return new Response(page('Michael Mann, Ranked', poster('heat', 'Heat (1995)', 0) + poster('thief', 'Thief (1981)', 1), '<div class="paginate-pages"><li class="paginate-page"><a href="/mann/list/michael-mann-ranked/page/2/">2</a></li></div>'), { status: 200, headers: { 'content-type': 'text/html' } });
      }
      if (url.pathname === '/mann/list/michael-mann-ranked/page/2/') {
        return new Response(page('Michael Mann, Ranked', poster('collateral', 'Collateral (2004)', 2) + poster('heat', 'Heat (1995)', 3), ''), { status: 200, headers: { 'content-type': 'text/html' } });
      }
      return new Response('<html><title>Letterboxd - Not Found</title></html>', { status: 404 });
    }

    // ---- MDBList public JSON feed and list page
    if (url.origin === 'https://mdblist.com') {
      if (url.pathname === '/lists/someone/mann-and-more/json') {
        return json([
          { id: 95396, rank: 1, adult: 0, title: 'Severance', tvdbid: 371980, imdb_id: 'tt11280740', mediatype: 'show', release_year: 2022 },
          { id: 949, rank: 2, adult: 0, title: 'Heat', imdb_id: 'tt0113277', mediatype: 'movie', release_year: 1995 },
          { id: 7, rank: 3, adult: 0, title: 'A Person', mediatype: 'person' },
        ]);
      }
      if (url.pathname === '/lists/someone/mann-and-more') {
        return new Response('<html><head><meta property="og:title" content="Mann &amp; More, a list by Some One"></head></html>', { status: 200, headers: { 'content-type': 'text/html' } });
      }
      return new Response('<html><title>Page Not Found</title></html>', { status: 404, headers: { 'content-type': 'text/html' } });
    }

    // ---- Anime: id mapping, AniList GraphQL, MyAnimeList list JSON
    if (url.href === 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json') {
      return json([
        { type: 'TV', mal_id: 100, anilist_id: 1000, simkl_id: 5000, themoviedb_id: { tv: 95396 }, tvdb_id: 371980, season: { tvdb: 1, tmdb: 1 } },
        { type: 'TV', mal_id: 101, anilist_id: 1001, themoviedb_id: { tv: 95396 }, tvdb_id: 371980, season: { tvdb: 2, tmdb: 2 } },
        { type: 'MOVIE', mal_id: 102, anilist_id: 1002, imdb_id: ['tt13238346'], themoviedb_id: { movie: [666277] } },
        { type: 'TV', mal_id: 103, anilist_id: 1003 },
      ]);
    }
    if (url.origin === 'https://graphql.anilist.co') {
      const user = body?.variables?.user;
      if (user === 'hidden') return json({ errors: [{ message: 'Private User', status: 404 }], data: { MediaListCollection: null } }, 404);
      if (user !== 'kana') return json({ errors: [{ message: 'Not Found.', status: 404 }], data: { MediaListCollection: null } }, 404);
      const media = (id: number, idMal: number | null, english: string | null, romaji: string, format: string, episodes: number | null, year: number) => ({
        id, idMal, format, episodes, duration: format === 'MOVIE' ? 138 : 24, seasonYear: year, startDate: { year }, title: { english, romaji }, siteUrl: `https://anilist.co/anime/${id}`,
      });
      return json({
        data: {
          MediaListCollection: {
            user: { name: 'Kana', siteUrl: 'https://anilist.co/user/Kana' },
            lists: [
              {
                name: 'Planning',
                status: 'PLANNING',
                isCustomList: false,
                entries: [
                  { id: 1, status: 'PLANNING', notes: null, createdAt: 1_700_000_000, media: media(1001, 101, 'Severance Season 2', 'Severance 2', 'TV', 10, 2025) },
                  { id: 2, status: 'PLANNING', notes: 'cinema', createdAt: 1_700_000_100, media: media(1002, 102, 'Past Lives', 'Past Lives', 'MOVIE', 1, 2023) },
                  { id: 3, status: 'PLANNING', notes: null, createdAt: 1_700_000_200, media: media(1009, null, null, 'Shiranai Anime', 'TV', 12, 2024) },
                  { id: 4, status: 'PLANNING', notes: null, createdAt: 1_700_000_300, media: media(1010, null, null, 'Some Song', 'MUSIC', 1, 2024) },
                ],
              },
              { name: 'Completed', status: 'COMPLETED', isCustomList: false, entries: [{ id: 5, status: 'COMPLETED', media: media(1000, 100, 'Severance', 'Severance', 'TV', 9, 2022) }] },
            ],
          },
        },
      });
    }
    if (url.origin === 'https://myanimelist.net') {
      const m = url.pathname.match(/^\/animelist\/([^/]+)\/load\.json$/);
      if (!m || m[1] !== 'kana') return new Response('{"errors":[{"message":"invalid request"}]}', { status: 400 });
      if (Number(url.searchParams.get('offset') ?? 0) > 0) return json([]);
      return json([
        { status: 6, anime_id: 100, anime_title: 'Severance', anime_title_eng: 'Severance', anime_num_episodes: 9, anime_media_type_string: 'TV', anime_start_date_string: '02-18-22', notes: '', created_at: 1_700_000_000 },
        { status: 6, anime_id: 101, anime_title: 'Severance 2', anime_title_eng: '', anime_num_episodes: 10, anime_media_type_string: 'TV', anime_start_date_string: '01-17-25', notes: '', created_at: 1_700_000_100 },
      ]);
    }

    if (url.hostname === 'image.tmdb.org') {
      return new Response(Buffer.from([0xff, 0xd8, 0xff]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    throw new TypeError(`fetch failed (unmocked ${url.origin})`);
  }

  return { state, fetch: (input: string | URL | Request, init?: RequestInit) => handle(String(input instanceof Request ? input.url : input), init) };
}
