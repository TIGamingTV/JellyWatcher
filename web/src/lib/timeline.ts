import { duration, episodeCode, plural, seasonName } from './format';
import type { TimelineEntry } from './types';

/*
 * Timeline helpers without React, shared by the web app and the Jellyfin plugin's Watchlists page.
 */

/** Display name of an entry: the show for seasons/episodes, plus what part of it. */
export function entryHeading(e: TimelineEntry): { title: string; part: string | null } {
  const title = e.title?.title ?? e.sourceTitle;
  if (e.kind === 'episode') return { title, part: [episodeCode(e.season, e.episode), e.episodeTitle].filter(Boolean).join(' · ') };
  // Season entries can carry the source's own name for the season (anime seasons and cours).
  if (e.kind === 'season') return { title, part: [episodeCode(e.season, null), seasonName(e.episodeTitle, title, e.season)].filter(Boolean).join(' · ') };
  return { title, part: null };
}

export function entryFacts(e: TimelineEntry): string[] {
  const facts: (string | null)[] = [];
  if (e.header) return ['Show', e.parts ? `${plural(e.parts, 'entry', 'entries')} below` : null].filter((f): f is string => Boolean(f));
  if (e.kind === 'movie') facts.push('Movie', e.year ? String(e.year) : null);
  else if (e.kind === 'show') facts.push('Show', e.seasons ? plural(e.seasons, 'season') : null, e.episodes ? plural(e.episodes, 'episode') : null);
  else if (e.kind === 'season') facts.push(e.episodes ? plural(e.episodes, 'episode') : 'Season');
  else facts.push('Episode');
  if ((e.kind === 'show' || e.kind === 'season') && e.skippedEpisodes && !e.skipped) facts.push(`${e.skippedEpisodes.toLocaleString()} skipped`);
  facts.push(e.runtime ? duration(e.runtime) : null);
  return facts.filter((f): f is string => Boolean(f));
}

/** "3 of 18 episodes" (skipped episodes left out) or "40% watched" for entries being watched. */
export function entryProgress(e: TimelineEntry): string | null {
  if (e.state !== 'in_progress') return null;
  return e.episodes ? `${e.watchedEpisodes ?? 0} of ${plural(e.episodes - (e.skippedEpisodes ?? 0), 'episode')}` : `${e.percent}% watched`;
}

/** Index of the entry to watch next (not watched, not skipped, not a header); -1 when none. */
export function nextEntryIndex(entries: TimelineEntry[]): number {
  return entries.findIndex((e) => e.matched && e.state !== 'watched' && !e.skipped && !e.header);
}

/**
 * Which rows the progress rail runs through: watched rows, and skipped rows before the next thing
 * to watch (a skip further down, among what is still to come, keeps the rail grey). `next` is the
 * index of Up Next, -1 when nothing is left.
 */
export function railDone<T>(items: T[], next: number, watched: (x: T) => boolean, skipped: (x: T) => boolean): boolean[] {
  return items.map((x, i) => watched(x) || (skipped(x) && (next < 0 || i < next)));
}

/** Rail of a timeline: watched entries and headers, and skipped entries before Up Next. */
export function timelineRail(entries: TimelineEntry[], next: number): boolean[] {
  return railDone(entries, next, (e) => e.state === 'watched', (e) => e.skipped);
}

/** Shows and seasons expand into their episodes. Headers and unmatched entries do not. */
export function expandable(e: TimelineEntry): boolean {
  return Boolean(e.matched && e.title && e.title.mediaType === 'tv' && !e.header && (e.kind === 'show' || e.kind === 'season'));
}

/** The part of the title an entry stands for. */
export function scopeOf(e: Pick<TimelineEntry, 'kind' | 'season' | 'episode'>): { season?: number | null; episode?: number | null } {
  return e.kind === 'season' ? { season: e.season } : e.kind === 'episode' ? { season: e.season, episode: e.episode } : {};
}
