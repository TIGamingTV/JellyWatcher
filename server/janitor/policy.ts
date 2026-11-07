import type { JanitorWatchers } from '../../shared/janitor.js';

/**
 * Who has to finish a unit (movie, season or show) before the Janitor may clean it up. Pure, so
 * every combination of the watcher settings can be tested without a database.
 */

export interface PersonProgress {
  userId: number;
  name: string;
  /** Finished the unit (watched it, or marked it "Not Watching"). */
  done: boolean;
  /** When they finished it (latest play or mark covering the unit). */
  doneAt: string | null;
  /** Played or marked any of it. */
  started: boolean;
  /** Last time they played anything of the title. */
  lastActivity: string | null;
  /** Has the title on one of their watchlists. */
  watchlisted: boolean;
  /** Shows: episodes of the unit they watched or marked watched. */
  watched?: number;
  /** Shows: episodes of the unit still to watch (not downloaded ones included); null: not watching the show. */
  left?: number | null;
}

export interface PolicyInput {
  watchers: JanitorWatchers;
  /** Requesters with a JellyWatcher account. */
  requesters: PersonProgress[];
  /** Requesters without a JellyWatcher account (names). */
  unknownRequesters: string[];
  /** Every other active person whose viewing is known (requesters excluded). */
  others: PersonProgress[];
  /** When the unit was requested; inactivity of people who never started counts from here at the latest. */
  requestedAt: string | null;
  now: Date;
}

export interface PolicyResult {
  eligible: boolean;
  /** When the last person needed finished (or stopped counting); waits start here. */
  eligibleAt: string | null;
  reason: string | null;
  /** Names of people it still waits for. */
  waitingFor: string[];
  /** People who were needed and finished (or stopped counting). */
  counted: string[];
}

const maxIso = (dates: (string | null | undefined)[]): string | null => {
  let best: number | null = null;
  for (const d of dates) {
    const t = d ? Date.parse(d) : NaN;
    if (!Number.isNaN(t) && (best === null || t > best)) best = t;
  }
  return best === null ? null : new Date(best).toISOString();
};

/** The people the "others" setting refers to. */
export function othersPool(policy: JanitorWatchers['others'], people: PersonProgress[]): PersonProgress[] {
  switch (policy) {
    case 'none':
      return [];
    case 'active':
      return people.filter((p) => p.started || p.done);
    case 'watchlisted':
      return people.filter((p) => p.watchlisted);
    case 'active_or_watchlisted':
      return people.filter((p) => p.started || p.done || p.watchlisted);
    case 'all_linked':
      return people;
  }
}

export function evaluatePolicy(input: PolicyInput): PolicyResult {
  const { watchers: w, now } = input;
  const waitingFor: string[] = [];
  const counted: string[] = [];
  const dates: (string | null)[] = [];

  if (w.requester === 'required') {
    if (input.unknownRequesters.length > 0) {
      return { eligible: false, eligibleAt: null, reason: `Requested by ${input.unknownRequesters.join(', ')}, who has no JellyWatcher account, so their viewing is unknown.`, waitingFor: input.unknownRequesters, counted };
    }
    if (input.requesters.length === 0) return { eligible: false, eligibleAt: null, reason: 'Nobody known requested it.', waitingFor, counted };
    for (const r of input.requesters) {
      if (r.done) {
        counted.push(r.name);
        dates.push(r.doneAt);
      } else waitingFor.push(r.name);
    }
  }

  // With the requester ignored, requesters are judged like everyone else.
  const people = w.requester === 'required' ? input.others : [...input.requesters, ...input.others];
  const pool = othersPool(w.others, people);
  const requesterDone = maxIso(dates);
  const base = requesterDone ?? input.requestedAt;

  /** A person who stopped watching long enough no longer holds it back. */
  const droppedAt = (p: PersonProgress): string | null => {
    if (w.dropAfterDays === null) return null;
    const from = maxIso([p.lastActivity, base]);
    if (!from) return null;
    const at = Date.parse(from) + w.dropAfterDays * 86400_000;
    return at <= now.getTime() ? new Date(at).toISOString() : null;
  };

  if (w.others !== 'none') {
    if (w.othersMode === 'all') {
      if (pool.length === 0 && w.requester === 'ignored') return { eligible: false, eligibleAt: null, reason: 'Nobody has watched it yet.', waitingFor, counted };
      for (const p of pool) {
        if (p.done) {
          counted.push(p.name);
          dates.push(p.doneAt);
          continue;
        }
        const dropped = droppedAt(p);
        if (dropped) {
          counted.push(`${p.name} (inactive)`);
          dates.push(dropped);
        } else waitingFor.push(p.name);
      }
    } else {
      const done = pool.filter((p) => p.done).sort((a, b) => Date.parse(a.doneAt ?? '') - Date.parse(b.doneAt ?? ''));
      const needed = Math.max(1, Math.min(w.atLeast, pool.length || w.atLeast));
      if (done.length >= needed) {
        const nth = done[needed - 1]!;
        counted.push(...done.slice(0, needed).map((p) => p.name));
        dates.push(nth.doneAt);
      } else {
        const missing = needed - done.length;
        return {
          eligible: false,
          eligibleAt: null,
          reason: waitingFor.length
            ? `Waiting for ${waitingFor.join(', ')}, and ${missing} more ${missing === 1 ? 'person' : 'people'} to finish it.`
            : `Waiting for ${missing} more ${missing === 1 ? 'person' : 'people'} to finish it.`,
          waitingFor: [...waitingFor, ...pool.filter((p) => !p.done).map((p) => p.name)],
          counted,
        };
      }
    }
  }

  if (waitingFor.length > 0) return { eligible: false, eligibleAt: null, reason: `Waiting for ${waitingFor.join(', ')} to finish it.`, waitingFor, counted };
  const eligibleAt = maxIso(dates) ?? input.requestedAt ?? now.toISOString();
  return { eligible: true, eligibleAt: Date.parse(eligibleAt) > now.getTime() ? now.toISOString() : eligibleAt, reason: null, waitingFor, counted };
}
