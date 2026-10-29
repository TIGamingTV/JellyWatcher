import { describe, expect, it } from 'vitest';
import { markHeaders, summarize, type TimelineEntry } from '../server/services/timeline';
import { entryFacts, nextEntryIndex } from '../web/src/lib/timeline';
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
});
