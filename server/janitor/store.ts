import { nowIso, parseJson, type DB } from '../db/index.js';
import { ApiError } from '../http/errors.js';
import { DEFAULT_MATCH, DEFAULT_NEXT_SEASON, DEFAULT_WATCHERS, type CandidateState, type JanitorRule, type JanitorRuleInput, type JanitorStep, type LogOutcome } from '../../shared/janitor.js';

interface RuleRow {
  id: number;
  name: string;
  enabled: number;
  media_type: 'movie' | 'tv';
  unit: 'movie' | 'season' | 'series';
  mode: 'dry_run' | 'approval' | 'auto';
  position: number;
  match: string;
  watchers: string;
  next_season: string;
  steps: string;
  created_at: string;
  updated_at: string;
}

export interface CandidateContext {
  title?: string;
  requestIds?: number[];
  seerrRequestIds?: number[];
  requesterIds?: number[];
  requesters?: string[];
  sizeBytes?: number | null;
  /** Date shown in notifications and the overview: when the next deletion is due. */
  dueAt?: string | null;
  freedBytes?: number;
  /** A notification already asked for approval (the warning before the deletion). */
  approvalAsked?: boolean;
  /** Why it is parked at a gate that is checked again every day. */
  parked?: string | null;
}

export interface CandidateRow {
  id: number;
  rule_id: number;
  title_id: number;
  season: number;
  state: CandidateState;
  step_index: number;
  anchor_at: string;
  eligible_at: string;
  next_run_at: string | null;
  dry_run: number;
  acted: number;
  approved_at: string | null;
  attempts: number;
  last_error: string | null;
  context: string;
  created_at: string;
  updated_at: string;
}

export interface ExclusionRow {
  id: number;
  title_id: number;
  season: number;
  rule_id: number | null;
  until: string | null;
  reason: string | null;
  created_by: number | null;
  created_at: string;
}

const toRule = (r: RuleRow): JanitorRule => ({
  id: r.id,
  name: r.name,
  enabled: r.enabled === 1,
  mediaType: r.media_type,
  unit: r.unit,
  mode: r.mode,
  position: r.position,
  match: { ...DEFAULT_MATCH, ...parseJson(r.match, {}) },
  watchers: { ...DEFAULT_WATCHERS, ...parseJson(r.watchers, {}) },
  nextSeason: { ...DEFAULT_NEXT_SEASON, ...parseJson(r.next_season, {}) },
  steps: parseJson<JanitorStep[]>(r.steps, []),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class JanitorStore {
  constructor(private readonly db: DB) {}

  // ---- Rules

  rules(): JanitorRule[] {
    return (this.db.prepare('SELECT * FROM janitor_rules ORDER BY position, id').all() as RuleRow[]).map(toRule);
  }

  rule(id: number): JanitorRule | null {
    const r = this.db.prepare('SELECT * FROM janitor_rules WHERE id = ?').get(id) as RuleRow | undefined;
    return r ? toRule(r) : null;
  }

  createRule(input: JanitorRuleInput): JanitorRule {
    const now = nowIso();
    const pos = (this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM janitor_rules').get() as { p: number }).p;
    const id = Number(
      this.db
        .prepare('INSERT INTO janitor_rules (name, enabled, media_type, unit, mode, position, match, watchers, next_season, steps, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(input.name, input.enabled ? 1 : 0, input.mediaType, input.unit, input.mode, pos, JSON.stringify(input.match), JSON.stringify(input.watchers), JSON.stringify(input.nextSeason), JSON.stringify(input.steps), now, now).lastInsertRowid,
    );
    return this.rule(id)!;
  }

  /**
   * Saves a rule. Candidates that have not deleted anything yet start over (their timers keep
   * counting from when people finished watching), so a changed rule never acts on an old plan.
   */
  updateRule(id: number, input: JanitorRuleInput): JanitorRule {
    const cur = this.rule(id);
    if (!cur) throw new ApiError(404, 'not_found', 'Rule not found.');
    if (cur.mediaType !== input.mediaType || cur.unit !== input.unit) {
      if ((this.db.prepare('SELECT COUNT(*) AS n FROM janitor_candidates WHERE rule_id = ? AND acted = 1 AND state NOT IN (\'done\')').get(id) as { n: number }).n > 0) {
        throw new ApiError(409, 'rule_busy', 'This rule is in the middle of deleting something. Wait until it finishes before changing what it handles.');
      }
    }
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE janitor_rules SET name = ?, enabled = ?, media_type = ?, unit = ?, mode = ?, match = ?, watchers = ?, next_season = ?, steps = ?, updated_at = ? WHERE id = ?')
        .run(input.name, input.enabled ? 1 : 0, input.mediaType, input.unit, input.mode, JSON.stringify(input.match), JSON.stringify(input.watchers), JSON.stringify(input.nextSeason), JSON.stringify(input.steps), nowIso(), id);
      this.resetCandidates(id);
    })();
    return this.rule(id)!;
  }

  /** Drops candidates of a rule that did not delete anything for real (dry runs included). */
  resetCandidates(ruleId: number): number {
    return this.db.prepare("DELETE FROM janitor_candidates WHERE rule_id = ? AND (acted = 0 OR dry_run = 1) AND state != 'running'").run(ruleId).changes;
  }

  setEnabled(id: number, enabled: boolean): void {
    this.db.prepare('UPDATE janitor_rules SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, nowIso(), id);
  }

  deleteRule(id: number): void {
    this.db.prepare('DELETE FROM janitor_rules WHERE id = ?').run(id);
  }

  reorder(ids: number[]): void {
    const stmt = this.db.prepare('UPDATE janitor_rules SET position = ? WHERE id = ?');
    this.db.transaction(() => ids.forEach((id, i) => stmt.run(i, id)))();
  }

  // ---- Candidates

  candidate(id: number): CandidateRow | undefined {
    return this.db.prepare('SELECT * FROM janitor_candidates WHERE id = ?').get(id) as CandidateRow | undefined;
  }

  candidateFor(ruleId: number, titleId: number, season: number): CandidateRow | undefined {
    return this.db.prepare('SELECT * FROM janitor_candidates WHERE rule_id = ? AND title_id = ? AND season = ?').get(ruleId, titleId, season) as CandidateRow | undefined;
  }

  insertCandidate(c: { ruleId: number; titleId: number; season: number; eligibleAt: string; dryRun: boolean; context: CandidateContext; now: string }): number {
    return Number(
      this.db
        .prepare(
          `INSERT INTO janitor_candidates (rule_id, title_id, season, state, step_index, anchor_at, eligible_at, next_run_at, dry_run, context, created_at, updated_at)
           VALUES (?, ?, ?, 'waiting', 0, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(c.ruleId, c.titleId, c.season, c.eligibleAt, c.eligibleAt, c.now, c.dryRun ? 1 : 0, JSON.stringify(c.context), c.now, c.now).lastInsertRowid,
    );
  }

  saveCandidate(c: CandidateRow): void {
    this.db
      .prepare(
        `UPDATE janitor_candidates SET state = ?, step_index = ?, anchor_at = ?, eligible_at = ?, next_run_at = ?, acted = ?, approved_at = ?, attempts = ?, last_error = ?, context = ?, updated_at = ? WHERE id = ?`,
      )
      .run(c.state, c.step_index, c.anchor_at, c.eligible_at, c.next_run_at, c.acted, c.approved_at, c.attempts, c.last_error, c.context, nowIso(), c.id);
  }

  removeCandidate(id: number): void {
    this.db.prepare('DELETE FROM janitor_candidates WHERE id = ?').run(id);
  }

  candidates(states?: CandidateState[]): CandidateRow[] {
    if (!states?.length) return this.db.prepare('SELECT * FROM janitor_candidates ORDER BY id DESC').all() as CandidateRow[];
    return this.db.prepare(`SELECT * FROM janitor_candidates WHERE state IN (${states.map(() => '?').join(',')}) ORDER BY next_run_at IS NULL, next_run_at, id`).all(...states) as CandidateRow[];
  }

  forTitle(titleId: number): CandidateRow[] {
    return this.db.prepare('SELECT * FROM janitor_candidates WHERE title_id = ? ORDER BY season, id').all(titleId) as CandidateRow[];
  }

  // ---- Exclusions

  exclusions(): ExclusionRow[] {
    return this.db.prepare('SELECT * FROM janitor_exclusions ORDER BY created_at DESC, id DESC').all() as ExclusionRow[];
  }

  addExclusion(e: { titleId: number; season: number; ruleId: number | null; until: string | null; reason: string | null; userId: number | null }): number {
    return Number(
      this.db
        .prepare('INSERT INTO janitor_exclusions (title_id, season, rule_id, until, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(e.titleId, e.season, e.ruleId, e.until, e.reason, e.userId, nowIso()).lastInsertRowid,
    );
  }

  removeExclusion(id: number): boolean {
    return this.db.prepare('DELETE FROM janitor_exclusions WHERE id = ?').run(id).changes > 0;
  }

  /** Active exclusions: title → rows. */
  activeExclusions(now: Date): Map<number, ExclusionRow[]> {
    const rows = this.db.prepare('SELECT * FROM janitor_exclusions WHERE until IS NULL OR until > ?').all(now.toISOString()) as ExclusionRow[];
    const out = new Map<number, ExclusionRow[]>();
    for (const r of rows) out.set(r.title_id, [...(out.get(r.title_id) ?? []), r]);
    return out;
  }

  pruneExclusions(now: Date): number {
    return this.db.prepare('DELETE FROM janitor_exclusions WHERE until IS NOT NULL AND until <= ?').run(now.toISOString()).changes;
  }

  // ---- Seasons the Janitor added to requests

  /** Request id → seasons the Janitor added to it. */
  addedSeasons(): Map<number, number[]> {
    const out = new Map<number, number[]>();
    for (const r of this.db.prepare('SELECT request_id, season FROM janitor_request_seasons ORDER BY season').all() as { request_id: number; season: number }[]) {
      out.set(r.request_id, [...(out.get(r.request_id) ?? []), r.season]);
    }
    return out;
  }

  addSeason(e: { requestIds: number[]; season: number; titleId: number; ruleId: number; monitored: boolean; now: string }): void {
    const stmt = this.db.prepare('INSERT OR IGNORE INTO janitor_request_seasons (request_id, season, title_id, rule_id, monitored, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    this.db.transaction(() => e.requestIds.forEach((id) => stmt.run(id, e.season, e.titleId, e.ruleId, e.monitored ? 1 : 0, e.now)))();
  }

  /** Seasons the Janitor added to a title's requests, with who requested them. */
  addedSeasonsFor(titleId: number) {
    return this.db
      .prepare(
        `SELECT s.season, s.monitored, s.created_at, r.requested_by, u.display_name FROM janitor_request_seasons s
           JOIN requests r ON r.id = s.request_id LEFT JOIN users u ON u.id = r.user_id
          WHERE s.title_id = ? AND r.request_status IN (2, 5) ORDER BY s.season, s.created_at`,
      )
      .all(titleId) as { season: number; monitored: number; created_at: string; requested_by: string | null; display_name: string | null }[];
  }

  // ---- Log

  log(e: { candidateId?: number | null; ruleId?: number | null; ruleName?: string | null; titleId?: number | null; title: string; season?: number; step: string; outcome: LogOutcome; message?: string | null; freedBytes?: number; at?: string }): void {
    this.db
      .prepare('INSERT INTO janitor_log (candidate_id, rule_id, rule_name, title_id, title, season, step, outcome, message, freed_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(e.candidateId ?? null, e.ruleId ?? null, e.ruleName ?? null, e.titleId ?? null, e.title, e.season ?? -1, e.step, e.outcome, e.message?.slice(0, 1000) ?? null, e.freedBytes ?? 0, e.at ?? nowIso());
  }

  /** The latest log entry of a step for a title's season (runs that would repeat themselves log once). */
  lastLog(titleId: number, season: number, step: string): { outcome: LogOutcome; message: string | null } | undefined {
    return this.db.prepare('SELECT outcome, message FROM janitor_log WHERE title_id = ? AND season = ? AND step = ? ORDER BY id DESC LIMIT 1').get(titleId, season, step) as { outcome: LogOutcome; message: string | null } | undefined;
  }

  logEntries(limit = 100, beforeId?: number) {
    return (beforeId
      ? this.db.prepare('SELECT * FROM janitor_log WHERE id < ? ORDER BY id DESC LIMIT ?').all(beforeId, limit)
      : this.db.prepare('SELECT * FROM janitor_log ORDER BY id DESC LIMIT ?').all(limit)) as {
      id: number;
      candidate_id: number | null;
      rule_id: number | null;
      rule_name: string | null;
      title_id: number | null;
      title: string;
      season: number;
      step: string;
      outcome: LogOutcome;
      message: string | null;
      freed_bytes: number;
      created_at: string;
    }[];
  }

  freedBytes(sinceIso?: string): number {
    const r = (sinceIso
      ? this.db.prepare("SELECT COALESCE(SUM(freed_bytes), 0) AS n FROM janitor_log WHERE outcome = 'ok' AND created_at >= ?").get(sinceIso)
      : this.db.prepare("SELECT COALESCE(SUM(freed_bytes), 0) AS n FROM janitor_log WHERE outcome = 'ok'").get()) as { n: number };
    return r.n;
  }

  pruneLog(days = 365): number {
    return this.db.prepare('DELETE FROM janitor_log WHERE created_at < ?').run(new Date(Date.now() - days * 86400_000).toISOString()).changes;
  }
}
