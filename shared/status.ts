/**
 * Internal status model. Raw service states (Seerr enums, Jellyfin user data) are mapped into
 * these consistent UI concepts without dropping distinctions that matter to people.
 */

/** Seerr `MediaRequestStatus` (server/constants/media.ts, verified for Seerr v3.5). */
export const SeerrRequestStatus = {
  PENDING: 1,
  APPROVED: 2,
  DECLINED: 3,
  FAILED: 4,
  COMPLETED: 5,
} as const;

/** Seerr `MediaStatus` (server/constants/media.ts, verified for Seerr v3.5). */
export const SeerrMediaStatus = {
  UNKNOWN: 1,
  PENDING: 2,
  PROCESSING: 3,
  PARTIALLY_AVAILABLE: 4,
  AVAILABLE: 5,
  BLOCKLISTED: 6,
  DELETED: 7,
} as const;

export type RequestState =
  | 'not_requested'
  | 'submitted'
  | 'pending_approval'
  | 'approved'
  | 'processing'
  | 'partially_available'
  | 'available'
  | 'declined'
  | 'failed'
  | 'blocklisted'
  | 'unknown';

export type AvailabilityState = 'in_library' | 'partially_in_library' | 'not_in_library' | 'unknown';

export type ViewingState = 'watched' | 'in_progress' | 'unwatched' | 'unavailable';

export interface FreshStatus<T> {
  state: T;
  /** ISO timestamp of the sync that produced this state, or null if never synced. */
  syncedAt: string | null;
  /** True when the underlying sync is older than expected or the last sync failed. */
  stale: boolean;
  /** Human readable origin, e.g. "Jellyfin", "Seerr". */
  source: string | null;
  detail?: string;
}

export function mapSeerrRequest(requestStatus: number | null | undefined, mediaStatus: number | null | undefined): RequestState {
  switch (requestStatus) {
    case SeerrRequestStatus.PENDING:
      return 'pending_approval';
    case SeerrRequestStatus.DECLINED:
      return 'declined';
    case SeerrRequestStatus.FAILED:
      return 'failed';
    case SeerrRequestStatus.COMPLETED:
      if (mediaStatus === SeerrMediaStatus.PARTIALLY_AVAILABLE) return 'partially_available';
      return 'available';
    case SeerrRequestStatus.APPROVED:
      return mapSeerrMediaForApproved(mediaStatus);
    default:
      return requestStatus == null ? mapSeerrMediaOnly(mediaStatus) : 'unknown';
  }
}

function mapSeerrMediaForApproved(mediaStatus: number | null | undefined): RequestState {
  switch (mediaStatus) {
    case SeerrMediaStatus.PROCESSING:
      return 'processing';
    case SeerrMediaStatus.PARTIALLY_AVAILABLE:
      return 'partially_available';
    case SeerrMediaStatus.AVAILABLE:
      return 'available';
    case SeerrMediaStatus.BLOCKLISTED:
      return 'blocklisted';
    default:
      return 'approved';
  }
}

/** Status of media in Seerr when we do not know of a specific request. */
export function mapSeerrMediaOnly(mediaStatus: number | null | undefined): RequestState {
  switch (mediaStatus) {
    case SeerrMediaStatus.PENDING:
      return 'pending_approval';
    case SeerrMediaStatus.PROCESSING:
      return 'processing';
    case SeerrMediaStatus.PARTIALLY_AVAILABLE:
      return 'partially_available';
    case SeerrMediaStatus.AVAILABLE:
      return 'available';
    case SeerrMediaStatus.BLOCKLISTED:
      return 'blocklisted';
    case SeerrMediaStatus.UNKNOWN:
    case SeerrMediaStatus.DELETED:
    case null:
    case undefined:
      return 'not_requested';
    default:
      return 'unknown';
  }
}

/** Request states that mean "a request is in flight, do not request again". */
export const ACTIVE_REQUEST_STATES: RequestState[] = ['submitted', 'pending_approval', 'approved', 'processing'];

export interface JellyfinUserDataLike {
  played: boolean;
  playedPercentage: number | null;
  positionTicks: number | null;
  unplayedCount: number | null;
  episodeCount: number | null;
}

export function mapViewing(mediaType: 'movie' | 'tv', data: JellyfinUserDataLike | null): ViewingState {
  if (!data) return 'unavailable';
  if (mediaType === 'movie') {
    if (data.played) return 'watched';
    if ((data.positionTicks ?? 0) > 0 || (data.playedPercentage ?? 0) > 0) return 'in_progress';
    return 'unwatched';
  }
  // Series: Jellyfin derives Played from all child episodes being played.
  const total = data.episodeCount ?? null;
  const unplayed = data.unplayedCount ?? null;
  if (data.played && (total === null || total > 0)) return 'watched';
  if (total !== null && unplayed !== null && unplayed < total) return 'in_progress';
  if ((data.playedPercentage ?? 0) > 0) return 'in_progress';
  return 'unwatched';
}

export const REQUEST_STATE_LABEL: Record<RequestState, string> = {
  not_requested: 'Not Requested',
  submitted: 'Request Submitted',
  pending_approval: 'Pending Approval',
  approved: 'Approved',
  processing: 'Processing',
  partially_available: 'Partially Available',
  available: 'Available',
  declined: 'Declined',
  failed: 'Failed',
  blocklisted: 'Blocklisted',
  unknown: 'Unknown',
};

export const AVAILABILITY_LABEL: Record<AvailabilityState, string> = {
  in_library: 'In Library',
  partially_in_library: 'Partly in Library',
  not_in_library: 'Not in Library',
  unknown: 'Library Unknown',
};

export const VIEWING_LABEL: Record<ViewingState, string> = {
  watched: 'Watched',
  in_progress: 'In Progress',
  unwatched: 'Unwatched',
  unavailable: 'Not Tracked',
};

/**
 * The single most relevant lifecycle stage for compact displays (poster badges), most advanced first.
 */
export type LifecycleStage =
  | 'watched'
  | 'in_progress'
  | 'in_library'
  | 'reported_available'
  | 'partially_available'
  | 'processing'
  | 'pending_approval'
  | 'requested'
  | 'declined'
  | 'failed'
  | 'listed'
  | 'unknown';

export function lifecycleStage(
  availability: AvailabilityState,
  request: RequestState,
  viewing: ViewingState,
): LifecycleStage {
  if (viewing === 'watched') return 'watched';
  if (viewing === 'in_progress') return 'in_progress';
  if (availability === 'in_library') return 'in_library';
  if (availability === 'partially_in_library' || request === 'partially_available') return 'partially_available';
  switch (request) {
    case 'available':
      // Seerr says available but Jellyfin has not confirmed it (not linked, stale, or no provider ids).
      // Jellyfin is authoritative for the library, so keep this distinct from in_library.
      return 'reported_available';
    case 'processing':
    case 'approved':
      return 'processing';
    case 'pending_approval':
      return 'pending_approval';
    case 'submitted':
      return 'requested';
    case 'declined':
    case 'blocklisted':
      return 'declined';
    case 'failed':
      return 'failed';
    case 'unknown':
      return 'unknown';
    default:
      return 'listed';
  }
}

/**
 * Whether a timeline entry offers a Request button: it is matched, not watched or skipped, and
 * nothing is on its way yet (or, for parts of a show, the show is only partly there). Seerr has the
 * final word when the request sheet opens.
 */
export function entryRequestable(e: { matched: boolean; state: string; skipped: boolean; kind: string; stage: LifecycleStage }): boolean {
  if (!e.matched || e.state === 'watched' || e.skipped) return false;
  if (e.stage === 'listed' || e.stage === 'declined' || e.stage === 'failed') return true;
  return e.kind !== 'movie' && e.stage === 'partially_available';
}

export const STAGE_LABEL: Record<LifecycleStage, string> = {
  watched: 'Watched',
  in_progress: 'In Progress',
  in_library: 'In Library',
  reported_available: 'Available in Seerr',
  partially_available: 'Partially Available',
  processing: 'Processing',
  pending_approval: 'Pending Approval',
  requested: 'Requested',
  declined: 'Declined',
  failed: 'Failed',
  listed: 'On Watchlist',
  unknown: 'Needs Sync',
};
