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
}

export type ListKind = 'watchlist' | 'owned' | 'liked' | 'public' | 'upload' | 'diary';

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
  /** Items the source returned but that cannot be represented (episodes, people, games). */
  skipped: number;
}

/** Static description of a watchlist source shown in the UI. Capabilities reflect verified research. */
export interface SourceDescriptor {
  id: 'trakt' | 'letterboxd' | 'imdb';
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
  limitations: string[];
}

export const SOURCE_DESCRIPTORS: SourceDescriptor[] = [
  {
    id: 'trakt',
    name: 'Trakt',
    summary: 'Sync your Trakt watchlist, your lists, liked lists and any public list.',
    method: 'Official Trakt API with device sign-in',
    capabilities: { oauth: true, autoSync: true, upload: false, publicLists: true, urlImport: true, listSearch: true },
    limitations: [
      'An administrator must register a Trakt API app once (Integrations › Trakt).',
      'Free Trakt accounts can connect at most two community apps.',
      'Trakt limits API use to 500 requests per 5 minutes; large libraries sync gradually.',
      'Link-only (unlisted) lists are not supported by the documented API.',
    ],
  },
  {
    id: 'letterboxd',
    name: 'Letterboxd',
    summary: 'Import your watchlist and lists from a Letterboxd export, plus your recent diary via RSS.',
    method: 'Upload of your own export (ZIP or list CSV) and your public RSS feed',
    capabilities: { oauth: false, autoSync: false, upload: true, publicLists: false, urlImport: false, listSearch: false },
    limitations: [
      'Letterboxd does not grant API access to personal or self-hosted projects.',
      'Watchlists and lists update only when you upload a new export.',
      'Exports contain only title and year, so some films need a quick match review.',
      'Other members’ lists cannot be imported: Letterboxd’s terms prohibit exporting them.',
      'The RSS feed covers only your ~50 most recent diary entries.',
    ],
  },
  {
    id: 'imdb',
    name: 'IMDb',
    summary: 'Import your IMDb watchlist, lists or ratings from the CSV file IMDb exports.',
    method: 'Upload of the CSV file produced by IMDb’s Export button',
    capabilities: { oauth: false, autoSync: false, upload: true, publicLists: false, urlImport: false, listSearch: false },
    limitations: [
      'IMDb offers no API for personal lists and blocks automated access.',
      'Lists update only when you upload a new export.',
      'Episodes, games and podcasts in exports are skipped.',
    ],
  },
];
