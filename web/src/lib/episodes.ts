import { duration, plural } from './format';
import { railDone } from './timeline';
import type { EpisodeGuide, GuideEpisode, GuideSeason, TimelineEntry } from './types';

/*
 * Episode guide helpers without React, shared by the web app and the Jellyfin plugin: what an
 * expanded show or season lists, and how each line and season heading reads.
 */

export const seasonTitle = (s: Pick<GuideSeason, 'season'>) => (s.season === 0 ? 'Specials' : `Season ${s.season}`);

/** The seasons an expanded entry shows: all of them for a show, its own for a season entry. */
export function guideSeasons(guide: EpisodeGuide, e: Pick<TimelineEntry, 'kind' | 'season'>): { regular: GuideSeason[]; specials: GuideSeason | null } {
  if (e.kind === 'season') {
    const own = guide.seasons.find((s) => s.season === e.season);
    return { regular: own ? [own] : [], specials: null };
  }
  return { regular: guide.seasons.filter((s) => s.season > 0), specials: guide.seasons.find((s) => s.season === 0 && s.episodes > 0) ?? null };
}

/** The episode to watch next in a season: aired, not watched, not skipped; -1 when none. */
export function nextEpisodeIndex(s: GuideSeason): number {
  return s.list.findIndex((e) => e.aired && !e.watched && !e.skipped);
}

/** Rail of a season's episode list (same rule as the timeline). */
export function seasonRail(s: GuideSeason): boolean[] {
  return railDone(s.list, nextEpisodeIndex(s), (e) => e.watched, (e) => e.skipped);
}

/** Season open at first: the one with the next episode to watch, else the first. */
export function initialSeason(seasons: GuideSeason[]): number | null {
  return (seasons.find((s) => nextEpisodeIndex(s) >= 0) ?? seasons[0])?.season ?? null;
}

/** Done when every episode is watched or skipped. */
export const seasonDone = (s: GuideSeason) => s.episodes > 0 && s.watched + s.skipped >= s.episodes;

/** Watched share of what is still counted (skipped episodes left out), 0–100. */
export function seasonPercent(s: GuideSeason): number {
  const counted = s.episodes - s.skipped;
  return counted > 0 ? Math.round((s.watched / counted) * 100) : s.episodes > 0 ? 100 : 0;
}

/** "4 of 10 watched · 2014 · 7 h 50 min" */
export function seasonFacts(s: GuideSeason): string[] {
  const counted = s.episodes - s.skipped;
  return [
    s.episodes === 0 ? 'No episodes known' : s.watched > 0 ? `${s.watched} of ${plural(counted, 'episode')} watched` : plural(s.episodes, 'episode'),
    s.skipped > 0 && !s.seasonSkipped ? `${s.skipped} skipped` : null,
    s.seasonSkipped ? 'Not watching' : null,
    s.year ? String(s.year) : null,
    s.runtime ? duration(s.runtime) : null,
  ].filter((f): f is string => Boolean(f));
}

export const episodeTitle = (e: GuideEpisode) => e.name ?? `Episode ${e.episode}`;

/** Year and watch time of an episode, plus "Not aired yet" or "Not in library" hints. */
export function episodeFacts(e: GuideEpisode): string[] {
  return [
    e.airDate ? (e.aired ? e.airDate.slice(0, 4) : `Airs ${e.airDate}`) : !e.aired ? 'Not aired yet' : null,
    e.runtime ? duration(e.runtime) : null,
  ].filter((f): f is string => Boolean(f));
}

/** Specials can be added to a local list once, right after the show. */
export function canAddSpecials(e: TimelineEntry, entries: TimelineEntry[], editable: boolean): boolean {
  if (!editable || e.kind !== 'show' || !e.title?.tmdbId) return false;
  return !entries.some((x) => x.title?.id === e.title!.id && x.kind === 'season' && x.season === 0);
}

/** Recounts a season after its episodes changed (watched wins over skipped). */
export function recountSeason(s: GuideSeason, list: GuideEpisode[]): GuideSeason {
  const counted = list.filter((e) => e.watched || !e.skipped);
  const minutes = counted.map((e) => e.runtime).filter((m): m is number => m !== null);
  return {
    ...s,
    list,
    watched: list.filter((e) => e.watched).length,
    skipped: list.length - counted.length,
    seasonSkipped: s.seasonSkipped && list.every((e) => e.watched || e.skipped),
    runtime: minutes.length ? minutes.reduce((a, b) => a + b, 0) : null,
    watchedMinutes: counted.filter((e) => e.watched).reduce((n, e) => n + (e.runtime ?? 0), 0),
  };
}

/** The guide with one episode changed, for showing a tap right away (the refetch confirms it). */
export function withEpisode(guide: EpisodeGuide, season: number, episode: number, patch: Partial<Pick<GuideEpisode, 'watched' | 'skipped' | 'source'>>): EpisodeGuide {
  return {
    ...guide,
    skipped: patch.skipped === false ? false : guide.skipped,
    seasons: guide.seasons.map((s) => (s.season !== season ? s : recountSeason(s, s.list.map((e) => (e.episode === episode ? { ...e, ...patch, skipped: (patch.skipped ?? e.skipped) && !(patch.watched ?? e.watched) } : e))))),
  };
}
