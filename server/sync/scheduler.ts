import type { AppContext } from '../context.js';
import type { JobName } from '../services/jobs.js';
import { syncJellyfin } from './jellyfin.js';
import { syncDueLists } from './lists.js';
import { syncMetadata } from './metadata.js';
import { syncSeerr } from './seerr.js';

/** Runs the matcher until nothing is pending or progress stops. */
export async function runMatch(ctx: AppContext) {
  const meta = ctx.metadata();
  const totals = { processed: 0, matched: 0, review: 0, unmatched: 0, ignored: 0, deferred: 0 };
  for (let i = 0; i < 20; i++) {
    const s = await ctx.matcher.run(meta, 400);
    for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += s[k];
    if (s.processed === 0 || s.deferred === s.processed) break;
  }
  return { status: totals.deferred > 0 ? ('partial' as const) : ('ok' as const), stats: totals };
}

export const JOBS: Record<Exclude<JobName, 'cleanup'>, (ctx: AppContext) => Promise<{ status?: 'ok' | 'partial' | 'skipped'; stats?: Record<string, unknown> }>> = {
  lists: async (ctx) => {
    const r = await syncDueLists(ctx);
    // New items need matching and metadata right away.
    void triggerJob(ctx, 'match', 'event');
    return r;
  },
  jellyfin: syncJellyfin,
  seerr: async (ctx) => {
    const r = await syncSeerr(ctx);
    void triggerJob(ctx, 'metadata', 'event');
    return r;
  },
  metadata: (ctx) => syncMetadata(ctx),
  match: async (ctx) => {
    const r = await runMatch(ctx);
    void triggerJob(ctx, 'metadata', 'event');
    return r;
  },
};

export function triggerJob(ctx: AppContext, job: Exclude<JobName, 'cleanup'>, trigger: 'manual' | 'event' | 'schedule' | 'startup' = 'manual') {
  return ctx.jobs.run(job, trigger, () => JOBS[job](ctx));
}

function intervalFor(ctx: AppContext, job: JobName): number {
  const s = ctx.settings.all();
  switch (job) {
    case 'lists':
      return 15; // checks which lists are due; each list has its own interval
    case 'jellyfin':
      return s['sync.jellyfinIntervalMinutes'];
    case 'seerr':
      return s['sync.seerrIntervalMinutes'];
    case 'metadata':
      return s['sync.metadataIntervalMinutes'];
    case 'match':
      return 60;
    case 'cleanup':
      return 24 * 60;
  }
}

/**
 * Lightweight in-process scheduler. Every minute it starts jobs whose interval has elapsed since their
 * last run. Failing jobs back off exponentially (5, 10, 20 ... minutes, capped at the interval).
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly ctx: AppContext) {}

  start(): void {
    if (this.timer) return;
    const kick = setTimeout(() => this.tick('startup'), 5_000);
    kick.unref();
    this.timer = setInterval(() => this.tick('schedule'), 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick(trigger: 'schedule' | 'startup' = 'schedule'): void {
    const jobs: JobName[] = ['seerr', 'jellyfin', 'lists', 'match', 'metadata', 'cleanup'];
    for (const job of jobs) {
      if (this.ctx.jobs.isRunning(job)) continue;
      const last = this.ctx.jobs.lastRun(job);
      let wait = intervalFor(this.ctx, job);
      const failures = this.ctx.jobs.consecutiveFailures(job);
      if (failures > 0) wait = Math.min(wait, 5 * 2 ** (failures - 1));
      const lastAt = last ? Date.parse(last.started_at) : 0;
      if (Date.now() - lastAt < wait * 60_000) continue;
      if (job === 'cleanup') {
        void this.ctx.jobs.run('cleanup', trigger, async () => cleanup(this.ctx));
        continue;
      }
      if (job === 'match' && this.ctx.matcher.pendingCount() === 0) continue;
      void triggerJob(this.ctx, job, trigger);
    }
  }
}

function cleanup(ctx: AppContext) {
  const now = new Date().toISOString();
  const sessions = ctx.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now).changes;
  ctx.jobs.prune(90);
  ctx.activity.prune(180);
  // Titles no longer referenced anywhere.
  const titles = ctx.db
    .prepare(
      `DELETE FROM titles WHERE id NOT IN (SELECT title_id FROM list_items WHERE title_id IS NOT NULL)
         AND id NOT IN (SELECT title_id FROM jellyfin_items WHERE title_id IS NOT NULL)
         AND id NOT IN (SELECT title_id FROM requests)
         AND id NOT IN (SELECT title_id FROM match_resolutions WHERE title_id IS NOT NULL)
         AND id NOT IN (SELECT title_id FROM watch_history)
         AND id NOT IN (SELECT title_id FROM watched_episodes)
         AND updated_at < ?`,
    )
    .run(new Date(Date.now() - 7 * 86400_000).toISOString()).changes;
  return { stats: { sessions, titles } };
}
