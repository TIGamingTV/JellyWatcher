import { describe, expect, it } from 'vitest';
import { evaluatePolicy, othersPool, type PersonProgress } from '../server/janitor/policy';
import { renderTemplate } from '../server/janitor/notify';
import { DEFAULT_WATCHERS, type JanitorWatchers } from '../shared/janitor';

const now = new Date('2026-11-07T12:00:00Z');
const person = (name: string, p: Partial<PersonProgress> = {}): PersonProgress => ({
  userId: name.length,
  name,
  done: false,
  doneAt: null,
  started: false,
  lastActivity: null,
  watchlisted: false,
  ...p,
});
const done = (name: string, at: string, p: Partial<PersonProgress> = {}) => person(name, { done: true, doneAt: at, started: true, lastActivity: at, ...p });
const w = (p: Partial<JanitorWatchers> = {}): JanitorWatchers => ({ ...DEFAULT_WATCHERS, dropAfterDays: null, ...p });
const evalP = (watchers: JanitorWatchers, requesters: PersonProgress[], others: PersonProgress[] = [], unknownRequesters: string[] = []) =>
  evaluatePolicy({ watchers, requesters, others, unknownRequesters, requestedAt: '2026-10-01T00:00:00Z', now });

describe('Janitor watcher policy', () => {
  it('requester only: waits for every requester and starts the clock when the last one finished', () => {
    expect(evalP(w(), [person('Ann')])).toMatchObject({ eligible: false, waitingFor: ['Ann'] });
    expect(evalP(w(), [done('Ann', '2026-10-05T00:00:00Z'), done('Ben', '2026-10-09T00:00:00Z')])).toMatchObject({ eligible: true, eligibleAt: '2026-10-09T00:00:00.000Z' });
    expect(evalP(w(), [done('Ann', '2026-10-05T00:00:00Z'), person('Ben')])).toMatchObject({ eligible: false, waitingFor: ['Ben'] });
  });

  it('never acts for requesters without an account, or without any requester', () => {
    expect(evalP(w(), [done('Ann', '2026-10-05T00:00:00Z')], [], ['guest']).reason).toMatch(/guest, who has no JellyWatcher account/);
    expect(evalP(w(), []).eligible).toBe(false);
  });

  it('active watchers must finish too, unless they stopped watching for the set number of days', () => {
    const ann = done('Ann', '2026-10-05T00:00:00Z');
    const ben = person('Ben', { started: true, lastActivity: '2026-10-20T00:00:00Z' });
    const cid = person('Cid'); // never started: not an active watcher
    expect(evalP(w({ others: 'active' }), [ann], [ben, cid])).toMatchObject({ eligible: false, waitingFor: ['Ben'] });
    expect(evalP(w({ others: 'active', dropAfterDays: 30 }), [ann], [ben, cid])).toMatchObject({ eligible: false });
    const r = evalP(w({ others: 'active', dropAfterDays: 14 }), [ann], [ben, cid]);
    expect(r).toMatchObject({ eligible: true, eligibleAt: '2026-11-03T00:00:00.000Z', counted: ['Ann', 'Ben (inactive)'] });
  });

  it('watchlisted people count from when the requester finished', () => {
    const ann = done('Ann', '2026-10-20T00:00:00Z');
    const ben = person('Ben', { watchlisted: true });
    expect(evalP(w({ others: 'watchlisted' }), [ann], [ben]).eligible).toBe(false);
    expect(evalP(w({ others: 'watchlisted', dropAfterDays: 10 }), [ann], [ben])).toMatchObject({ eligible: true, eligibleAt: '2026-10-30T00:00:00.000Z' });
    expect(evalP(w({ others: 'watchlisted', dropAfterDays: 30 }), [ann], [ben]).eligible).toBe(false);
    expect(evalP(w({ others: 'active_or_watchlisted' }), [ann], [ben, person('Cid', { started: true })]).waitingFor).toEqual(['Ben', 'Cid']);
  });

  it('all / any / at least N of the linked people', () => {
    const people = [done('Ann', '2026-10-01T00:00:00Z'), done('Ben', '2026-10-03T00:00:00Z'), person('Cid')];
    const ignored = (p: Partial<JanitorWatchers>) => w({ requester: 'ignored', others: 'all_linked', ...p });
    expect(evalP(ignored({}), [], people).eligible).toBe(false);
    expect(evalP(ignored({ othersMode: 'at_least', atLeast: 1 }), [], people)).toMatchObject({ eligible: true, eligibleAt: '2026-10-01T00:00:00.000Z' });
    expect(evalP(ignored({ othersMode: 'at_least', atLeast: 2 }), [], people)).toMatchObject({ eligible: true, eligibleAt: '2026-10-03T00:00:00.000Z' });
    expect(evalP(ignored({ othersMode: 'at_least', atLeast: 3 }), [], people)).toMatchObject({ eligible: false, reason: 'Waiting for 1 more person to finish it.' });
    // At least N with more than there are people: everyone.
    expect(evalP(ignored({ othersMode: 'at_least', atLeast: 9 }), [], people.slice(0, 2)).eligible).toBe(true);
    // Nobody to judge by.
    expect(evalP(ignored({}), [], []).reason).toBe('Nobody has watched it yet.');
    expect(evalP(ignored({ othersMode: 'at_least' }), [], []).eligible).toBe(false);
    // The requester counts like everyone else when ignored.
    expect(evalP(ignored({}), [done('Ann', '2026-10-01T00:00:00Z')], [done('Ben', '2026-10-02T00:00:00Z')]).eligible).toBe(true);
  });

  it('picks the right people for each "others" setting', () => {
    const people = [person('a', { started: true }), person('b', { watchlisted: true }), done('c', '2026-10-01T00:00:00Z'), person('d')];
    expect(othersPool('none', people)).toEqual([]);
    expect(othersPool('active', people).map((p) => p.name)).toEqual(['a', 'c']);
    expect(othersPool('watchlisted', people).map((p) => p.name)).toEqual(['b']);
    expect(othersPool('active_or_watchlisted', people).map((p) => p.name)).toEqual(['a', 'b', 'c']);
    expect(othersPool('all_linked', people)).toHaveLength(4);
  });

  it('never dates eligibility in the future', () => {
    expect(evalP(w(), [done('Ann', '2027-01-01T00:00:00Z')]).eligibleAt).toBe(now.toISOString());
  });
});

describe('Janitor notification templates', () => {
  it('fills the placeholders', () => {
    const msg = renderTemplate('{title} ({requester}, {size}) goes on {date}. {unknown}', { title: 'Severance', season: 2, requester: 'Ann', date: '2026-11-10T18:00:00Z', size: 12 * 1024 ** 3, rule: 'Seasons' });
    expect(msg).toMatch(/^Severance · Season 2 \(Ann, 12 GB\) goes on .*10 Nov.* \{unknown\}$/);
  });
});
