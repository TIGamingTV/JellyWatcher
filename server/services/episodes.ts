import type { AppContext } from '../context.js';
import { nowIso, parseJson } from '../db/index.js';
import { errorMessage } from '../http/errors.js';
import type { SessionUser } from '../security/auth.js';
import { ensureTitleMetadata } from '../sync/metadata.js';
import type { TitleStatus } from './status.js';
import type { TitleRow } from './titles.js';
import { epKey, loadSkips, manualDateFor, seasonSizes, skipCovers, type ManualMarks } from './watched.js';

/**
 * Episode guide of a show: every season (specials last) with each episode's name, air date,
 * runtime, and the person's watched and "Not Watching" state. Names and air dates come from TMDb
 * or Seerr and are kept in title_episodes; without a metadata source the guide falls back to the
 * season sizes and what Jellyfin has.
 */

const REFRESH_MS = 7 * 86400_000;
/** After a failed read, wait this long before asking the metadata source again. */
const RETRY_MS = 5 * 60_000;
const TICKS_PER_MINUTE = 600_000_000;

export interface GuideEpisode {
  episode: number;
  name: string | null;
  /** YYYY-MM-DD; null when unknown. */
  airDate: string | null;
  /** Out already (an unknown date counts as aired only without a guide). */
  aired: boolean;
  runtime: number | null;
  watched: boolean;
  source: 'manual' | 'jellyfin' | null;
  watchedAt: string | null;
  /** Covered by a "Not Watching" mark (the episode's own, its season's or the whole show's). */
  skipped: boolean;
  inLibrary: boolean;
  jellyfinItemId: string | null;
}

export interface GuideSeason {
  season: number;
  /** Year the season started airing. */
  year: number | null;
  episodes: number;
  watched: number;
  /** Unwatched episodes marked "Not Watching". */
  skipped: number;
  /** The whole season is marked "Not Watching". */
  seasonSkipped: boolean;
  /** Minutes of the episodes still counted (skipped ones left out); null when none is known. */
  runtime: number | null;
  watchedMinutes: number;
  /** Date of a manual mark covering the whole season. */
  manualAt: string | null;
  list: GuideEpisode[];
}

export interface EpisodeGuide {
  titleId: number;
  /** Where names and air dates come from; null without a guide (numbers only). */
  source: 'tmdb' | 'seerr' | null;
  /** The whole show is marked "Not Watching". */
  skipped: boolean;
  /** Regular seasons in order, then specials (season 0). */
  seasons: GuideSeason[];
}

interface GuideRow {
  season: number;
  episode: number;
  name: string | null;
  air_date: string | null;
  runtime: number | null;
}

const inflight = new Map<number, Promise<number>>();
const failedAt = new Map<number, number>();

/**
 * Reads the show's episode guide from the metadata source when there is none yet or it is older
 * than a week. A failed read keeps the old copy. Returns the title id (metadata can merge rows).
 */
export function ensureEpisodes(ctx: AppContext, titleId: number): Promise<number> {
  const running = inflight.get(titleId);
  if (running) return running;
  const p = refresh(ctx, titleId).finally(() => inflight.delete(titleId));
  inflight.set(titleId, p);
  return p;
}

async function refresh(ctx: AppContext, titleId: number): Promise<number> {
  const row = ctx.titles.get(titleId) as (TitleRow & { episodes_fetched_at: string | null }) | undefined;
  if (!row || row.media_type !== 'tv' || !row.tmdb_id) return titleId;
  if (row.episodes_fetched_at && Date.now() - Date.parse(row.episodes_fetched_at) < REFRESH_MS) return titleId;
  if (Date.now() - (failedAt.get(titleId) ?? 0) < RETRY_MS) return titleId;
  const meta = ctx.metadata();
  if (!meta) return titleId;
  const id = await ensureTitleMetadata(ctx, titleId);
  const t = ctx.titles.get(id);
  if (!t?.tmdb_id) return id;
  // Specials are not in the stored season sizes; ask for them too (a show without any has none).
  const seasons = [...new Set([...seasonSizes(t.seasons).keys(), 0])].sort((a, b) => a - b);
  try {
    const guide = await meta.seasonEpisodes(t.tmdb_id, seasons);
    const insert = ctx.db.prepare('INSERT OR REPLACE INTO title_episodes (title_id, season, episode, name, air_date, runtime) VALUES (?, ?, ?, ?, ?, ?)');
    ctx.db.transaction(() => {
      ctx.db.prepare('DELETE FROM title_episodes WHERE title_id = ?').run(id);
      for (const [season, eps] of guide) {
        for (const e of eps) {
          if (!Number.isInteger(e.episode) || e.episode < 1) continue;
          const air = e.airDate && /^\d{4}-\d{2}-\d{2}/.test(e.airDate) ? e.airDate.slice(0, 10) : null;
          insert.run(id, season, e.episode, e.name?.slice(0, 300) ?? null, air, e.runtime && e.runtime > 0 ? Math.round(e.runtime) : null);
        }
      }
      ctx.db.prepare('UPDATE titles SET episodes_fetched_at = ? WHERE id = ?').run(nowIso(), id);
    })();
    failedAt.delete(titleId);
  } catch (err) {
    failedAt.set(titleId, Date.now());
    ctx.log.debug({ err: errorMessage(err), titleId: id }, 'episode guide read failed');
  }
  return id;
}

/** Episodes per season in the stored guide (specials included): title → season → episodes. */
export function guideCounts(ctx: AppContext, titleIds: number[]): Map<number, Map<number, number>> {
  const out = new Map<number, Map<number, number>>();
  for (let i = 0; i < titleIds.length; i += 500) {
    const c = titleIds.slice(i, i + 500);
    const rows = ctx.db
      .prepare(`SELECT title_id, season, MAX(episode) AS n FROM title_episodes WHERE title_id IN (${c.map(() => '?').join(',')}) GROUP BY title_id, season`)
      .all(...c) as { title_id: number; season: number; n: number }[];
    for (const r of rows) {
      if (!out.has(r.title_id)) out.set(r.title_id, new Map());
      out.get(r.title_id)!.set(r.season, r.n);
    }
  }
  return out;
}

/** What the person has watched of a show, combining Jellyfin with their own marks. */
export interface EpisodeState {
  marks: ManualMarks;
  /** Episodes Jellyfin reported as played: key → played at. */
  jf: Map<string, string | null>;
  /** Episodes in the library: key → { Jellyfin item id, minutes }. */
  present: Map<string, { id: string; minutes: number | null }>;
  /** Jellyfin reports the whole show watched: every episode counts. */
  jfAll: boolean;
}

export function episodeState(ctx: AppContext, userId: number, t: TitleRow, status: TitleStatus): EpisodeState {
  const jf = new Map(
    (ctx.db.prepare('SELECT season, episode, played_at FROM watched_episodes WHERE user_id = ? AND title_id = ?').all(userId, t.id) as { season: number; episode: number; played_at: string | null }[]).map(
      (r) => [epKey(r.season, r.episode), r.played_at] as const,
    ),
  );
  const present = new Map(
    (
      ctx.db.prepare('SELECT je.id, je.season, je.episode, je.runtime_ticks FROM jellyfin_episodes je JOIN jellyfin_items ji ON ji.id = je.series_id WHERE ji.title_id = ?').all(t.id) as {
        id: string;
        season: number;
        episode: number;
        runtime_ticks: number | null;
      }[]
    ).map((r) => [epKey(r.season, r.episode), { id: r.id.split('#')[0]!, minutes: r.runtime_ticks && r.runtime_ticks > 0 ? Math.round(r.runtime_ticks / TICKS_PER_MINUTE) || null : null }] as const),
  );
  return {
    marks: ctx.watches.marks(userId, t.id),
    jf,
    present,
    jfAll: status.viewing.state === 'watched' && status.viewing.source === 'Jellyfin',
  };
}

/** Watched state of one episode. */
export function episodeWatched(st: EpisodeState, season: number, episode: number) {
  const k = epKey(season, episode);
  const manualAt = manualDateFor(st.marks, season, episode);
  const fromJf = st.jf.has(k) || st.jfAll;
  return { watched: Boolean(manualAt) || fromJf, source: manualAt ? ('manual' as const) : fromJf ? ('jellyfin' as const) : null, watchedAt: manualAt ?? st.jf.get(k) ?? null };
}

/** The highest episode number seen per season in Jellyfin, the person's marks and the given keys. */
export function knownEpisodes(st: EpisodeState): Map<number, number> {
  const known = new Map<number, number>();
  for (const k of [...st.jf.keys(), ...st.present.keys(), ...st.marks.episodes.keys()]) {
    const [s, e] = k.split(':').map(Number) as [number, number];
    known.set(s, Math.max(known.get(s) ?? 0, e));
  }
  return known;
}

export function episodeGuide(ctx: AppContext, u: SessionUser, t: TitleRow, status: TitleStatus): EpisodeGuide {
  const st = episodeState(ctx, u.id, t, status);
  const skips = loadSkips(ctx.db, u.id, [t.id]).get(t.id);
  const rows = ctx.db.prepare('SELECT season, episode, name, air_date, runtime FROM title_episodes WHERE title_id = ? ORDER BY season, episode').all(t.id) as GuideRow[];
  const guide = new Map<number, GuideRow[]>();
  for (const r of rows) guide.set(r.season, [...(guide.get(r.season) ?? []), r]);

  const sizes = seasonSizes(t.seasons);
  const seasonDates = new Map(parseJson<{ season: number; airDate?: string | null }[]>(t.seasons, []).map((s) => [s.season, s.airDate ?? null]));
  const known = knownEpisodes(st);
  const presentMinutes = [...st.present.entries()].filter(([k]) => !k.startsWith('0:')).map(([, v]) => v.minutes).filter((m): m is number => m !== null);
  const perEpisode = t.runtime ?? (presentMinutes.length ? Math.round(presentMinutes.reduce((a, b) => a + b, 0) / presentMinutes.length) : null);
  const today = new Date().toISOString().slice(0, 10);

  const numbers = new Set<number>([...sizes.keys(), ...guide.keys(), ...[...known.keys()].filter((s) => s > 0 || [...st.present.keys()].some((k) => k.startsWith(`${s}:`))), ...st.marks.seasons.keys()]);
  const seasons = [...numbers]
    .sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b))
    .map((s): GuideSeason => {
      const fromGuide = guide.get(s);
      const base: { episode: number; name: string | null; air_date: string | null; runtime: number | null; listed: boolean }[] = fromGuide
        ? fromGuide.map((r) => ({ ...r, listed: true }))
        : Array.from({ length: sizes.get(s) ?? known.get(s) ?? 0 }, (_, i) => ({ episode: i + 1, name: null, air_date: null, runtime: null, listed: false }));
      // Episodes the guide does not know yet but Jellyfin or a mark does (new or renumbered).
      const listedNumbers = new Set(base.map((b) => b.episode));
      for (let e = 1; e <= (known.get(s) ?? 0); e++) {
        const k = epKey(s, e);
        if (!listedNumbers.has(e) && (st.present.has(k) || st.jf.has(k) || st.marks.episodes.has(k))) base.push({ episode: e, name: null, air_date: null, runtime: null, listed: false });
      }
      base.sort((a, b) => a.episode - b.episode);
      const list = base.map((b): GuideEpisode => {
        const k = epKey(s, b.episode);
        const lib = st.present.get(k);
        const w = episodeWatched(st, s, b.episode);
        return {
          episode: b.episode,
          name: b.name,
          airDate: b.air_date,
          aired: w.watched || Boolean(lib) || (b.air_date ? b.air_date <= today : !b.listed),
          runtime: b.runtime ?? lib?.minutes ?? perEpisode,
          ...w,
          skipped: !w.watched && skipCovers(skips, s, b.episode),
          inLibrary: Boolean(lib),
          jellyfinItemId: lib?.id ?? null,
        };
      });
      const counted = list.filter((e) => !e.skipped);
      const minutes = counted.map((e) => e.runtime).filter((m): m is number => m !== null);
      const firstAir = seasonDates.get(s) ?? list.map((e) => e.airDate).filter((d): d is string => Boolean(d)).sort()[0] ?? null;
      return {
        season: s,
        year: firstAir && /^\d{4}/.test(firstAir) ? Number(firstAir.slice(0, 4)) : null,
        episodes: list.length,
        watched: list.filter((e) => e.watched).length,
        skipped: list.length - counted.length,
        seasonSkipped: skipCovers(skips, s, null),
        runtime: minutes.length ? minutes.reduce((a, b) => a + b, 0) : null,
        watchedMinutes: counted.filter((e) => e.watched).reduce((n, e) => n + (e.runtime ?? 0), 0),
        manualAt: st.marks.seasons.get(s) ?? st.marks.title,
        list,
      };
    })
    .filter((s) => s.episodes > 0 || s.season > 0);
  const source = rows.length > 0 && (t.metadata_source === 'tmdb' || t.metadata_source === 'seerr') ? t.metadata_source : null;
  return { titleId: t.id, source, skipped: Boolean(skips?.title), seasons };
}
