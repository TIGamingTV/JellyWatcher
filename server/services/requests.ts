import type { AppContext } from '../context.js';
import { nowIso } from '../db/index.js';
import { ApiError, ProviderError } from '../http/errors.js';
import { SeerrMediaStatus, mapSeerrMediaOnly, mapSeerrRequest, type RequestState } from '../../shared/status.js';
import { seerrCan, type SeerrDetails } from '../providers/seerr.js';
import { upsertRequest } from '../sync/seerr.js';

export interface SeasonOption {
  seasonNumber: number;
  name: string | null;
  episodeCount: number | null;
  state: RequestState;
  requestable: boolean;
}

export interface Eligibility {
  canRequest: boolean;
  /** Machine reason when canRequest is false. */
  reason:
    | null
    | 'seerr_not_configured'
    | 'seerr_not_linked'
    | 'no_tmdb_id'
    | 'already_available'
    | 'already_requested'
    | 'blocklisted'
    | 'no_permission'
    | 'seerr_unreachable';
  message: string | null;
  liveState: RequestState | null;
  autoApprove: boolean;
  seasons: SeasonOption[];
  checkedAt: string;
}

const inflight = new Set<string>();

function seasonStates(details: SeerrDetails): SeasonOption[] {
  const mediaSeasons = new Map((details.mediaInfo?.seasons ?? []).map((s) => [s.seasonNumber, s.status ?? null]));
  // Seasons claimed by open requests (pending/approved).
  const requested = new Set<number>();
  for (const r of (details.mediaInfo?.requests ?? []) as { status?: number; is4k?: boolean; seasons?: { seasonNumber: number }[] }[]) {
    if (r.is4k) continue;
    if (r.status === 1 || r.status === 2) for (const s of r.seasons ?? []) requested.add(s.seasonNumber);
  }
  return (details.seasons ?? [])
    .filter((s) => s.seasonNumber > 0)
    .map((s) => {
      const st = mediaSeasons.get(s.seasonNumber);
      let state: RequestState = mapSeerrMediaOnly(st);
      if (requested.has(s.seasonNumber) && (state === 'not_requested' || state === 'unknown')) state = 'pending_approval';
      const requestable = !requested.has(s.seasonNumber) && (st == null || st === SeerrMediaStatus.UNKNOWN || st === SeerrMediaStatus.DELETED);
      return { seasonNumber: s.seasonNumber, name: s.name ?? null, episodeCount: s.episodeCount ?? null, state, requestable };
    });
}

/**
 * Checks live against Seerr whether the user may request a title. This guards against duplicates
 * even when the local mirror is stale.
 */
export async function checkEligibility(ctx: AppContext, user: { id: number; seerrUserId: number | null; seerrPermissions?: number | null }, titleId: number): Promise<Eligibility & { details?: SeerrDetails }> {
  const base = { liveState: null, autoApprove: false, seasons: [], checkedAt: nowIso() };
  const title = ctx.titles.get(titleId);
  if (!title) throw new ApiError(404, 'not_found', 'Title not found.');
  const seerr = ctx.integrations.seerr();
  if (!seerr) return { ...base, canRequest: false, reason: 'seerr_not_configured', message: 'Requests need Seerr. An administrator can connect it in Integrations.' };
  if (!user.seerrUserId) {
    return { ...base, canRequest: false, reason: 'seerr_not_linked', message: 'Your account is not linked to a Seerr user yet. Ask an administrator to link it in Settings › Users.' };
  }
  if (!title.tmdb_id) return { ...base, canRequest: false, reason: 'no_tmdb_id', message: 'This title has no TMDb match, which Seerr needs. Resolve the match first.' };

  let details: SeerrDetails;
  try {
    details = await seerr.details(title.media_type, title.tmdb_id, user.seerrUserId);
  } catch (err) {
    const msg = err instanceof ProviderError ? err.message : 'Seerr could not be reached.';
    return { ...base, canRequest: false, reason: 'seerr_unreachable', message: `Could not check Seerr: ${msg}` };
  }
  const info = details.mediaInfo;
  const status = info?.status ?? null;
  const openRequest = ((info?.requests ?? []) as { status?: number; is4k?: boolean }[]).find((r) => !r.is4k && (r.status === 1 || r.status === 2));
  const liveState: RequestState = openRequest ? mapSeerrRequest(openRequest.status, status) : mapSeerrMediaOnly(status);
  const seasons = title.media_type === 'tv' ? seasonStates(details) : [];
  const perms = seerrCan(user.seerrPermissions ?? null, title.media_type);
  const common = { liveState, autoApprove: perms.autoApprove, seasons, checkedAt: nowIso(), details };

  if (status === SeerrMediaStatus.BLOCKLISTED) return { ...common, canRequest: false, reason: 'blocklisted', message: 'This title is on the Seerr blocklist.' };
  if (title.media_type === 'movie') {
    if (status === SeerrMediaStatus.AVAILABLE) return { ...common, canRequest: false, reason: 'already_available', message: 'This movie is already available.' };
    if (openRequest || status === SeerrMediaStatus.PENDING || status === SeerrMediaStatus.PROCESSING) {
      return { ...common, canRequest: false, reason: 'already_requested', message: 'This movie has already been requested.' };
    }
  } else {
    if (seasons.length > 0 && !seasons.some((s) => s.requestable)) {
      const allAvailable = seasons.every((s) => s.state === 'available');
      return {
        ...common,
        canRequest: false,
        reason: allAvailable ? 'already_available' : 'already_requested',
        message: allAvailable ? 'Every season is already available.' : 'Every season is already available or requested.',
      };
    }
    if (status === SeerrMediaStatus.AVAILABLE) return { ...common, canRequest: false, reason: 'already_available', message: 'This show is already available.' };
  }
  if (user.seerrPermissions != null && !perms.request) {
    return { ...common, canRequest: false, reason: 'no_permission', message: 'Your Seerr account does not have permission to request this.' };
  }
  return { ...common, canRequest: true, reason: null, message: null };
}

export interface SubmitResult {
  ok: boolean;
  requestId: number | null;
  state: RequestState;
  message: string;
}

export async function submitRequest(
  ctx: AppContext,
  user: { id: number; seerrUserId: number | null; seerrPermissions?: number | null },
  titleId: number,
  opts: { seasons?: number[] | 'all'; is4k?: boolean },
): Promise<SubmitResult> {
  const key = `${titleId}`;
  if (inflight.has(key)) throw new ApiError(409, 'request_in_progress', 'A request for this title is already being submitted.');
  inflight.add(key);
  try {
    const elig = await checkEligibility(ctx, user, titleId);
    if (!elig.canRequest) {
      if (elig.reason === 'already_requested' || elig.reason === 'already_available') void syncTitleFromSeerr(ctx, titleId, elig.details);
      throw new ApiError(409, elig.reason ?? 'not_eligible', elig.message ?? 'This title cannot be requested.');
    }
    const title = ctx.titles.get(titleId)!;
    let seasons = opts.seasons;
    if (title.media_type === 'tv') {
      const requestable = elig.seasons.filter((s) => s.requestable).map((s) => s.seasonNumber);
      if (Array.isArray(seasons)) {
        seasons = seasons.filter((s) => requestable.includes(s));
        if (seasons.length === 0) throw new ApiError(400, 'no_seasons', 'Choose at least one season that has not been requested yet.');
      } else if (requestable.length > 0 && elig.seasons.length > requestable.length) {
        // Request only what is missing rather than "all".
        seasons = requestable;
      } else seasons = 'all';
    }
    const seerr = ctx.integrations.seerr()!;
    const res = await seerr.createRequest(
      { mediaType: title.media_type, tmdbId: title.tmdb_id!, tvdbId: title.tvdb_id, seasons, is4k: opts.is4k ?? false },
      user.seerrUserId,
    );
    if (!res.ok) {
      ctx.log.info({ titleId, code: res.code }, 'seerr request rejected');
      if (res.code === 'duplicate') void syncTitleFromSeerr(ctx, titleId);
      const status = res.code === 'forbidden' ? 403 : res.code === 'duplicate' ? 409 : res.code === 'no_seasons' ? 409 : 502;
      throw new ApiError(status, `seerr_${res.code}`, res.message);
    }
    upsertRequest(ctx, res.request, 'jellywatcher', user.id);
    const row = ctx.db.prepare('SELECT id FROM requests WHERE seerr_request_id = ?').get(res.request.id) as { id: number };
    ctx.db.prepare("UPDATE requests SET origin = 'jellywatcher', user_id = ? WHERE id = ?").run(user.id, row.id);
    const state = mapSeerrRequest(res.request.status, res.request.media?.status ?? null);
    ctx.activity.add(user.id, 'request_submitted', `You requested ${title.title}.`, titleId);
    const message =
      state === 'pending_approval'
        ? 'Request submitted. It needs approval in Seerr before it is processed.'
        : state === 'approved' || state === 'processing'
          ? 'Request approved and sent for processing.'
          : 'Request submitted.';
    return { ok: true, requestId: row.id, state, message };
  } finally {
    inflight.delete(key);
  }
}

/** Refreshes Seerr's view of one title (after a duplicate or when the detail page opens). */
export async function syncTitleFromSeerr(ctx: AppContext, titleId: number, details?: SeerrDetails): Promise<void> {
  const title = ctx.titles.get(titleId);
  const seerr = ctx.integrations.seerr();
  if (!title?.tmdb_id || !seerr) return;
  try {
    const d = details ?? (await seerr.details(title.media_type, title.tmdb_id));
    const m = d.mediaInfo;
    const now = nowIso();
    if (m?.status) {
      ctx.db
        .prepare(
          `INSERT INTO seerr_media (media_type, tmdb_id, seerr_media_id, status, status4k, seasons, jellyfin_item_id, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(media_type, tmdb_id) DO UPDATE SET status = excluded.status, status4k = excluded.status4k, seasons = excluded.seasons, synced_at = excluded.synced_at`,
        )
        .run(title.media_type, title.tmdb_id, m.id ?? null, m.status, m.status4k ?? null, JSON.stringify(m.seasons ?? []), m.jellyfinMediaId ?? null, now);
    } else {
      ctx.db.prepare('DELETE FROM seerr_media WHERE media_type = ? AND tmdb_id = ?').run(title.media_type, title.tmdb_id);
    }
    for (const raw of (m?.requests ?? []) as { id?: number }[]) {
      if (typeof raw.id !== 'number') continue;
      const full = await seerr.request(raw.id);
      if (full) upsertRequest(ctx, full, 'seerr');
    }
  } catch (err) {
    ctx.log.debug({ err: (err as Error).message }, 'title seerr refresh failed');
  }
}
