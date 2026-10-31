import { describe, expect, it } from 'vitest';
import { markHeaders, summarize, type TimelineEntry } from '../server/services/timeline';
import { entryFacts, expandable, nextEntryIndex, timelineRail } from '../web/src/lib/timeline';
import { canAddSpecials, guideSeasons, initialSeason, seasonFacts, seasonRail, withEpisode } from '../web/src/lib/episodes';
import type { EpisodeGuide, GuideEpisode, GuideSeason } from '../web/src/lib/types';
import type { TimelineEntry as WebEntry } from '../web/src/lib/types';

let nextId = 1;
function entry(kind: TimelineEntry['kind'], titleId: number | null, over: Partial<TimelineEntry> = {}): TimelineEntry {
  const id = nextId++;
  return {
    itemId: id,
    position: id,
    kind,
    matched: titleId !== null,
    title: titleId !== null ? ({ id: titleId, title: `T${titleId}` } as TimelineEntry['title']) : null,
    sourceTitle: `T${titleId}`,
    year: null,
    season: kind === 'season' || kind === 'episode' ? 1 : null,
    episode: kind === 'episode' ? id : null,
    episodeTitle: null,
    episodes: kind === 'movie' ? null : kind === 'episode' ? 1 : 10,
    seasons: kind === 'show' ? 2 : null,
    watchedEpisodes: 0,
    runtime: kind === 'show' ? 500 : 50,
    watchedMinutes: 0,
    state: 'unwatched',
    percent: 0,
    availability: 'in_library',
    stage: 'in_library',
    sourceUrl: null,
    manualAt: null,
    watchedAt: null,
    skipped: false,
    jellyfinItemId: null,
    header: false,
    parts: null,
    skippedEpisodes: kind === 'show' || kind === 'season' ? 0 : null,
    ...over,
  };
}

describe('show entries that head their parts', () => {
  // Like IMDb watch-order lists: "Better Call Saul", its episodes, a movie, "Breaking Bad", its episodes.
  const bcs = 1;
  const bb = 2;
  const list = () => {
    nextId = 1;
    return [
      entry('show', bcs),
      entry('episode', bcs, { state: 'watched', watchedMinutes: 50, watchedEpisodes: 1 }),
      entry('episode', bcs),
      entry('movie', 3),
      entry('show', bb),
      entry('season', bb),
      entry('episode', bcs),
      entry('show', 4), // nothing of it follows: the whole show
      entry('show', 5, { matched: false, title: null }),
    ];
  };

  it('turns a show into a header only when parts of it follow', () => {
    const out = markHeaders(list());
    expect(out.map((e) => [e.kind, e.header, e.parts])).toEqual([
      ['show', true, 3],
      ['episode', false, null],
      ['episode', false, null],
      ['movie', false, null],
      ['show', true, 1],
      ['season', false, null],
      ['episode', false, null],
      ['show', false, null],
      ['show', false, null],
    ]);
    expect(out[0]).toMatchObject({ runtime: null, episodes: null, seasons: null, watchedMinutes: 0, state: 'in_progress', percent: 33 });
    expect(out[4]).toMatchObject({ state: 'unwatched' });
  });

  it('counts no time for headers and never makes them Up Next', () => {
    const out = markHeaders(list());
    const sum = summarize(out);
    expect(sum).toMatchObject({ entries: 7, headers: 2, films: 1, shows: 2, seasons: 5, episodes: 33, totalMinutes: 50 * 5 + 500 + 500 });
    expect(nextEntryIndex(out as unknown as WebEntry[])).toBe(2);
    // With the first episode unwatched Up Next is that episode, not the header above it.
    const fresh = markHeaders(list().map((e) => ({ ...e, state: 'unwatched' as const })));
    expect(nextEntryIndex(fresh as unknown as WebEntry[])).toBe(1);
    expect(entryFacts(out[0] as unknown as WebEntry)).toEqual(['Show', '3 entries below']);
  });

  it('is watched when all of its parts are, and skipped when all are skipped', () => {
    nextId = 1;
    const watched = markHeaders([entry('show', 1), entry('episode', 1, { state: 'watched' }), entry('episode', 1, { skipped: true })]);
    expect(watched[0]).toMatchObject({ header: true, state: 'watched', percent: 100, skipped: false });
    const skipped = markHeaders([entry('show', 1), entry('episode', 1, { skipped: true })]);
    expect(skipped[0]).toMatchObject({ header: true, skipped: true });
  });

  it('keeps a show whole when only its specials follow it', () => {
    nextId = 1;
    const out = markHeaders([entry('show', 1), entry('season', 1, { season: 0 }), entry('episode', 1, { season: 0 })]);
    expect(out[0]).toMatchObject({ header: false, runtime: 500 });
  });
});

describe('skipped episodes', () => {
  it('lists them with the facts of a show or season', () => {
    nextId = 1;
    expect(entryFacts(entry('show', 1, { skippedEpisodes: 3 }) as unknown as WebEntry)).toEqual(['Show', '2 seasons', '10 episodes', '3 skipped', '8 h 20 min']);
    expect(entryFacts(entry('season', 1) as unknown as WebEntry)).toEqual(['10 episodes', '50 min']);
  });
});

describe('the progress rail', () => {
  it('runs through watched entries and through skipped ones before Up Next only', () => {
    nextId = 1;
    const list = [
      entry('movie', 1, { state: 'watched' }),
      entry('movie', 2, { skipped: true }),
      entry('movie', 3),
      entry('movie', 4, { skipped: true }),
      entry('movie', 5, { state: 'watched' }),
    ] as unknown as WebEntry[];
    const next = nextEntryIndex(list);
    expect(next).toBe(2);
    expect(timelineRail(list, next)).toEqual([true, true, false, false, true]);
    // Nothing left to watch: every skip is part of the finished rail.
    expect(timelineRail(list, -1)).toEqual([true, true, false, true, true]);
  });

  it('expands matched shows and seasons, not headers, episodes or movies', () => {
    nextId = 1;
    const tv = (kind: TimelineEntry['kind'], over: Partial<TimelineEntry> = {}) => entry(kind, 1, { title: { id: 1, title: 'S', mediaType: 'tv', tmdbId: 9 } as TimelineEntry['title'], ...over }) as unknown as WebEntry;
    expect([tv('show'), tv('season'), tv('episode'), tv('show', { header: true }), tv('show', { matched: false }), entry('movie', 2) as unknown as WebEntry].map(expandable)).toEqual([true, true, false, false, false, false]);
  });
});

describe('episode guide', () => {
  const ep = (n: number, over: Partial<GuideEpisode> = {}): GuideEpisode => ({ episode: n, name: `E${n}`, airDate: '2020-01-01', aired: true, runtime: 30, watched: false, source: null, watchedAt: null, skipped: false, inLibrary: true, jellyfinItemId: null, ...over });
  const season = (n: number, list: GuideEpisode[], over: Partial<GuideSeason> = {}): GuideSeason => ({
    season: n,
    year: 2020,
    episodes: list.length,
    watched: list.filter((e) => e.watched).length,
    skipped: list.filter((e) => e.skipped).length,
    seasonSkipped: false,
    runtime: 30 * list.filter((e) => !e.skipped).length,
    watchedMinutes: 0,
    manualAt: null,
    list,
    ...over,
  });
  const guide: EpisodeGuide = {
    titleId: 1,
    source: 'tmdb',
    skipped: false,
    seasons: [season(1, [ep(1, { watched: true }), ep(2, { watched: true })]), season(2, [ep(1, { watched: true }), ep(2, { skipped: true }), ep(3), ep(4, { aired: false })]), season(0, [ep(1)])],
  };

  it('splits regular seasons from specials and opens the season with the next episode', () => {
    nextId = 1;
    const show = entry('show', 1) as unknown as WebEntry;
    const { regular, specials } = guideSeasons(guide, show);
    expect(regular.map((s) => s.season)).toEqual([1, 2]);
    expect(specials?.season).toBe(0);
    expect(initialSeason(regular)).toBe(2);
    expect(guideSeasons(guide, entry('season', 1, { season: 2 }) as unknown as WebEntry)).toMatchObject({ regular: [{ season: 2 }], specials: null });
    expect(seasonRail(regular[1]!)).toEqual([true, true, false, false]);
    expect(seasonFacts(regular[1]!)).toEqual(['1 of 3 episodes watched', '1 skipped', '2020', '1 h 30 min']);
  });

  it('recounts a season when an episode changes', () => {
    const g = withEpisode(guide, 2, 3, { watched: true, source: 'manual' });
    expect(g.seasons[1]).toMatchObject({ watched: 2, skipped: 1, runtime: 90, watchedMinutes: 60 });
    const back = withEpisode(guide, 2, 2, { skipped: false });
    expect(back.seasons[1]).toMatchObject({ skipped: 0, runtime: 120 });
  });

  it('offers to add specials once, on local lists only', () => {
    nextId = 1;
    const show = entry('show', 1, { title: { id: 1, title: 'S', mediaType: 'tv', tmdbId: 9 } as TimelineEntry['title'] }) as unknown as WebEntry;
    expect(canAddSpecials(show, [show], true)).toBe(true);
    expect(canAddSpecials(show, [show], false)).toBe(false);
    const specials = entry('season', 1, { season: 0 }) as unknown as WebEntry;
    expect(canAddSpecials(show, [show, specials], true)).toBe(false);
  });
});
