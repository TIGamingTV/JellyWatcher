import type { AppContext } from '../context.js';
import { parseJson } from '../db/index.js';
import type { RadarrMovie } from '../providers/radarr.js';
import { sonarrSeasons, type SonarrSeason, type SonarrSeries } from '../providers/sonarr.js';
import { epKey, loadManualMarks, loadSkips, seasonSizes, type ManualMarks, type SkipMarks } from '../services/watched.js';
import type { JanitorUnit } from '../../shared/janitor.js';
import type { PersonProgress } from './policy.js';
import { JanitorStore } from './store.js';

/**
 * Turns Seerr requests into units the Janitor can clean up (a movie, one season, or a whole show)
 * and reads what each person has watched of them. Only titles requested through Seerr are ever
 * considered. Seasons the Janitor added to a request (next-season option) count as requested by it.
 */

/** Sonarr and Radarr as read at the start of a run; null when not connected or unreachable. */
export interface ArrSnapshot {
  sonarr: { byTvdb: Map<number, SonarrSeries>; byTmdb: Map<number, SonarrSeries> } | null;
  radarr: Map<number, RadarrMovie> | null;
  errors: string[];
}

export function arrIndex(series: SonarrSeries[] | null, movies: RadarrMovie[] | null, errors: string[] = []): ArrSnapshot {
  return {
    sonarr: series
      ? {
          byTvdb: new Map(series.filter((s) => s.tvdbId).map((s) => [s.tvdbId!, s])),
          byTmdb: new Map(series.filter((s) => s.tmdbId).map((s) => [s.tmdbId!, s])),
        }
      : null,
    radarr: movies ? new Map(movies.filter((m) => m.tmdbId).map((m) => [m.tmdbId!, m])) : null,
    errors,
  };
}

export function findSeries(arr: ArrSnapshot, t: { tvdb_id: number | null; tmdb_id: number | null }): SonarrSeries | null {
  if (!arr.sonarr) return null;
  return (t.tvdb_id ? arr.sonarr.byTvdb.get(t.tvdb_id) : undefined) ?? (t.tmdb_id ? arr.sonarr.byTmdb.get(t.tmdb_id) : undefined) ?? null;
}

export interface UnitRequest {
  id: number;
  seerrRequestId: number;
  userId: number | null;
  requestedBy: string | null;
  is4k: boolean;
  /** Requested seasons plus those the Janitor added; empty: every season. */
  seasons: number[];
  /** Of `seasons`, the ones the Janitor added. */
  addedSeasons: number[];
  createdAt: string;
}

export interface Unit {
  titleId: number;
  title: string;
  mediaType: 'movie' | 'tv';
  kind: JanitorUnit;
  /** -1 for a movie or a whole show. */
  season: number;
  tmdbId: number | null;
  tvdbId: number | null;
  requests: UnitRequest[];
  /** Episodes in Jellyfin that have to be watched ("season:episode"); empty for movies. */
  episodes: string[];
  /** Episodes the unit has, aired or not (Sonarr, TMDb or Jellyfin, whichever knows most); 0 for movies. */
  episodeCount: number;
  /** Season units: the season after this one in Sonarr; null when there is none (or no Sonarr data). */
  next: { season: number; monitored: boolean } | null;
  /** Shows: seasons any active request of the title covers (added ones included); null: every season. */
  requestedSeasons: Set<number> | null;
  inLibrary: boolean;
  /** Everything that aired is downloaded; otherwise `incomplete` says why. */
  incomplete: string | null;
  sizeBytes: number | null;
  seriesStatus: string | null;
  sonarrId: number | null;
  radarrId: number | null;
}

interface TitleRowLite {
  id: number;
  media_type: 'movie' | 'tv';
  title: string;
  tmdb_id: number | null;
  tvdb_id: number | null;
  seasons: string | null;
}

/** Approved or completed requests that still exist in Seerr, grouped by title. */
function activeRequests(ctx: AppContext): Map<number, UnitRequest[]> {
  const rows = ctx.db
    .prepare(
      `SELECT id, title_id, user_id, seerr_request_id, requested_by, is4k, seasons, created_at FROM requests
        WHERE seerr_request_id IS NOT NULL AND request_status IN (2, 5) ORDER BY created_at`,
    )
    .all() as { id: number; title_id: number; user_id: number | null; seerr_request_id: number; requested_by: string | null; is4k: number; seasons: string | null; created_at: string }[];
  const added = new JanitorStore(ctx.db).addedSeasons();
  const out = new Map<number, UnitRequest[]>();
  for (const r of rows) {
    const list = out.get(r.title_id) ?? [];
    const seasons = parseJson<number[]>(r.seasons, []);
    // A request for every season needs nothing added.
    const extra = seasons.length ? (added.get(r.id) ?? []).filter((s) => !seasons.includes(s)) : [];
    list.push({ id: r.id, seerrRequestId: r.seerr_request_id, userId: r.user_id, requestedBy: r.requested_by, is4k: r.is4k === 1, seasons: [...seasons, ...extra].sort((a, b) => a - b), addedSeasons: extra, createdAt: r.created_at });
    out.set(r.title_id, list);
  }
  return out;
}

const seasonComplete = (s: SonarrSeason | undefined): string | null => {
  if (!s) return null;
  if (s.nextAiring) return 'More episodes of this season are still to air.';
  if (s.files === 0) return null;
  if (s.files < s.episodes) return `Only ${s.files} of ${s.episodes} episodes are downloaded.`;
  return null;
};

export function buildUnits(ctx: AppContext, kind: JanitorUnit, arr: ArrSnapshot): Unit[] {
  const byTitle = activeRequests(ctx);
  if (byTitle.size === 0) return [];
  const titleIds = [...byTitle.keys()];
  const titles = new Map<number, TitleRowLite>();
  for (let i = 0; i < titleIds.length; i += 500) {
    const c = titleIds.slice(i, i + 500);
    for (const t of ctx.db.prepare(`SELECT id, media_type, title, tmdb_id, tvdb_id, seasons FROM titles WHERE id IN (${c.map(() => '?').join(',')})`).all(...c) as TitleRowLite[]) titles.set(t.id, t);
  }
  const inJellyfin = ctx.db.prepare('SELECT 1 FROM jellyfin_items WHERE title_id = ? LIMIT 1');
  const episodesOf = ctx.db.prepare('SELECT DISTINCT je.season, je.episode FROM jellyfin_episodes je JOIN jellyfin_items ji ON ji.id = je.series_id WHERE ji.title_id = ? AND je.season > 0');

  const units: Unit[] = [];
  for (const [titleId, requests] of byTitle) {
    const t = titles.get(titleId);
    if (!t) continue;
    const wantMovie = kind === 'movie';
    if (wantMovie !== (t.media_type === 'movie')) continue;
    const base = { titleId, title: t.title, mediaType: t.media_type, kind, tmdbId: t.tmdb_id, tvdbId: t.tvdb_id };

    if (t.media_type === 'movie') {
      const movie = t.tmdb_id ? (arr.radarr?.get(t.tmdb_id) ?? null) : null;
      const inLib = Boolean(inJellyfin.get(titleId));
      units.push({
        ...base,
        season: -1,
        requests,
        episodes: [],
        episodeCount: 0,
        next: null,
        requestedSeasons: null,
        inLibrary: inLib,
        incomplete: null,
        sizeBytes: movie?.sizeOnDisk ?? null,
        seriesStatus: null,
        sonarrId: null,
        radarrId: movie?.id ?? null,
      });
      continue;
    }

    const series = findSeries(arr, t);
    const sSeasons = new Map((series ? sonarrSeasons(series) : []).map((s) => [s.season, s]));
    const eps = (episodesOf.all(titleId) as { season: number; episode: number }[]).map((e) => [e.season, e.episode] as const);
    const sizes = seasonSizes(t.seasons);
    const requestedSeasons = requests.some((r) => r.seasons.length === 0) ? null : new Set(requests.flatMap((r) => r.seasons));
    const common = { seriesStatus: series?.status ?? null, sonarrId: series?.id ?? null, radarrId: null, requestedSeasons };
    const countOf = (season: number) => Math.max(sSeasons.get(season)?.total ?? 0, sizes.get(season) ?? 0, eps.filter(([s]) => s === season).length);

    if (kind === 'series') {
      const incomplete =
        [...sSeasons.values()].filter((s) => s.season > 0).map(seasonComplete).find((x) => x !== null) ??
        (series ? null : [...sizes].filter(([, n]) => n !== null).some(([s, n]) => eps.filter(([es]) => es === s).length < n!) ? 'Not every episode is in Jellyfin yet.' : null);
      units.push({
        ...base,
        ...common,
        season: -1,
        requests,
        episodes: eps.map(([s, e]) => epKey(s, e)),
        episodeCount: [...new Set([...sSeasons.keys(), ...sizes.keys(), ...eps.map(([s]) => s)])].filter((s) => s > 0).reduce((n, s) => n + countOf(s), 0),
        next: null,
        inLibrary: eps.length > 0,
        incomplete,
        sizeBytes: series?.statistics?.sizeOnDisk ?? null,
      });
      continue;
    }

    // By season: every season someone requested (a request without seasons covers every season in the library).
    const seasons = new Set<number>();
    for (const r of requests) for (const s of r.seasons.length ? r.seasons : eps.map(([es]) => es)) if (s > 0) seasons.add(s);
    for (const season of [...seasons].sort((a, b) => a - b)) {
      const inSeason = eps.filter(([s]) => s === season).map(([s, e]) => epKey(s, e));
      const sonarr = sSeasons.get(season);
      const size = sizes.get(season) ?? null;
      const incomplete = sonarr ? seasonComplete(sonarr) : size !== null && inSeason.length < size ? `Only ${inSeason.length} of ${size} episodes are in Jellyfin.` : null;
      const next = [...sSeasons.values()].filter((s) => s.season > season).sort((a, b) => a.season - b.season)[0];
      units.push({
        ...base,
        ...common,
        season,
        requests: requests.filter((r) => r.seasons.length === 0 || r.seasons.includes(season)),
        episodes: inSeason,
        episodeCount: countOf(season),
        next: next ? { season: next.season, monitored: next.monitored } : null,
        inLibrary: inSeason.length > 0,
        incomplete,
        sizeBytes: sonarr?.sizeOnDisk ?? null,
      });
    }
  }
  return units;
}

export interface PersonInfo {
  id: number;
  name: string;
}

/** People whose viewing JellyWatcher knows: active accounts with a linked Jellyfin user. */
export function linkedPeople(ctx: AppContext): PersonInfo[] {
  return ctx.db.prepare('SELECT id, display_name AS name FROM users WHERE disabled = 0 AND jellyfin_user_id IS NOT NULL ORDER BY id').all() as PersonInfo[];
}

export function personName(ctx: AppContext, userId: number): string | null {
  return (ctx.db.prepare('SELECT display_name AS name FROM users WHERE id = ? AND disabled = 0').get(userId) as { name: string } | undefined)?.name ?? null;
}

/** What one person has watched of a unit, from Jellyfin, their own marks and "Not Watching". */
export function progressFor(ctx: AppContext, person: PersonInfo, unit: Unit): PersonProgress {
  const db = ctx.db;
  const marks = loadManualMarks(db, person.id, [unit.titleId]).get(unit.titleId);
  const skips = loadSkips(db, person.id, [unit.titleId]).get(unit.titleId);
  const history = db.prepare('SELECT state, last_played_at, updated_at FROM watch_history WHERE user_id = ? AND title_id = ?').get(person.id, unit.titleId) as
    | { state: string; last_played_at: string | null; updated_at: string }
    | undefined;
  const watchlisted = Boolean(db.prepare('SELECT 1 FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.user_id = ? AND li.title_id = ? LIMIT 1').get(person.id, unit.titleId));
  const skipAt = (db.prepare('SELECT MAX(created_at) AS at FROM skipped_entries WHERE user_id = ? AND title_id = ?').get(person.id, unit.titleId) as { at: string | null }).at;

  if (unit.mediaType === 'movie') {
    const watchedAt = marks?.title ?? (history?.state === 'watched' ? (history.last_played_at ?? history.updated_at) : null);
    const skipped = skips?.title ?? false;
    const done = Boolean(watchedAt) || skipped;
    return {
      userId: person.id,
      name: person.name,
      done,
      doneAt: watchedAt ?? (skipped ? skipAt : null),
      started: done || Boolean(history),
      lastActivity: history?.last_played_at ?? watchedAt ?? null,
      watchlisted,
    };
  }

  const played = new Map(
    (db.prepare('SELECT season, episode, played_at FROM watched_episodes WHERE user_id = ? AND title_id = ?').all(person.id, unit.titleId) as { season: number; episode: number; played_at: string | null }[]).map(
      (r) => [epKey(r.season, r.episode), r.played_at] as const,
    ),
  );
  const showWatched = history?.state === 'watched' ? (history.last_played_at ?? history.updated_at) : null;
  let all = unit.episodes.length > 0;
  let latest: string | null = null;
  let any = false;
  const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : Date.parse(a) >= Date.parse(b) ? a : b);
  for (const k of unit.episodes) {
    const [s, e] = k.split(':').map(Number) as [number, number];
    const manual = marks ? (marks.episodes.get(k) ?? marks.seasons.get(s) ?? marks.title) : null;
    const jf = played.has(k) ? (played.get(k) ?? showWatched ?? null) : null;
    const skipped = Boolean(skips && (skips.title || skips.seasons.has(s) || skips.episodes.has(epKey(s, e))));
    const covered = Boolean(manual) || played.has(k) || Boolean(showWatched) || skipped;
    if (!covered) {
      all = false;
      continue;
    }
    if (manual || played.has(k) || showWatched) any = true;
    latest = later(latest, manual ?? jf ?? showWatched ?? (skipped ? skipAt : null));
  }
  const lastPlayed = [...played.values()].reduce<string | null>((a, b) => later(a, b), history?.last_played_at ?? null);
  return {
    userId: person.id,
    name: person.name,
    done: all,
    doneAt: all ? latest : null,
    started: any || played.size > 0 || Boolean(history),
    lastActivity: lastPlayed,
    watchlisted,
    ...episodesLeft(unit, played, marks, skips, Boolean(showWatched)),
  };
}

/**
 * How far one person is through a show unit: episodes they watched (played or marked) and how many
 * are still to go, counting episodes not downloaded yet. Episodes marked "Not Watching" are not left
 * to watch. `left` is null when they are not watching the show at all.
 */
function episodesLeft(
  unit: Unit,
  played: Map<string, string | null>,
  marks: ManualMarks | undefined,
  skips: SkipMarks | undefined,
  showWatched: boolean,
): { watched: number; left: number | null } {
  if (skips?.title) return { watched: 0, left: null };
  const inUnit = (s: number) => (unit.season >= 0 ? s === unit.season : s > 0);
  const whole = (s: number) => showWatched || Boolean(marks?.title) || Boolean(marks?.seasons.has(s));
  if (unit.season >= 0 && whole(unit.season)) return { watched: unit.episodeCount, left: 0 };
  const keys = new Set(unit.episodes);
  for (const k of [...played.keys(), ...(marks?.episodes.keys() ?? [])]) if (inUnit(Number(k.split(':')[0]))) keys.add(k);
  let watched = 0;
  let covered = 0;
  for (const k of keys) {
    const [s, e] = k.split(':').map(Number) as [number, number];
    if (played.has(k) || whole(s) || marks?.episodes.has(k)) {
      watched++;
      covered++;
    } else if (skips && (skips.seasons.has(s) || skips.episodes.has(epKey(s, e)))) covered++;
  }
  return { watched, left: Math.max(0, Math.max(unit.episodeCount, keys.size) - covered) };
}
