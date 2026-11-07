/**
 * Janitor rule model, shared by the server (validation, engine) and the web editor. A rule picks
 * Seerr requests (match), decides who has to finish watching them (watchers), then runs its steps
 * in order: waits, notifications, approvals, gates and deletions.
 */

export type JanitorMediaType = 'movie' | 'tv';
export type JanitorUnit = 'movie' | 'season' | 'series';
export type JanitorMode = 'dry_run' | 'approval' | 'auto';

export interface JanitorMatch {
  /** Only requests by these people (JellyWatcher user ids); empty: everyone. */
  requestedBy: number[];
  /** 4K requests: either, only 4K, or only regular ones. */
  is4k: 'any' | 'yes' | 'no';
  /** Shows only: the show's status in Sonarr. */
  seriesStatus: 'any' | 'ended' | 'continuing';
}

export type OthersPolicy = 'none' | 'active' | 'watchlisted' | 'active_or_watchlisted' | 'all_linked';

export interface JanitorWatchers {
  /** The people who requested it must have finished it. */
  requester: 'required' | 'ignored';
  /**
   * Who else counts: nobody, anyone who started it, anyone with it on a watchlist, either of them,
   * or every person with a linked Jellyfin account.
   */
  others: OthersPolicy;
  /** All of them must finish, or at least `atLeast` of them. */
  othersMode: 'all' | 'at_least';
  atLeast: number;
  /** Others who have not played anything of it for this many days stop holding it back; null: never. */
  dropAfterDays: number | null;
}

export type JanitorStep =
  | { type: 'wait'; days: number; hours: number }
  | { type: 'notify'; message: string }
  | { type: 'approval' }
  /** When the condition is not met: stop here, or check again every day. */
  | { type: 'gate'; condition: 'series_ended' | 'no_files_left'; otherwise: 'stop' | 'recheck' }
  | { type: 'sonarr_delete_season'; unmonitor: boolean }
  | { type: 'sonarr_delete_series'; importListExclusion: boolean }
  | { type: 'radarr_delete_movie'; importExclusion: boolean }
  | { type: 'seerr_delete_request' }
  | { type: 'seerr_delete_media' };

export type JanitorStepType = JanitorStep['type'];

export interface JanitorRuleInput {
  name: string;
  enabled: boolean;
  mediaType: JanitorMediaType;
  unit: JanitorUnit;
  mode: JanitorMode;
  match: JanitorMatch;
  watchers: JanitorWatchers;
  steps: JanitorStep[];
}

export interface JanitorRule extends JanitorRuleInput {
  id: number;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export const DESTRUCTIVE_STEPS: ReadonlySet<JanitorStepType> = new Set(['sonarr_delete_season', 'sonarr_delete_series', 'radarr_delete_movie', 'seerr_delete_request', 'seerr_delete_media']);

/** Which steps fit which unit. */
export const STEPS_FOR_UNIT: Record<JanitorUnit, JanitorStepType[]> = {
  movie: ['wait', 'notify', 'approval', 'radarr_delete_movie', 'seerr_delete_request', 'seerr_delete_media'],
  season: ['wait', 'notify', 'approval', 'gate', 'sonarr_delete_season', 'sonarr_delete_series', 'seerr_delete_request', 'seerr_delete_media'],
  series: ['wait', 'notify', 'approval', 'gate', 'sonarr_delete_series', 'seerr_delete_request', 'seerr_delete_media'],
};

export const STEP_LABEL: Record<JanitorStepType, string> = {
  wait: 'Wait',
  notify: 'Notify in Home Assistant',
  approval: 'Wait for approval',
  gate: 'Continue only if…',
  sonarr_delete_season: 'Delete season in Sonarr',
  sonarr_delete_series: 'Delete show in Sonarr',
  radarr_delete_movie: 'Delete movie in Radarr',
  seerr_delete_request: 'Delete the request in Seerr',
  seerr_delete_media: 'Remove the title from Seerr',
};

export const GATE_LABEL: Record<'series_ended' | 'no_files_left', string> = {
  series_ended: 'the show has ended in Sonarr',
  no_files_left: 'no episode files are left (specials aside)',
};

export const DEFAULT_NOTIFY_MESSAGE = '{title} will be deleted on {date}.';

export function defaultStep(type: JanitorStepType): JanitorStep {
  switch (type) {
    case 'wait':
      return { type, days: 7, hours: 0 };
    case 'notify':
      return { type, message: DEFAULT_NOTIFY_MESSAGE };
    case 'gate':
      return { type, condition: 'series_ended', otherwise: 'recheck' };
    case 'sonarr_delete_season':
      return { type, unmonitor: true };
    case 'sonarr_delete_series':
      return { type, importListExclusion: false };
    case 'radarr_delete_movie':
      return { type, importExclusion: false };
    default:
      return { type } as JanitorStep;
  }
}

export const DEFAULT_MATCH: JanitorMatch = { requestedBy: [], is4k: 'any', seriesStatus: 'any' };
export const DEFAULT_WATCHERS: JanitorWatchers = { requester: 'required', others: 'none', othersMode: 'all', atLeast: 1, dropAfterDays: 30 };

export type JanitorTemplate = 'movie' | 'tv_season' | 'tv_series';

/** Starting points; created disabled and in dry run. */
export function templateRule(kind: JanitorTemplate): JanitorRuleInput {
  const base = { enabled: false, mode: 'dry_run' as const, match: { ...DEFAULT_MATCH }, watchers: { ...DEFAULT_WATCHERS } };
  switch (kind) {
    case 'movie':
      return {
        ...base,
        name: 'Watched movies',
        mediaType: 'movie',
        unit: 'movie',
        steps: [
          { type: 'wait', days: 7, hours: 0 },
          { type: 'notify', message: DEFAULT_NOTIFY_MESSAGE },
          { type: 'wait', days: 3, hours: 0 },
          { type: 'radarr_delete_movie', importExclusion: false },
          { type: 'seerr_delete_request' },
        ],
      };
    case 'tv_season':
      return {
        ...base,
        name: 'Watched seasons',
        mediaType: 'tv',
        unit: 'season',
        steps: [
          { type: 'wait', days: 7, hours: 0 },
          { type: 'notify', message: DEFAULT_NOTIFY_MESSAGE },
          { type: 'wait', days: 3, hours: 0 },
          { type: 'sonarr_delete_season', unmonitor: true },
          { type: 'gate', condition: 'series_ended', otherwise: 'recheck' },
          { type: 'gate', condition: 'no_files_left', otherwise: 'stop' },
          { type: 'sonarr_delete_series', importListExclusion: false },
          { type: 'seerr_delete_request' },
        ],
      };
    case 'tv_series':
      return {
        ...base,
        name: 'Finished shows',
        mediaType: 'tv',
        unit: 'series',
        match: { ...DEFAULT_MATCH, seriesStatus: 'ended' },
        steps: [
          { type: 'wait', days: 14, hours: 0 },
          { type: 'notify', message: DEFAULT_NOTIFY_MESSAGE },
          { type: 'wait', days: 3, hours: 0 },
          { type: 'sonarr_delete_series', importListExclusion: false },
          { type: 'seerr_delete_request' },
        ],
      };
  }
}

export type CandidateState = 'waiting' | 'awaiting_approval' | 'running' | 'done' | 'failed';
export type LogOutcome = 'ok' | 'would' | 'skipped' | 'failed' | 'info';

export function unitLabel(title: string, season: number): string {
  return season >= 0 ? `${title} · Season ${season}` : title;
}
