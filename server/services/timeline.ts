import type { AppContext } from '../context.js';
import { parseJson } from '../db/index.js';
import type { SessionUser } from '../security/auth.js';
import { lifecycleStage, type AvailabilityState, type LifecycleStage } from '../../shared/status.js';
import { card, cardRows, userCtx, type Card, type CardRow } from './cards.js';
import { ITEM_ORDER, type ListRow } from './lists.js';
import type { TitleStatus } from './status.js';
import { guideCounts } from './episodes.js';
import { loadManualMarks, loadSkips, manualDateFor, manualEpisodeKeys, seasonSizes, skipCovers, type ManualMarks, type SkipMarks } from './watched.js';

/**
 * Ordered view of a list: every entry in list order (movies, whole shows, single seasons, single
 * episodes), each with its size, watch time and progress, plus totals for the whole list. Used for
 * timeline lists and for "Up Next" on the home screen.
 */

export type EntryKind = 'movie' | 'show' | 'season' | 'episode';
export type EntryState = 'watched' | 'in_progress' | 'unwatched';

export interface TimelineEntry {
  itemId: number;
  /** 1-based place in the list. */
  position: number;
  kind: EntryKind;
  matched: boolean;
  title: Card | null;
  sourceTitle: string;
  year: number | null;
  season: number | null;
  episode: number | null;
  episodeTitle: string | null;
  /** Episodes this entry covers (shows, seasons, episodes); null when unknown. */
  episodes: number | null;
  /** Seasons of a whole-show entry. */
  seasons: number | null;
  watchedEpisodes: number | null;
  /** Total minutes for the entry, null when no runtime is known. */
  runtime: number | null;
  watchedMinutes: number;
  state: EntryState;
  /** Watched share of the entry, 0–100. */
  percent: number;
  availability: AvailabilityState;
  stage: LifecycleStage;
  sourceUrl: string | null;
  /** When the person marked this entry (or what contains it) as watched; null without a manual mark. */
  manualAt: string | null;
  /** When it was watched, if known. */
  watchedAt: string | null;
  /** The person marked it "Not Watching" (and has not watched it): Up Next passes over it. */
  skipped: boolean;
  /** The Jellyfin item to open for this entry (the episode for episode entries), when in the library. */
  jellyfinItemId: string | null;
  /**
   * A whole-show entry that heads parts of the same show listed after it (e.g. an IMDb list with
   * "Breaking Bad" followed by its episodes). It stands for those parts rather than the whole show:
   * no size or watch time of its own, never Up Next, and not mirrored to Jellyfin.
   */
  header: boolean;
  /** For headers: how many entries of the show follow it in the list; null otherwise. */
  parts: number | null;
  /**
   * Shows and seasons: unwatched episodes in it marked "Not Watching". They are left out of the
   * entry's progress and watch time (`episodes` still counts them). Null for other entries.
   */
  skippedEpisodes: number | null;
}

export interface TimelineSummary {
  /** Entries to watch (headers are not counted). */
  entries: number;
  /** Show entries that only head their parts listed below them. */
  headers: number;
  films: number;
  shows: number;
  seasons: number;
  episodes: number;
  totalMinutes: number;
  watchedMinutes: number;
  remainingMinutes: number;
  watchedEntries: number;
  /** Entries marked "Not Watching"; their watch time is left out of the totals. */
  skippedEntries: number;
  /** Entries without a known runtime (not counted in the totals). */
  unknownRuntime: number;
  unmatched: number;
}

export interface Timeline {
  entries: TimelineEntry[];
  summary: TimelineSummary;
  /** Index into entries of the first matched entry that is not watched yet. */
  nextIndex: number | null;
}

interface ItemRow {
  id: number;
  list_id: number;
  title_id: number | null;
  media_type: 'movie' | 'tv' | null;
  source_title: string;
  source_year: number | null;
  source_url: string | null;
  match_status: string;
  season_number: number | null;
  episode_number: number | null;
  episode_title: string | null;
  source_runtime: number | null;
  source_episodes: number | null;
  source_seasons: number | null;
}

const TICKS_PER_MINUTE = 600_000_000;
const toMinutes = (ticks: number | null | undefined) => (ticks && ticks > 0 ? Math.round(ticks / TICKS_PER_MINUTE) : null);
const key = (s: number, e: number) => `${s}:${e}`;

function inChunks<T>(ids: number[], fn: (chunk: number[], ph: string) => T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const c = ids.slice(i, i + 500);
    out.push(...fn(c, c.map(() => '?').join(',')));
  }
  return out;
}

export function buildTimelines(ctx: AppContext, user: SessionUser, lists: Pick<ListRow, 'id'>[]): Map<number, Timeline> {
  const out = new Map<number, Timeline>();
  if (lists.length === 0) return out;
  const listIds = lists.map((l) => l.id);
  const items = inChunks(listIds, (c, ph) =>
    ctx.db
      .prepare(
        `SELECT id, list_id, title_id, media_type, source_title, source_year, source_url, match_status, season_number, episode_number, episode_title,
                source_runtime, source_episodes, source_seasons
           FROM list_items WHERE list_id IN (${ph}) AND match_status != 'ignored'
          ORDER BY list_id, ${ITEM_ORDER}`,
      )
      .all(...c) as ItemRow[],
  );

  const titleIds = [...new Set(items.filter((i) => i.match_status === 'matched' && i.title_id !== null).map((i) => i.title_id!))];
  const statuses = ctx.status.forTitles(userCtx(user), titleIds);
  const rows = new Map<number, CardRow>(cardRows(ctx, titleIds).map((r) => [r.id, r]));
  const cards = new Map<number, Card>([...rows.values()].map((r) => [r.id, card(r, statuses.get(r.id))]));

  const jfRuntime = new Map<number, number | null>();
  for (const r of inChunks(titleIds, (c, ph) =>
    ctx.db.prepare(`SELECT title_id, MAX(runtime_ticks) AS rt FROM jellyfin_items WHERE title_id IN (${ph}) GROUP BY title_id`).all(...c) as { title_id: number; rt: number | null }[],
  )) {
    jfRuntime.set(r.title_id, toMinutes(r.rt));
  }

  const tvIds = titleIds.filter((id) => rows.get(id)?.media_type === 'tv');
  const marks = loadManualMarks(ctx.db, user.id, titleIds);
  const skips = loadSkips(ctx.db, user.id, titleIds);
  const watched = new Map<number, Set<string>>();
  for (const r of inChunks(tvIds, (c, ph) =>
    ctx.db.prepare(`SELECT title_id, season, episode FROM watched_episodes WHERE user_id = ? AND title_id IN (${ph})`).all(user.id, ...c) as { title_id: number; season: number; episode: number }[],
  )) {
    if (!watched.has(r.title_id)) watched.set(r.title_id, new Set());
    watched.get(r.title_id)!.add(key(r.season, r.episode));
  }
  for (const id of tvIds) {
    const m = marks.get(id);
    if (!m) continue;
    const set = watched.get(id) ?? new Set<string>();
    for (const k of manualEpisodeKeys(m, seasonSizes(rows.get(id)!.seasons))) set.add(k);
    watched.set(id, set);
  }
  const present = new Map<number, Map<string, number | null>>();
  const episodeIds = new Map<number, Map<string, string>>();
  for (const r of inChunks(tvIds, (c, ph) =>
    ctx.db
      .prepare(`SELECT ji.title_id, je.id, je.season, je.episode, je.runtime_ticks FROM jellyfin_episodes je JOIN jellyfin_items ji ON ji.id = je.series_id WHERE ji.title_id IN (${ph})`)
      .all(...c) as { title_id: number; id: string; season: number; episode: number; runtime_ticks: number | null }[],
  )) {
    if (!present.has(r.title_id)) present.set(r.title_id, new Map());
    present.get(r.title_id)!.set(key(r.season, r.episode), toMinutes(r.runtime_ticks));
    if (!episodeIds.has(r.title_id)) episodeIds.set(r.title_id, new Map());
    episodeIds.get(r.title_id)!.set(key(r.season, r.episode), r.id);
  }

  const guide = guideCounts(ctx, tvIds);

  const byList = new Map<number, ItemRow[]>();
  for (const i of items) byList.set(i.list_id, [...(byList.get(i.list_id) ?? []), i]);

  for (const listId of listIds) {
    const entries = markHeaders(
      (byList.get(listId) ?? []).map((i, idx) =>
        entryFor(i, idx + 1, {
        row: i.title_id !== null ? rows.get(i.title_id) : undefined,
        card: i.title_id !== null ? cards.get(i.title_id) : undefined,
        status: i.title_id !== null ? statuses.get(i.title_id) : undefined,
        jfRuntime: i.title_id !== null ? (jfRuntime.get(i.title_id) ?? null) : null,
        watched: (i.title_id !== null && watched.get(i.title_id)) || new Set<string>(),
        present: i.title_id !== null ? present.get(i.title_id) : undefined,
        marks: i.title_id !== null ? marks.get(i.title_id) : undefined,
        skips: i.title_id !== null ? skips.get(i.title_id) : undefined,
        episodeIds: i.title_id !== null ? episodeIds.get(i.title_id) : undefined,
        guide: i.title_id !== null ? guide.get(i.title_id) : undefined,
        }),
      ),
    );
    out.set(listId, { entries, summary: summarize(entries), nextIndex: nextIndex(entries) });
  }
  return out;
}

interface EntryContext {
  row: CardRow | undefined;
  card: Card | undefined;
  status: TitleStatus | undefined;
  jfRuntime: number | null;
  watched: Set<string>;
  /** Episodes in the library (season:episode → minutes); undefined when not indexed. */
  present: Map<string, number | null> | undefined;
  /** The person's own watch marks for this title. */
  marks: ManualMarks | undefined;
  /** What of this title the person is not watching. */
  skips: SkipMarks | undefined;
  /** Jellyfin ids of the title's episodes in the library (season:episode → item id). */
  episodeIds: Map<string, string> | undefined;
  /** Episodes per season in the episode guide (specials included). */
  guide?: Map<number, number> | undefined;
}

function entryFor(i: ItemRow, position: number, c: EntryContext): TimelineEntry {
  const e = baseEntryFor(i, position, c);
  // Watched wins over "Not Watching". A show or season whose every episode is skipped is skipped.
  const allSkipped = e.skippedEpisodes !== null && e.skippedEpisodes > 0 && e.episodes !== null && e.skippedEpisodes >= e.episodes;
  const skipped = e.matched && e.state !== 'watched' && (allSkipped || skipCovers(c.skips, i.season_number, i.season_number !== null ? i.episode_number : null));
  let jellyfinItemId: string | null = null;
  if (e.matched && e.availability !== 'not_in_library') {
    // Multi-episode files are stored once per episode as "<id>#<n>".
    const episodeId = e.kind === 'episode' ? c.episodeIds?.get(key(i.season_number!, i.episode_number!))?.split('#')[0] : undefined;
    jellyfinItemId = episodeId ?? c.status?.jellyfinItemId ?? null;
  }
  return { ...e, skipped, jellyfinItemId, header: false, parts: null };
}

/**
 * Turns whole-show entries into headers when seasons or episodes of the same show follow them in
 * the list. Such lists use the show as a section title; counting it as the whole show would double
 * the watch time and hold Up Next on it until every episode is watched. A show entry with no parts
 * after it still stands for the whole show, and so does one followed only by its specials.
 */
export function markHeaders(entries: TimelineEntry[]): TimelineEntry[] {
  const later = new Map<number, TimelineEntry[]>();
  const out = [...entries];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    const id = e.matched ? e.title?.id : undefined;
    if (id === undefined) continue;
    // Specials added after a show are extras to it, not parts it heads.
    if ((e.kind === 'season' || e.kind === 'episode') && e.season !== 0) later.set(id, [...(later.get(id) ?? []), e]);
    else if (e.kind === 'show' && later.has(id)) out[i] = asHeader(e, later.get(id)!);
  }
  return out;
}

function asHeader(e: TimelineEntry, parts: TimelineEntry[]): TimelineEntry {
  const counted = parts.filter((p) => !p.skipped);
  const watched = counted.filter((p) => p.state === 'watched').length;
  const started = watched > 0 || counted.some((p) => p.state === 'in_progress');
  const state: EntryState = counted.length > 0 && watched === counted.length ? 'watched' : started ? 'in_progress' : 'unwatched';
  return {
    ...e,
    header: true,
    parts: parts.length,
    episodes: null,
    seasons: null,
    watchedEpisodes: null,
    runtime: null,
    watchedMinutes: 0,
    state,
    percent: counted.length ? Math.round((watched / counted.length) * 100) : 0,
    watchedAt: null,
    skipped: counted.length === 0,
    skippedEpisodes: null,
  };
}

function baseEntryFor(i: ItemRow, position: number, c: EntryContext): Omit<TimelineEntry, 'skipped' | 'jellyfinItemId' | 'header' | 'parts'> {
  const matched = i.match_status === 'matched' && Boolean(c.row);
  const mediaType = c.row?.media_type ?? i.media_type;
  const kind: EntryKind = i.season_number !== null ? (i.episode_number !== null ? 'episode' : 'season') : mediaType === 'tv' ? 'show' : 'movie';
  const base = {
    itemId: i.id,
    position,
    kind,
    matched,
    title: matched ? (c.card ?? null) : null,
    sourceTitle: i.source_title,
    year: c.row?.year ?? i.source_year,
    season: i.season_number,
    episode: i.episode_number,
    episodeTitle: i.episode_title,
    sourceUrl: i.source_url,
    manualAt: matched ? manualDateFor(c.marks, i.season_number, i.season_number !== null ? i.episode_number : null) : null,
  };

  if (!matched || !c.row || !c.status) {
    const runtime = kind === 'movie' || kind === 'episode' ? i.source_runtime : null;
    return {
      ...base,
      episodes: kind === 'episode' ? 1 : kind === 'movie' ? null : i.source_episodes,
      seasons: kind === 'show' ? i.source_seasons : null,
      watchedEpisodes: null,
      runtime,
      watchedMinutes: 0,
      state: 'unwatched',
      percent: 0,
      availability: 'unknown',
      stage: 'unknown',
      watchedAt: null,
      skippedEpisodes: null,
    };
  }

  const s = c.status;
  const t = c.row;
  const viewing = s.viewing.state;

  if (kind === 'movie') {
    const runtime = t.runtime ?? i.source_runtime ?? c.jfRuntime;
    const state: EntryState = viewing === 'watched' ? 'watched' : viewing === 'in_progress' ? 'in_progress' : 'unwatched';
    const pct = state === 'watched' ? 100 : state === 'in_progress' ? Math.min(99, Math.max(1, s.viewing.progress?.percent ?? 1)) : 0;
    return {
      ...base,
      episodes: null,
      seasons: null,
      watchedEpisodes: null,
      runtime,
      watchedMinutes: runtime ? Math.round((runtime * pct) / 100) : 0,
      state,
      percent: pct,
      availability: s.availability.state,
      stage: s.stage,
      watchedAt: state === 'watched' ? (base.manualAt ?? s.viewing.progress?.lastPlayedAt ?? null) : null,
      skippedEpisodes: null,
    };
  }

  const seasonSizes = parseJson<{ season: number; episodes: number | null }[]>(t.seasons, []);
  const regularPresent = [...(c.present?.entries() ?? [])].filter(([k]) => !k.startsWith('0:'));
  const presentRuntimes = regularPresent.map(([, m]) => m).filter((m): m is number => m !== null);
  const avgPresent = presentRuntimes.length ? Math.round(presentRuntimes.reduce((a, b) => a + b, 0) / presentRuntimes.length) : null;
  const perEpisode = t.runtime ?? i.source_runtime ?? c.jfRuntime ?? avgPresent;
  const showWatched = viewing === 'watched';

  const sizeOf = (n: number) => seasonSizes.find((x) => x.season === n)?.episodes ?? c.guide?.get(n) ?? null;
  // Unwatched episodes covered by a season or episode skip (a whole-show skip skips the entry).
  const skippedIn = (season: number | null, limit: number | null) => {
    const m = c.skips;
    if (!m || m.title) return 0;
    const covered = new Set<string>();
    for (const n of m.seasons) {
      if (season === null ? n === 0 : n !== season) continue;
      const size = sizeOf(n);
      for (let e = 1; e <= (size ?? 0); e++) covered.add(key(n, e));
    }
    for (const k of m.episodes) {
      const [n, e] = k.split(':').map(Number) as [number, number];
      if ((season === null ? n > 0 : n === season) && (limit === null || e <= limit)) covered.add(k);
    }
    return [...covered].filter((k) => !c.watched.has(k)).length;
  };
  let episodes: number | null;
  let seasons: number | null = null;
  let watchedEps: number;
  let skippedEps = 0;
  let runtime: number | null;
  let availability: AvailabilityState = s.availability.state;

  if (kind === 'show') {
    // The list's own count wins: sources sometimes list parts of what TMDb treats as one show.
    episodes = i.source_episodes ?? t.episode_count ?? (regularPresent.length || null);
    seasons = i.source_seasons ?? t.season_count ?? (new Set(regularPresent.map(([k]) => k.split(':')[0])).size || null);
    const counted = [...c.watched].filter((k) => !k.startsWith('0:')).length;
    watchedEps = showWatched && episodes !== null ? episodes : Math.max(counted, s.viewing.progress?.playedEpisodes ?? 0);
    if (!showWatched && !base.manualAt) skippedEps = Math.min(skippedIn(null, null), Math.max(0, (episodes ?? 0) - watchedEps));
    runtime = episodes !== null && perEpisode !== null ? (episodes - skippedEps) * perEpisode : null;
  } else if (kind === 'season') {
    const n = i.season_number!;
    const inSeason = [...(c.present?.entries() ?? [])].filter(([k]) => k.startsWith(`${n}:`));
    // A source may list part of a season (anime split into cours), so the smaller count wins.
    const known = sizeOf(n);
    episodes = known !== null && i.source_episodes !== null ? Math.min(known, i.source_episodes) : (known ?? i.source_episodes ?? (inSeason.length || null));
    watchedEps = (showWatched || base.manualAt) && episodes !== null ? episodes : [...c.watched].filter((k) => k.startsWith(`${n}:`)).length;
    if (!showWatched && !base.manualAt && !c.skips?.seasons.has(n)) skippedEps = Math.min(skippedIn(n, episodes), Math.max(0, (episodes ?? 0) - watchedEps));
    runtime = episodes !== null && perEpisode !== null ? (episodes - skippedEps) * perEpisode : null;
    if (c.present) availability = inSeason.length === 0 ? (s.availability.state === 'unknown' ? 'unknown' : 'not_in_library') : episodes !== null && inSeason.length >= episodes ? 'in_library' : 'partially_in_library';
  } else {
    const k = key(i.season_number!, i.episode_number!);
    episodes = 1;
    watchedEps = showWatched || base.manualAt || c.watched.has(k) ? 1 : 0;
    runtime = i.source_runtime ?? c.present?.get(k) ?? perEpisode;
    if (c.present) availability = c.present.has(k) ? 'in_library' : s.availability.state === 'unknown' ? 'unknown' : 'not_in_library';
  }

  if (episodes !== null) watchedEps = Math.min(watchedEps, episodes);
  // Episodes still to count: skipped ones are not part of the entry any more.
  const counted = episodes !== null ? episodes - skippedEps : null;
  const state: EntryState =
    base.manualAt && kind !== 'show'
      ? 'watched'
      : counted !== null
        ? watchedEps >= counted && counted > 0
          ? 'watched'
          : watchedEps > 0
            ? 'in_progress'
            : 'unwatched'
        : showWatched
          ? 'watched'
          : watchedEps > 0
            ? 'in_progress'
            : 'unwatched';
  const pct = state === 'watched' ? 100 : counted ? Math.round((watchedEps / counted) * 100) : 0;
  const watchedMinutes = runtime === null ? 0 : state === 'watched' ? runtime : counted ? Math.round((runtime * watchedEps) / counted) : 0;
  const entryViewing = state === 'watched' ? 'watched' : state === 'in_progress' ? 'in_progress' : 'unwatched';
  return {
    ...base,
    episodes,
    seasons,
    watchedEpisodes: watchedEps,
    runtime,
    watchedMinutes,
    state,
    percent: pct,
    availability,
    stage: kind === 'show' ? s.stage : lifecycleStage(availability, s.request.state, entryViewing),
    watchedAt: state === 'watched' ? (base.manualAt ?? (kind === 'show' ? (s.viewing.progress?.lastPlayedAt ?? null) : null)) : null,
    skippedEpisodes: kind === 'episode' ? null : skippedEps,
  };
}

export function summarize(entries: TimelineEntry[]): TimelineSummary {
  const sum: TimelineSummary = {
    entries: 0,
    headers: 0,
    films: 0,
    shows: 0,
    seasons: 0,
    episodes: 0,
    totalMinutes: 0,
    watchedMinutes: 0,
    remainingMinutes: 0,
    watchedEntries: 0,
    skippedEntries: 0,
    unknownRuntime: 0,
    unmatched: 0,
  };
  for (const e of entries) {
    if (e.header) {
      sum.headers++;
      continue;
    }
    sum.entries++;
    if (e.kind === 'movie') sum.films++;
    else {
      if (e.kind === 'show') {
        sum.shows++;
        sum.seasons += e.seasons ?? 0;
      } else if (e.kind === 'season') sum.seasons++;
      sum.episodes += e.episodes ?? 0;
    }
    if (e.skipped) {
      // Not going to be watched: counted, but its time is not part of the list's watch time.
      sum.skippedEntries++;
    } else if (e.runtime === null) sum.unknownRuntime++;
    else {
      sum.totalMinutes += e.runtime;
      sum.watchedMinutes += e.watchedMinutes;
    }
    if (e.state === 'watched') sum.watchedEntries++;
    if (!e.matched) sum.unmatched++;
  }
  sum.remainingMinutes = Math.max(0, sum.totalMinutes - sum.watchedMinutes);
  return sum;
}

export type AutoOrder = 'release' | 'release_desc' | 'title' | 'runtime';

/**
 * When an entry came out: the movie's or show's release date, the season's air date for season and
 * episode entries, or the year the source reported for unmatched entries. Null when unknown.
 */
export function entryReleaseDates(ctx: AppContext, entries: TimelineEntry[]): Map<number, string | null> {
  const ids = [...new Set(entries.map((e) => e.title?.id).filter((x): x is number => typeof x === 'number'))];
  const rows = new Map(
    inChunks(ids, (c, ph) =>
      ctx.db.prepare(`SELECT id, release_date, year, seasons FROM titles WHERE id IN (${ph})`).all(...c) as { id: number; release_date: string | null; year: number | null; seasons: string | null }[],
    ).map((r) => [r.id, r]),
  );
  const out = new Map<number, string | null>();
  for (const e of entries) {
    const r = e.title ? rows.get(e.title.id) : undefined;
    let d: string | null = null;
    if (r) {
      if (e.season !== null && e.season > 0) {
        const s = parseJson<{ season: number; airDate?: string | null }[]>(r.seasons, []).find((x) => x.season === e.season);
        d = s?.airDate ?? null;
      }
      d ??= r.release_date || (r.year ? `${r.year}-01-01` : null);
    }
    d ??= e.year ? `${e.year}-07-01` : null;
    out.set(e.itemId, d && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null);
  }
  return out;
}

/**
 * Sorts a list's entries automatically, e.g. into release order for lists without an order of
 * their own. Entries without the sort value keep their relative order at the end. Parts of one
 * show stay in season and episode order when they share a date.
 */
export function autoOrder(entries: TimelineEntry[], by: AutoOrder, dates: Map<number, string | null>): number[] {
  const name = (e: TimelineEntry) => (e.title?.title ?? e.sourceTitle).toLocaleLowerCase();
  const parts = (a: TimelineEntry, b: TimelineEntry) => (a.season ?? -1) - (b.season ?? -1) || (a.episode ?? -1) - (b.episode ?? -1);
  const nullsLast = <T>(a: T | null, b: T | null, cmp: (x: T, y: T) => number) => (a === null ? (b === null ? 0 : 1) : b === null ? -1 : cmp(a, b));
  const sorted = [...entries].sort((a, b) => {
    let r = 0;
    if (by === 'release' || by === 'release_desc') {
      const dir = by === 'release' ? 1 : -1;
      r = nullsLast(dates.get(a.itemId) ?? null, dates.get(b.itemId) ?? null, (x, y) => (x < y ? -dir : x > y ? dir : 0));
      if (r === 0 && a.title?.id === b.title?.id) r = parts(a, b);
    } else if (by === 'title') {
      r = name(a).localeCompare(name(b)) || parts(a, b);
    } else {
      r = nullsLast(a.runtime, b.runtime, (x, y) => x - y);
    }
    return r || a.position - b.position;
  });
  return sorted.map((e) => e.itemId);
}

function nextIndex(entries: TimelineEntry[]): number | null {
  const i = entries.findIndex((e) => e.matched && e.state !== 'watched' && !e.skipped && !e.header);
  return i < 0 ? null : i;
}
