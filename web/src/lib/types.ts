import type { AvailabilityState, FreshStatus, LifecycleStage, RequestState, ViewingState } from '../../../shared/status';

export type MediaType = 'movie' | 'tv';

export type SourceId = 'trakt' | 'letterboxd' | 'imdb' | 'tmdb' | 'myanimelist' | 'anilist' | 'simkl' | 'mdblist';
export type UploadSource = Exclude<SourceId, 'trakt'>;

export interface SourceDescriptor {
  id: SourceId;
  name: string;
  summary: string;
  method: string;
  capabilities: { oauth: boolean; autoSync: boolean; upload: boolean; publicLists: boolean; urlImport: boolean; listSearch: boolean };
  link: { example: string; hint: string } | null;
  upload: { accept: string; label: string; steps: string[] } | null;
  limitations: string[];
}

export interface Me {
  user: null | {
    id: number;
    username: string;
    displayName: string;
    role: 'admin' | 'user';
    authSource: 'local' | 'jellyfin';
    hasPassword: boolean;
    jellyfin: { userId: string; username: string | null } | null;
    seerr: { userId: number; username: string | null } | null;
    preferences: { appearance?: 'system' | 'light' | 'dark'; posterSize?: 'small' | 'medium' | 'large' };
  };
  csrfToken?: string;
  needsSetup: boolean;
  jellyfinLogin: boolean;
  /** Jellyfin sign-in details, when signing in with Jellyfin is available. */
  jellyfin: { serverName: string | null; quickConnect: boolean; autoCreate: boolean } | null;
  version: string;
  services?: { jellyfin: boolean; seerr: boolean; tmdb: boolean; trakt: boolean; metadata: 'tmdb' | 'seerr' | null };
  sources?: SourceDescriptor[];
}

export interface TitleCard {
  id: number;
  mediaType: MediaType;
  tmdbId: number | null;
  title: string;
  year: number | null;
  posterUrl: string | null;
  genres: string[];
  stage: LifecycleStage;
  availability: AvailabilityState;
  request: RequestState;
  viewing: ViewingState;
  progress: number | null;
  stale: boolean;
  lists?: { id: number; name: string; provider: string }[];
}

export interface ListView {
  id: number;
  provider: SourceId | 'local';
  kind: 'watchlist' | 'owned' | 'liked' | 'public' | 'upload' | 'diary' | 'local';
  name: string;
  description: string | null;
  ownerName: string | null;
  url: string | null;
  autoSync: boolean;
  canSync: boolean;
  itemCount: number;
  matched: number;
  needsReview: number;
  pending: number;
  lastSyncedAt: string | null;
  lastAttemptAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  display: 'auto' | 'grid' | 'timeline';
  /** Shown as a timeline (the standard view unless the grid was chosen). */
  timeline: boolean;
  /** Created in JellyWatcher: entries can be added and removed. */
  editable: boolean;
  /** Reordered by the person (kept across syncs). */
  customOrder: boolean;
  summary: TimelineSummary | null;
  createdAt: string;
}

export interface TimelineSummary {
  entries: number;
  films: number;
  shows: number;
  seasons: number;
  episodes: number;
  totalMinutes: number;
  watchedMinutes: number;
  remainingMinutes: number;
  watchedEntries: number;
  skippedEntries: number;
  unknownRuntime: number;
  unmatched: number;
}

export interface TimelineEntry {
  itemId: number;
  position: number;
  kind: 'movie' | 'show' | 'season' | 'episode';
  matched: boolean;
  title: TitleCard | null;
  sourceTitle: string;
  year: number | null;
  season: number | null;
  episode: number | null;
  episodeTitle: string | null;
  episodes: number | null;
  seasons: number | null;
  watchedEpisodes: number | null;
  runtime: number | null;
  watchedMinutes: number;
  state: 'watched' | 'in_progress' | 'unwatched';
  percent: number;
  availability: AvailabilityState;
  stage: LifecycleStage;
  sourceUrl: string | null;
  /** Date of the person's own watched mark covering this entry. */
  manualAt: string | null;
  watchedAt: string | null;
  /** Marked "Not Watching": Up Next passes over it. */
  skipped: boolean;
}

export interface Timeline {
  entries: TimelineEntry[];
  summary: TimelineSummary;
  nextIndex: number | null;
}

export interface UpNextItem {
  list: { id: number; name: string; provider: string };
  lists: { id: number; name: string; provider: string }[];
  timeline: boolean;
  position: number;
  of: number;
  remainingMinutes: number;
  action: 'watch' | 'waiting' | 'request';
  entry: TimelineEntry;
}

export interface TitleStatus {
  availability: FreshStatus<AvailabilityState>;
  request: FreshStatus<RequestState> & { requestId: number | null; requestedBy: string | null; mine: boolean };
  viewing: FreshStatus<ViewingState> & { progress: { percent: number | null; playedEpisodes: number | null; totalEpisodes: number | null; lastPlayedAt: string | null } | null };
  stage: LifecycleStage;
  jellyfinItemId: string | null;
}

export interface TitleDetail {
  title: {
    id: number;
    mediaType: MediaType;
    tmdbId: number | null;
    imdbId: string | null;
    tvdbId: number | null;
    title: string;
    originalTitle: string | null;
    year: number | null;
    releaseDate: string | null;
    overview: string | null;
    genres: string[];
    runtime: number | null;
    posterUrl: string | null;
    backdropUrl: string | null;
    metadataSource: string | null;
  };
  status: TitleStatus;
  lists: { id: number; name: string; provider: string; kind: string; sourceUrl: string | null; rating: number | null; notes: string | null; listedAt: string | null; watchedAt: string | null; matchMethod: string | null; itemId: number }[];
  requests: { id: number; requestedBy: string | null; requestStatus: number | null; mediaStatus: number | null; is4k: number; seasons: number[]; createdAt: string; syncedAt: string | null; lastError: string | null; mine: boolean }[];
  links: { jellyfin: string | null; seerr: string | null; tmdb: string | null; imdb: string | null };
  jellyfin: { itemId: string; addedAt: string | null } | null;
  watch: WatchDetail;
}

export interface EpisodeWatch {
  episode: number;
  watched: boolean;
  source: 'manual' | 'jellyfin' | null;
  watchedAt: string | null;
  inLibrary: boolean;
}

export interface SeasonWatch {
  season: number;
  episodes: number | null;
  watched: number;
  manualAt: string | null;
  list: EpisodeWatch[];
}

export interface WatchDetail {
  /** Date of a manual mark for the whole title. */
  manualAt: string | null;
  watchedAt: string | null;
  seasons: SeasonWatch[];
}

export interface DiscoverResult {
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  year: number | null;
  overview: string | null;
  posterPath: string | null;
  posterUrl: string | null;
  titleId: number | null;
  inLibrary: boolean;
  inList: boolean;
}

export interface QuickConnectStart {
  id: string;
  code: string;
  expiresAt: string;
  interval: number;
}

export interface Eligibility {
  canRequest: boolean;
  reason: string | null;
  message: string | null;
  liveState: RequestState | null;
  autoApprove: boolean;
  seasons: { seasonNumber: number; name: string | null; episodeCount: number | null; state: RequestState; requestable: boolean }[];
  checkedAt: string;
}

export interface IntegrationView {
  provider: 'jellyfin' | 'seerr' | 'tmdb' | 'trakt';
  enabled?: boolean;
  ready: boolean;
  config?: Record<string, string | undefined>;
  secretsSet?: Record<string, boolean>;
  status: 'unconfigured' | 'ok' | 'error';
  lastCheckedAt?: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  serverInfo?: Record<string, unknown> | null;
}

export interface TestResult {
  ok: boolean;
  message?: string;
  info?: Record<string, unknown>;
  warnings?: string[];
}

export interface ConnectionView {
  id: number;
  provider: string;
  accountName: string | null;
  status: 'connected' | 'needs_reauth' | 'error';
  lastError: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
  config: Record<string, unknown>;
  tokenExpiresAt?: string | null;
}

export interface SourcesResponse {
  sources: (SourceDescriptor & { available: boolean; linkReady: boolean; connection: ConnectionView | null; listCount: number })[];
  jellyfin: { available: boolean; linked: { userId: string; username: string | null } | null };
  seerr: { available: boolean; linked: { userId: number; username: string | null } | null };
}

export interface TraktListInfo {
  externalId: string;
  name: string;
  kind: string;
  description?: string | null;
  ownerName?: string | null;
  url?: string | null;
  itemCount?: number | null;
  likes?: number | null;
  imported?: boolean;
}

export interface SyncRun {
  id: number;
  job: string;
  scope: string | null;
  trigger: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  stats: Record<string, unknown>;
  error: string | null;
}
