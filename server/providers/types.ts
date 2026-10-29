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
  episodeTitle?: string | null;
  /** Minutes per movie, or per episode for shows, as reported by the source. */
  runtime?: number | null;
  /** Size of a whole-series entry as reported by the source. */
  episodes?: number | null;
  seasons?: number | null;
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
  /** Items the source returned but that cannot be represented (people, games, podcasts). */
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
      'Every Trakt request needs that app’s Client ID; Trakt rejects requests without one. Public lists need nothing else, no Trakt sign-in.',
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
    summary: 'Add any public IMDb list by its link, or import your watchlist, lists or ratings from an IMDb CSV export.',
    method: 'Public list link (no account or key needed), or upload of the CSV from IMDb’s Export button',
    capabilities: { oauth: false, autoSync: true, upload: true, publicLists: true, urlImport: true, listSearch: false },
    limitations: [
      'Links work for public lists (imdb.com/list/ls…). They sync automatically, keep the list order, and include episodes.',
      'Watchlists are private on IMDb unless shared, so import them from a CSV export instead.',
      'Uploaded files update only when you upload a new export, and their episodes are skipped (the CSV has no show information).',
      'IMDb data is for personal, non-commercial use.',
    ],
  },
];
