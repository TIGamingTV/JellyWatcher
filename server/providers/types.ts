import type { MediaType } from '../domain/matching.js';

/** A single entry as reported by a watchlist source, before matching to a canonical title. */
export interface SourceItem {
  sourceKey: string;
  title: string;
  year: number | null;
  mediaType: MediaType | null;
  tmdbId?: number | null;
  imdbId?: string | null;
  tvdbId?: number | null;
  sourceUrl?: string | null;
  position?: number | null;
  listedAt?: string | null;
  notes?: string | null;
  rating?: number | null;
  watchedAt?: string | null;
  /** Set when the entry is one season (or, with episodeNumber, one episode) of a show. */
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  /** Episode title, or for a season entry the name the source uses for it (e.g. an anime season). */
  episodeTitle?: string | null;
  /** Minutes per movie, or per episode for shows, as reported by the source. */
  runtime?: number | null;
  /** Size of a whole-series entry (or of a season entry) as reported by the source. */
  episodes?: number | null;
  seasons?: number | null;
  /**
   * An episode known only by its own IMDb id (CSV exports). Its show and numbers are looked up by
   * resolveEpisodeItems before the list is saved; such items are never saved unresolved.
   */
  episodeImdbId?: string | null;
}

export type ListKind = 'watchlist' | 'owned' | 'liked' | 'public' | 'upload' | 'diary' | 'local';

export interface SourceListInfo {
  externalId: string;
  name: string;
  kind: ListKind;
  description?: string | null;
  ownerName?: string | null;
  url?: string | null;
  itemCount?: number | null;
  likes?: number | null;
}

export interface ListFetchResult {
  info: SourceListInfo;
  items: SourceItem[];
  /** Items the source returned but that cannot be represented (people, games, podcasts). */
  skipped: number;
}

export type SourceId = 'trakt' | 'letterboxd' | 'imdb' | 'tmdb' | 'myanimelist' | 'anilist' | 'simkl' | 'mdblist';

/** Sources whose files can be uploaded on /lists/upload. */
export const UPLOAD_SOURCES = ['letterboxd', 'imdb', 'tmdb', 'myanimelist', 'anilist', 'simkl', 'mdblist'] as const;
export type UploadSource = (typeof UPLOAD_SOURCES)[number];

/** Static description of a watchlist source shown in the UI. Capabilities reflect verified research. */
export interface SourceDescriptor {
  id: SourceId;
  name: string;
  summary: string;
  method: string;
  capabilities: {
    oauth: boolean;
    autoSync: boolean;
    upload: boolean;
    publicLists: boolean;
    urlImport: boolean;
    listSearch: boolean;
  };
  /** Adding a list by its link. Null when the source has no readable list links. */
  link: { example: string; hint: string } | null;
  /** Importing a file. Null when the source has no export. Steps may use **bold**. */
  upload: { accept: string; label: string; steps: string[] } | null;
  limitations: string[];
}

const ANIME_MATCHING =
  'Anime are matched to TMDb through the community-maintained Fribb/anime-lists mapping, so later seasons become season entries of their show. Titles missing from it are matched by name.';

export const SOURCE_DESCRIPTORS: SourceDescriptor[] = [
  {
    id: 'trakt',
    name: 'Trakt',
    summary: 'Sync your Trakt watchlist, your lists, liked lists and any public list.',
    method: 'Official Trakt API with device sign-in',
    capabilities: { oauth: true, autoSync: true, upload: false, publicLists: true, urlImport: true, listSearch: true },
    link: {
      example: 'https://trakt.tv/users/name/lists/list-name',
      hint: 'Any public list works without connecting your Trakt account: franchises, watch orders, filmographies, community lists. A user’s public watchlist link works too.',
    },
    upload: null,
    limitations: [
      'An administrator must register a Trakt API app once (Integrations › Trakt).',
      'Free Trakt accounts can connect at most two community apps.',
      'Every Trakt request needs that app’s Client ID; Trakt rejects requests without one. Public lists need nothing else, no Trakt sign-in.',
      'Trakt limits API use to 500 requests per 5 minutes; large libraries sync gradually.',
      'Link-only (unlisted) lists are not supported by the documented API.',
    ],
  },
  {
    id: 'letterboxd',
    name: 'Letterboxd',
    summary: 'Add public Letterboxd lists and watchlists by link, import your export, and sync your recent diary via RSS.',
    method: 'Public list link, upload of your own export (ZIP or list CSV), and your public RSS feed',
    capabilities: { oauth: false, autoSync: true, upload: true, publicLists: true, urlImport: true, listSearch: false },
    link: {
      example: 'https://letterboxd.com/name/list/list-name/',
      hint: 'Public lists and watchlists (letterboxd.com/name/list/… or /name/watchlist/, boxd.it short links too). They keep their order and sync automatically.',
    },
    upload: {
      accept: '.zip,.csv',
      label: 'Letterboxd export ZIP, or a single list CSV',
      steps: [
        'On letterboxd.com open **Settings › Data › Export Your Data** to download a ZIP. It includes your watchlist and every list, private ones too.',
        'Or open one of your lists and choose **Export** for a single CSV.',
        'Upload it here. Upload a newer export later to update the lists.',
      ],
    },
    limitations: [
      'Letterboxd does not grant API access to personal or self-hosted projects. Links are read from the public list page, the way a browser shows it; a Letterboxd site change can break this until JellyWatcher is updated.',
      'Large lists sync slowly (one page of 100 films at a time). Private lists only work through an export.',
      'Letterboxd shows only title and year, so some films need a quick match review.',
      'Uploaded files update only when you upload a new export.',
      'The RSS feed covers only your ~50 most recent diary entries.',
    ],
  },
  {
    id: 'imdb',
    name: 'IMDb',
    summary: 'Add any public IMDb list by its link, or import your watchlist, lists or ratings from an IMDb CSV export.',
    method: 'Public list link (no account or key needed), or upload of the CSV from IMDb’s Export button',
    capabilities: { oauth: false, autoSync: true, upload: true, publicLists: true, urlImport: true, listSearch: false },
    link: {
      example: 'https://www.imdb.com/list/ls020816781/',
      hint: 'Public IMDb lists work by link: no IMDb account needed, the order is kept (great for watch-order timelines), episodes are included, and the list syncs automatically.',
    },
    upload: {
      accept: '.csv',
      label: 'CSV from IMDb’s Export button',
      steps: [
        'Sign in on imdb.com and open your **Watchlist** or a list.',
        'Choose the **Export** icon (top right). IMDb may prepare the file under **Your exports** first.',
        'Upload the downloaded CSV here. Files named “watchlist” become your IMDb Watchlist; others keep their file name.',
      ],
    },
    limitations: [
      'Links work for public lists (imdb.com/list/ls…). They sync automatically, keep the list order, and include episodes.',
      'Watchlists are private on IMDb unless shared, so import them from a CSV export instead.',
      'Uploaded files update only when you upload a new export. Their episodes are looked up on IMDb to find their show.',
      'IMDb data is for personal, non-commercial use.',
    ],
  },
  {
    id: 'tmdb',
    name: 'TMDb',
    summary: 'Add any public TMDb list by its link, or import a CSV file with TMDb IDs.',
    method: 'TMDb API (uses the TMDb token from Integrations), or a CSV upload',
    capabilities: { oauth: false, autoSync: true, upload: true, publicLists: true, urlImport: true, listSearch: false },
    link: {
      example: 'https://www.themoviedb.org/list/1-the-marvel-universe',
      hint: 'Public TMDb lists keep their order and sync automatically. TMDb IDs match every entry exactly.',
    },
    upload: {
      accept: '.csv',
      label: 'CSV with a TMDb ID column',
      steps: [
        'Use a CSV that has a **TMDb ID** column (tmdb_id), for example an export from TMDb or another tool.',
        'A **type** column (movie or tv) avoids mix-ups between movies and shows with the same ID; a title and year column help when IDs are missing.',
        'Upload it here. If the file has a status column (plan to watch, watching, …), each status becomes its own list.',
      ],
    },
    limitations: [
      'Links need the TMDb API token an administrator adds in Integrations › TMDb (Seerr’s TMDb access cannot read lists).',
      'Private TMDb lists cannot be read; make the list public on TMDb, or upload a CSV.',
      'TMDb watchlists and favorites are private to your TMDb account and cannot be added by link.',
    ],
  },
  {
    id: 'myanimelist',
    name: 'MyAnimeList',
    summary: 'Add a public MyAnimeList anime list by its link, or import your MyAnimeList XML export.',
    method: 'Public anime list link (no account or key needed), or the XML export',
    capabilities: { oauth: false, autoSync: true, upload: true, publicLists: true, urlImport: true, listSearch: false },
    link: {
      example: 'https://myanimelist.net/animelist/name?status=6',
      hint: 'Paste the link of a public anime list. The status in the link picks the list (Plan to Watch when there is none). It syncs automatically.',
    },
    upload: {
      accept: '.xml,.gz',
      label: 'MyAnimeList export (.xml or .xml.gz)',
      steps: [
        'On myanimelist.net open **Profile › Export Lists** (myanimelist.net/panel.php?go=export) and export your **anime list**.',
        'Upload the downloaded .xml.gz file here as it is.',
        'Watching, Plan to Watch and On Hold become separate lists; completed and dropped entries are skipped.',
      ],
    },
    limitations: [
      'Links work for public anime lists only; manga lists are not supported.',
      'Links read the same list data the MyAnimeList website loads (no official API key needed). A site change can break this until JellyWatcher is updated.',
      ANIME_MATCHING,
    ],
  },
  {
    id: 'anilist',
    name: 'AniList',
    summary: 'Add an AniList anime list (Planning, Watching or a custom list) by its link.',
    method: 'Official AniList GraphQL API (no account or key needed), or a MyAnimeList-format XML file',
    capabilities: { oauth: false, autoSync: true, upload: true, publicLists: true, urlImport: true, listSearch: false },
    link: {
      example: 'https://anilist.co/user/name/animelist/Planning',
      hint: 'Paste the link of an AniList anime list. Without a list name in the link, the Planning list is added. It syncs automatically.',
    },
    upload: {
      accept: '.xml,.gz',
      label: 'MyAnimeList-format XML (.xml or .xml.gz)',
      steps: [
        'AniList has no export of its own; tools that export AniList to the **MyAnimeList XML** format work.',
        'Upload that .xml (or .xml.gz) file here.',
        'Watching, Plan to Watch and On Hold become separate lists; completed and dropped entries are skipped.',
      ],
    },
    limitations: ['Profiles set to private on AniList cannot be read by link.', 'Manga lists are not supported.', ANIME_MATCHING],
  },
  {
    id: 'simkl',
    name: 'Simkl',
    summary: 'Import your Simkl watchlists (movies, shows and anime) from a Simkl export file.',
    method: 'Upload of your Simkl export (CSV, JSON or the ZIP)',
    capabilities: { oauth: false, autoSync: false, upload: true, publicLists: false, urlImport: false, listSearch: false },
    link: null,
    upload: {
      accept: '.csv,.json,.zip',
      label: 'Simkl export: CSV, JSON or ZIP',
      steps: [
        'On simkl.com open your **Settings** and export (back up) your library as CSV or JSON.',
        'Upload the file here (the ZIP works too).',
        'Plan to Watch, Watching and On Hold become separate lists; completed and dropped entries are skipped.',
      ],
    },
    limitations: [
      'Simkl only shares lists with apps a person signs in to, so Simkl lists cannot be added by link. Upload a new export to update them.',
      'Entries are matched by their TMDb, IMDb or TVDB IDs where Simkl includes them. ' + ANIME_MATCHING,
    ],
  },
  {
    id: 'mdblist',
    name: 'MDBList',
    summary: 'Add any public MDBList list by its link, or import a list’s CSV export.',
    method: 'Public list link (no API key needed), or the list’s CSV export',
    capabilities: { oauth: false, autoSync: true, upload: true, publicLists: true, urlImport: true, listSearch: false },
    link: {
      example: 'https://mdblist.com/lists/name/list-name',
      hint: 'Public MDBList lists, including dynamic ones, keep their order and sync automatically. Entries carry TMDb and IMDb IDs, so they match exactly.',
    },
    upload: {
      accept: '.csv',
      label: 'MDBList CSV export',
      steps: ['On mdblist.com open a list and choose **Export › CSV**.', 'Upload the downloaded file here.'],
    },
    limitations: ['Links read the list’s public JSON feed; private lists only work through a CSV export.'],
  },
];
