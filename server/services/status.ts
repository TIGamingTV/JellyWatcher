import type { DB } from '../db/index.js';
import {
  ACTIVE_REQUEST_STATES,
  SeerrMediaStatus,
  lifecycleStage,
  mapSeerrMediaOnly,
  mapSeerrRequest,
  mapViewing,
  type AvailabilityState,
  type FreshStatus,
  type LifecycleStage,
  type RequestState,
  type ViewingState,
} from '../../shared/status.js';
import type { IntegrationStore } from './integrations.js';
import type { SettingsStore } from './settings.js';

export interface Progress {
  percent: number | null;
  playedEpisodes: number | null;
  totalEpisodes: number | null;
  lastPlayedAt: string | null;
}

export interface TitleStatus {
  availability: FreshStatus<AvailabilityState>;
  request: FreshStatus<RequestState> & { requestId: number | null; requestedBy: string | null; mine: boolean };
  viewing: FreshStatus<ViewingState> & { progress: Progress | null };
  stage: LifecycleStage;
  jellyfinItemId: string | null;
}

export interface UserContext {
  id: number;
  jellyfinUserId: string | null;
  seerrUserId: number | null;
}

interface JfRow {
  title_id: number;
  id: string;
  episode_count: number | null;
  played: number | null;
  played_percentage: number | null;
  unplayed_count: number | null;
  position_ticks: number | null;
  last_played_at: string | null;
  synced_at: string | null;
}

interface ReqRow {
  title_id: number;
  id: number;
  user_id: number | null;
  request_status: number | null;
  media_status: number | null;
  seerr_request_id: number | null;
  requested_by: string | null;
  synced_at: string | null;
  updated_at: string;
}

interface HistoryRow {
  title_id: number;
  state: 'watched' | 'in_progress';
  percent: number | null;
  played_episodes: number | null;
  total_episodes: number | null;
  last_played_at: string | null;
  updated_at: string;
}

interface SeerrRow {
  title_id: number;
  status: number | null;
  synced_at: string;
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** Computes the combined status for titles from the locally synced Jellyfin and Seerr state. */
export class StatusService {
  constructor(
    private readonly db: DB,
    private readonly integrations: IntegrationStore,
    private readonly settings: SettingsStore,
  ) {}

  private freshness(provider: 'jellyfin' | 'seerr', intervalMinutes: number) {
    const rec = this.integrations.get(provider);
    const ready = this.integrations.isReady(provider);
    const lastOk = rec.lastOkAt;
    const stale = !ready || !lastOk || rec.status === 'error' || Date.now() - Date.parse(lastOk) > intervalMinutes * 3 * 60_000;
    return { ready, lastOk, stale, error: rec.status === 'error' ? rec.lastError : null };
  }

  forTitles(user: UserContext, titleIds: number[]): Map<number, TitleStatus> {
    const out = new Map<number, TitleStatus>();
    if (titleIds.length === 0) return out;
    const settings = this.settings.all();
    const jf = this.freshness('jellyfin', settings['sync.jellyfinIntervalMinutes']);
    const sr = this.freshness('seerr', settings['sync.seerrIntervalMinutes']);

    const jfRows = new Map<number, JfRow[]>();
    const reqRows = new Map<number, ReqRow[]>();
    const seerrRows = new Map<number, SeerrRow>();
    const history = new Map<number, HistoryRow>();
    const watchedEpisodes = new Map<number, number>();
    for (const ids of chunk(titleIds, 500)) {
      const ph = ids.map(() => '?').join(',');
      const jfAll = this.db
        .prepare(
          `SELECT ji.title_id, ji.id, ji.episode_count, ud.played, ud.played_percentage, ud.unplayed_count, ud.position_ticks, ud.last_played_at, ud.synced_at
             FROM jellyfin_items ji LEFT JOIN jellyfin_user_data ud ON ud.item_id = ji.id AND ud.jellyfin_user_id = ?
            WHERE ji.title_id IN (${ph})`,
        )
        .all(user.jellyfinUserId ?? '', ...ids) as JfRow[];
      for (const r of jfAll) jfRows.set(r.title_id, [...(jfRows.get(r.title_id) ?? []), r]);

      const reqAll = this.db
        .prepare(
          `SELECT title_id, id, user_id, request_status, media_status, seerr_request_id, requested_by, synced_at, updated_at
             FROM requests WHERE title_id IN (${ph}) ORDER BY updated_at DESC`,
        )
        .all(...ids) as ReqRow[];
      for (const r of reqAll) reqRows.set(r.title_id, [...(reqRows.get(r.title_id) ?? []), r]);

      const smAll = this.db
        .prepare(`SELECT t.id AS title_id, sm.status, sm.synced_at FROM titles t JOIN seerr_media sm ON sm.media_type = t.media_type AND sm.tmdb_id = t.tmdb_id WHERE t.id IN (${ph})`)
        .all(...ids) as SeerrRow[];
      for (const r of smAll) seerrRows.set(r.title_id, r);

      const hAll = this.db.prepare(`SELECT * FROM watch_history WHERE user_id = ? AND title_id IN (${ph})`).all(user.id, ...ids) as HistoryRow[];
      for (const r of hAll) history.set(r.title_id, r);
      const weAll = this.db
        .prepare(`SELECT title_id, COUNT(*) AS n FROM watched_episodes WHERE user_id = ? AND season > 0 AND title_id IN (${ph}) GROUP BY title_id`)
        .all(user.id, ...ids) as { title_id: number; n: number }[];
      for (const r of weAll) watchedEpisodes.set(r.title_id, r.n);
    }
    const types = new Map<number, 'movie' | 'tv'>();
    const episodeTotals = new Map<number, number | null>();
    for (const ids of chunk(titleIds, 500)) {
      const rows = this.db.prepare(`SELECT id, media_type, episode_count FROM titles WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as {
        id: number;
        media_type: 'movie' | 'tv';
        episode_count: number | null;
      }[];
      for (const r of rows) {
        types.set(r.id, r.media_type);
        episodeTotals.set(r.id, r.episode_count);
      }
    }

    for (const id of titleIds) {
      const mediaType = types.get(id) ?? 'movie';
      const jfItems = jfRows.get(id) ?? [];
      const seerr = seerrRows.get(id);

      // Availability: Jellyfin is authoritative.
      let availability: FreshStatus<AvailabilityState>;
      if (!jf.ready) {
        availability = { state: 'unknown', syncedAt: null, stale: true, source: null, detail: 'Jellyfin is not connected.' };
      } else if (!jf.lastOk) {
        availability = { state: 'unknown', syncedAt: null, stale: true, source: 'Jellyfin', detail: 'The Jellyfin library has not been synced yet.' };
      } else {
        const inLib = jfItems.length > 0;
        const partial = inLib && mediaType === 'tv' && seerr?.status === SeerrMediaStatus.PARTIALLY_AVAILABLE;
        availability = {
          state: inLib ? (partial ? 'partially_in_library' : 'in_library') : 'not_in_library',
          syncedAt: jf.lastOk,
          stale: jf.stale,
          source: 'Jellyfin',
          detail: jf.error ?? undefined,
        };
      }

      // Request: Seerr is authoritative. Prefer this user's latest request.
      const reqs = reqRows.get(id) ?? [];
      const mine = reqs.find((r) => r.user_id === user.id);
      const req = mine ?? reqs[0];
      let request: TitleStatus['request'];
      if (req) {
        const state: RequestState = req.seerr_request_id === null ? 'submitted' : mapSeerrRequest(req.request_status, req.media_status ?? seerr?.status);
        request = {
          state,
          syncedAt: req.synced_at,
          stale: !sr.ready || sr.stale,
          source: 'Seerr',
          requestId: req.id,
          requestedBy: req.requested_by,
          mine: Boolean(mine),
        };
      } else if (!sr.ready) {
        request = { state: 'unknown', syncedAt: null, stale: true, source: null, detail: 'Seerr is not connected.', requestId: null, requestedBy: null, mine: false };
      } else if (!sr.lastOk) {
        request = { state: 'unknown', syncedAt: null, stale: true, source: 'Seerr', detail: 'Seerr has not been synced yet.', requestId: null, requestedBy: null, mine: false };
      } else {
        request = { state: mapSeerrMediaOnly(seerr?.status), syncedAt: sr.lastOk, stale: sr.stale, source: 'Seerr', requestId: null, requestedBy: null, mine: false };
      }

      // Viewing: Jellyfin user data for the linked account while the title is in the library; after
      // that, the remembered history (titles deleted after watching stay watched).
      let viewing: TitleStatus['viewing'];
      const best = [...jfItems].sort((a, b) => (b.played ?? 0) - (a.played ?? 0) || (b.played_percentage ?? 0) - (a.played_percentage ?? 0))[0];
      const hist = history.get(id);
      const epWatched = watchedEpisodes.get(id) ?? 0;
      if (user.jellyfinUserId && best?.synced_at) {
        const state = mapViewing(mediaType, {
          played: best.played === 1,
          playedPercentage: best.played_percentage,
          positionTicks: best.position_ticks,
          unplayedCount: best.unplayed_count,
          episodeCount: best.episode_count,
        });
        const total = best.episode_count;
        viewing = {
          state,
          syncedAt: best.synced_at,
          stale: jf.stale,
          source: 'Jellyfin',
          progress: {
            percent: state === 'watched' ? 100 : best.played_percentage !== null ? Math.round(best.played_percentage) : null,
            playedEpisodes: mediaType === 'tv' && total !== null && best.unplayed_count !== null ? Math.max(0, total - best.unplayed_count) : null,
            totalEpisodes: mediaType === 'tv' ? total : null,
            lastPlayedAt: best.last_played_at,
          },
        };
      } else if (hist) {
        viewing = {
          state: hist.state,
          syncedAt: hist.updated_at,
          stale: false,
          source: 'Jellyfin',
          detail: hist.state === 'watched' ? 'Watched. No longer in the library.' : 'Progress from before it left the library.',
          progress: { percent: hist.percent, playedEpisodes: hist.played_episodes, totalEpisodes: hist.total_episodes, lastPlayedAt: hist.last_played_at },
        };
      } else if (epWatched > 0) {
        viewing = { state: 'in_progress', syncedAt: null, stale: false, source: 'Jellyfin', detail: 'Progress from before it left the library.', progress: { percent: null, playedEpisodes: null, totalEpisodes: null, lastPlayedAt: null } };
      } else if (!user.jellyfinUserId) {
        viewing = { state: 'unavailable', syncedAt: null, stale: false, source: null, detail: 'Link your Jellyfin account to see viewing progress.', progress: null };
      } else if (!best) {
        viewing = { state: 'unavailable', syncedAt: null, stale: false, source: null, detail: 'Not in the Jellyfin library.', progress: null };
      } else {
        viewing = { state: 'unavailable', syncedAt: null, stale: true, source: 'Jellyfin', detail: 'Viewing progress has not been synced yet.', progress: null };
      }
      // Shows: episodes watched before some seasons were deleted still count.
      if (mediaType === 'tv' && epWatched > 0 && viewing.state !== 'watched' && viewing.progress) {
        const played = Math.max(viewing.progress.playedEpisodes ?? 0, epWatched);
        const total = Math.max(episodeTotals.get(id) ?? 0, viewing.progress.totalEpisodes ?? 0) || null;
        viewing.state = total !== null && played >= total ? 'watched' : 'in_progress';
        viewing.progress = { ...viewing.progress, playedEpisodes: played, totalEpisodes: total, percent: total ? Math.round((Math.min(played, total) / total) * 100) : viewing.progress.percent };
      }

      out.set(id, {
        availability,
        request,
        viewing,
        stage: lifecycleStage(availability.state, request.state, viewing.state),
        jellyfinItemId: best?.id ?? jfItems[0]?.id ?? null,
      });
    }
    return out;
  }

  isActiveRequest(state: RequestState): boolean {
    return ACTIVE_REQUEST_STATES.includes(state);
  }
}
