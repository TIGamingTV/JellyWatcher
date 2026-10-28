import type { Logger } from 'pino';
import { nowIso, parseJson, type DB } from '../db/index.js';
import { errorMessage } from '../http/errors.js';
import { scrub } from '../logger.js';

export type JobName = 'lists' | 'jellyfin' | 'seerr' | 'metadata' | 'match' | 'cleanup';

export interface JobResult {
  runId: number;
  status: 'ok' | 'partial' | 'error' | 'skipped';
  stats: Record<string, unknown>;
  error: string | null;
}

export type JobFn = () => Promise<{ status?: 'ok' | 'partial' | 'skipped'; stats?: Record<string, unknown> } | void>;

/**
 * Runs sync jobs with single-flight semantics: a second trigger while a job (with the same scope) is
 * running joins the running execution instead of starting a parallel one. Every run is recorded.
 */
export class JobRunner {
  private running = new Map<string, Promise<JobResult>>();

  constructor(
    private readonly db: DB,
    private readonly log: Logger,
  ) {}

  isRunning(job: JobName, scope?: string): boolean {
    return this.running.has(`${job}:${scope ?? ''}`);
  }

  runningJobs(): string[] {
    return [...this.running.keys()];
  }

  run(job: JobName, trigger: 'schedule' | 'manual' | 'event' | 'startup', fn: JobFn, scope?: string): Promise<JobResult> {
    const key = `${job}:${scope ?? ''}`;
    const existing = this.running.get(key);
    if (existing) return existing;

    const runId = Number(
      this.db.prepare("INSERT INTO sync_runs (job, scope, trigger, status, started_at) VALUES (?, ?, ?, 'running', ?)").run(job, scope ?? null, trigger, nowIso()).lastInsertRowid,
    );
    const started = Date.now();
    const p = (async (): Promise<JobResult> => {
      try {
        const res = (await fn()) ?? {};
        const status = res.status ?? 'ok';
        const stats = { ...(res.stats ?? {}), durationMs: Date.now() - started };
        this.finish(runId, status, stats, null);
        this.log.info({ job, scope, status, stats }, 'sync job finished');
        return { runId, status, stats, error: null };
      } catch (err) {
        const message = scrub(errorMessage(err)).slice(0, 500);
        this.finish(runId, 'error', { durationMs: Date.now() - started }, message);
        this.log.warn({ job, scope, err: message }, 'sync job failed');
        return { runId, status: 'error', stats: {}, error: message };
      } finally {
        this.running.delete(key);
      }
    })();
    this.running.set(key, p);
    return p;
  }

  private finish(runId: number, status: string, stats: Record<string, unknown>, error: string | null): void {
    this.db.prepare('UPDATE sync_runs SET status = ?, finished_at = ?, stats = ?, error = ? WHERE id = ?').run(status, nowIso(), JSON.stringify(stats), error, runId);
  }

  lastRun(job: JobName, scope?: string) {
    const row = this.db
      .prepare('SELECT * FROM sync_runs WHERE job = ? AND scope IS ? ORDER BY id DESC LIMIT 1')
      .get(job, scope ?? null) as { id: number; status: string; started_at: string; finished_at: string | null; error: string | null; stats: string | null } | undefined;
    return row ? { ...row, stats: parseJson(row.stats, {}) } : null;
  }

  /** Consecutive failures of the most recent runs, for backoff. */
  consecutiveFailures(job: JobName): number {
    const rows = this.db.prepare("SELECT status FROM sync_runs WHERE job = ? AND scope IS NULL AND status != 'running' ORDER BY id DESC LIMIT 6").all(job) as { status: string }[];
    let n = 0;
    for (const r of rows) {
      if (r.status !== 'error') break;
      n++;
    }
    return n;
  }

  history(limit = 100, job?: string) {
    const rows = (job
      ? this.db.prepare('SELECT * FROM sync_runs WHERE job = ? ORDER BY id DESC LIMIT ?').all(job, limit)
      : this.db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT ?').all(limit)) as { stats: string | null }[];
    return rows.map((r) => ({ ...r, stats: parseJson(r.stats, {}) }));
  }

  /** Marks runs left in 'running' by a previous process (crash/restart) as interrupted. */
  recoverInterrupted(): void {
    this.db.prepare("UPDATE sync_runs SET status = 'error', error = 'Interrupted by a restart', finished_at = ? WHERE status = 'running'").run(nowIso());
    this.db.prepare("UPDATE lists SET last_status = 'error', last_error = 'Interrupted by a restart' WHERE last_status = 'running'").run();
  }

  prune(days = 90): void {
    this.db.prepare('DELETE FROM sync_runs WHERE started_at < ?').run(new Date(Date.now() - days * 86400_000).toISOString());
  }
}
