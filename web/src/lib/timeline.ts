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
  facts.push(e.runtime ? duration(e.runtime) : null);
  return facts.filter((f): f is string => Boolean(f));
}

/** Index of the entry to watch next (not watched, not skipped, not a header); -1 when none. */
export function nextEntryIndex(entries: TimelineEntry[]): number {
  return entries.findIndex((e) => e.matched && e.state !== 'watched' && !e.skipped && !e.header);
}

/** The part of the title an entry stands for. */
export function scopeOf(e: Pick<TimelineEntry, 'kind' | 'season' | 'episode'>): { season?: number | null; episode?: number | null } {
  return e.kind === 'season' ? { season: e.season } : e.kind === 'episode' ? { season: e.season, episode: e.episode } : {};
}
