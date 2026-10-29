import { nowIso, parseJson, type DB } from '../db/index.js';
import { ApiError } from '../http/errors.js';

/**
 * Manual watch marks: titles, seasons and episodes a person marked as watched themselves, with the
 * date they watched them. Stored apart from the Jellyfin mirror (watch_history / watched_episodes)
 * so a library sync never overwrites or removes them. Marks only ever add "watched"; they cannot
 * hide progress that Jellyfin reports.
 */

export interface ManualMarks {
  /** Whole title marked watched (movie, or every episode of a show). */
  title: string | null;
  /** Whole seasons marked watched: season → watched at. */
  seasons: Map<number, string>;
  /** Single episodes marked watched: "season:episode" → watched at. */
  episodes: Map<string, string>;
}

export interface WatchScope {
  season?: number | null;
  episode?: number | null;
}

const TITLE = -1;
const WHOLE = -1;
export const epKey = (s: number, e: number) => `${s}:${e}`;

function inChunks<T>(ids: number[], fn: (chunk: number[], ph: string) => T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const c = ids.slice(i, i + 500);
    out.push(...fn(c, c.map(() => '?').join(',')));
  }
  return out;
}

const empty = (): ManualMarks => ({ title: null, seasons: new Map(), episodes: new Map() });

export function loadManualMarks(db: DB, userId: number, titleIds: number[]): Map<number, ManualMarks> {
  const out = new Map<number, ManualMarks>();
  if (titleIds.length === 0) return out;
  const rows = inChunks(titleIds, (c, ph) =>
    db.prepare(`SELECT title_id, season, episode, watched_at FROM manual_watches WHERE user_id = ? AND title_id IN (${ph})`).all(userId, ...c) as {
      title_id: number;
      season: number;
      episode: number;
      watched_at: string;
    }[],
  );
  for (const r of rows) {
    const m = out.get(r.title_id) ?? empty();
    if (r.season === TITLE) m.title = r.watched_at;
    else if (r.episode === WHOLE) m.seasons.set(r.season, r.watched_at);
    else m.episodes.set(epKey(r.season, r.episode), r.watched_at);
    out.set(r.title_id, m);
  }
  return out;
}

/** Regular-season sizes from the title's metadata: season → episodes (null when unknown). */
export function seasonSizes(seasonsJson: string | null | undefined): Map<number, number | null> {
  const list = parseJson<{ season: number; episodes: number | null }[]>(seasonsJson ?? null, []);
  return new Map(list.filter((s) => s.season > 0).map((s) => [s.season, s.episodes ?? null]));
}

/** Episode keys covered by manual marks. Season marks expand only when the season's size is known. */
export function manualEpisodeKeys(m: ManualMarks | undefined, sizes: Map<number, number | null>): Set<string> {
  const out = new Set<string>();
  if (!m) return out;
  const expand = (season: number) => {
    const n = sizes.get(season);
    if (n) for (let e = 1; e <= n; e++) out.add(epKey(season, e));
  };
  if (m.title) for (const s of sizes.keys()) expand(s);
  for (const s of m.seasons.keys()) expand(s);
  for (const k of m.episodes.keys()) out.add(k);
  return out;
}

/** Latest manual date covering an episode (episode mark, then season mark, then title mark). */
export function manualDateFor(m: ManualMarks | undefined, season: number | null, episode: number | null): string | null {
  if (!m) return null;
  if (season !== null && episode !== null) return m.episodes.get(epKey(season, episode)) ?? m.seasons.get(season) ?? m.title;
  if (season !== null) return m.seasons.get(season) ?? m.title;
  return m.title;
}

/** Validates a watch date: ISO date or date-time, not in the future, not before 1900. */
export function parseWatchedAt(input: string | null | undefined): string {
  if (!input) return nowIso();
  const s = input.trim();
  const t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T12:00:00Z`) : Date.parse(s);
  if (Number.isNaN(t)) throw new ApiError(400, 'invalid_date', 'Choose a valid date.');
  if (t > Date.now() + 36 * 3600_000) throw new ApiError(400, 'invalid_date', 'The watch date cannot be in the future.');
  if (t < Date.parse('1900-01-01T00:00:00Z')) throw new ApiError(400, 'invalid_date', 'Choose a date after 1900.');
  return new Date(Math.min(t, Date.now())).toISOString();
}

export class WatchService {
  constructor(private readonly db: DB) {}

  marks(userId: number, titleId: number): ManualMarks {
    return loadManualMarks(this.db, userId, [titleId]).get(titleId) ?? empty();
  }

  private sizes(titleId: number) {
    const row = this.db.prepare('SELECT media_type, seasons FROM titles WHERE id = ?').get(titleId) as { media_type: 'movie' | 'tv'; seasons: string | null } | undefined;
    if (!row) throw new ApiError(404, 'not_found', 'Title not found.');
    return { mediaType: row.media_type, sizes: seasonSizes(row.seasons) };
  }

  private normalize(titleId: number, scope: WatchScope) {
    const { mediaType, sizes } = this.sizes(titleId);
    const season = scope.season ?? null;
    const episode = season === null ? null : (scope.episode ?? null);
    if (mediaType === 'movie' && season !== null) throw new ApiError(400, 'invalid_scope', 'Movies have no seasons or episodes.');
    if (season !== null && season < 0) throw new ApiError(400, 'invalid_scope', 'Choose a season.');
    if (episode !== null && episode < 1) throw new ApiError(400, 'invalid_scope', 'Choose an episode.');
    return { season, episode, sizes };
  }

  /** Marks a title, a season or one episode as watched at the given time (replacing an earlier date). */
  mark(userId: number, titleId: number, scope: WatchScope, watchedAt: string): void {
    const { season, episode } = this.normalize(titleId, scope);
    const now = nowIso();
    const insert = this.db.prepare(
      `INSERT INTO manual_watches (user_id, title_id, season, episode, watched_at, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, title_id, season, episode) DO UPDATE SET watched_at = excluded.watched_at`,
    );
    this.db.transaction(() => {
      if (season === null) {
        // The whole title covers every narrower mark.
        this.db.prepare('DELETE FROM manual_watches WHERE user_id = ? AND title_id = ?').run(userId, titleId);
        insert.run(userId, titleId, TITLE, WHOLE, watchedAt, now);
      } else if (episode === null) {
        this.db.prepare('DELETE FROM manual_watches WHERE user_id = ? AND title_id = ? AND season = ? AND episode != ?').run(userId, titleId, season, WHOLE);
        insert.run(userId, titleId, season, WHOLE, watchedAt, now);
      } else insert.run(userId, titleId, season, episode, watchedAt, now);
    })();
  }

  /**
   * Removes the manual mark covering a scope. Unmarking part of a wider mark (one episode of a
   * season marked as a whole) keeps the rest marked by splitting the wider mark where sizes are known.
   */
  unmark(userId: number, titleId: number, scope: WatchScope): void {
    const { season, episode, sizes } = this.normalize(titleId, scope);
    const m = this.marks(userId, titleId);
    const now = nowIso();
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO manual_watches (user_id, title_id, season, episode, watched_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const del = this.db.prepare('DELETE FROM manual_watches WHERE user_id = ? AND title_id = ? AND season = ? AND episode = ?');
    this.db.transaction(() => {
      if (season === null) {
        this.db.prepare('DELETE FROM manual_watches WHERE user_id = ? AND title_id = ?').run(userId, titleId);
        return;
      }
      if (m.title) {
        for (const s of sizes.keys()) if (s !== season) insert.run(userId, titleId, s, WHOLE, m.title, now);
        if (episode !== null) insert.run(userId, titleId, season, WHOLE, m.title, now);
        del.run(userId, titleId, TITLE, WHOLE);
      }
      if (episode === null) {
        this.db.prepare('DELETE FROM manual_watches WHERE user_id = ? AND title_id = ? AND season = ?').run(userId, titleId, season);
        return;
      }
      const seasonAt = m.seasons.get(season) ?? m.title;
      if (seasonAt) {
        const n = sizes.get(season);
        if (n) for (let e = 1; e <= n; e++) if (e !== episode) insert.run(userId, titleId, season, e, seasonAt, now);
        del.run(userId, titleId, season, WHOLE);
      }
      del.run(userId, titleId, season, episode);
    })();
  }

  /** Marks several episodes at once (e.g. "everything up to here"). */
  markEpisodes(userId: number, titleId: number, episodes: { season: number; episode: number }[], watchedAt: string): void {
    this.db.transaction(() => {
      for (const e of episodes) this.mark(userId, titleId, e, watchedAt);
    })();
  }
}
