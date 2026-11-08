import type { AppContext } from '../context.js';
import { nowIso, parseJson } from '../db/index.js';
import { errorMessage } from '../http/errors.js';
import { scrub } from '../logger.js';
import { sonarrSeasons } from '../providers/sonarr.js';
import { triggerJob } from '../sync/scheduler.js';
import { DESTRUCTIVE_STEPS, GATE_LABEL, STEP_LABEL, unitLabel, type JanitorRule, type JanitorStep, type JanitorUnit } from '../../shared/janitor.js';
import { formatBytes, formatDate, notifyAdmin, renderTemplate } from './notify.js';
import { evaluatePolicy } from './policy.js';
import { JanitorStore, type CandidateContext, type CandidateRow, type ExclusionRow } from './store.js';
import { arrIndex, buildUnits, findSeries, linkedPeople, personName, progressFor, type ArrSnapshot, type Unit, type UnitRequest } from './units.js';

/**
 * The Janitor: finds requests everyone needed has finished watching, then walks each through its
 * rule's steps (waits, notifications, approval, gates, deletions in Sonarr, Radarr and Seerr).
 * Runs as the `janitor` job. Every step is written to janitor_log; deletions that fail are retried
 * with backoff and reported.
 */

const MAX_ATTEMPTS = 5;

export interface EvaluationRow {
  ruleId: number;
  titleId: number;
  title: string;
  season: number;
  mediaType: 'movie' | 'tv';
  requesters: string[];
  status: 'eligible' | 'waiting' | 'excluded' | 'incomplete' | 'not_in_library' | 'claimed';
  reason: string | null;
  eligibleAt: string | null;
  sizeBytes: number | null;
  candidateId: number | null;
  /** Nothing to show or clean up: gone from Jellyfin and Sonarr/Radarr, or a season the request moved past. */
  hidden?: boolean;
}

/** Reads Sonarr and Radarr once, only when a rule needs them. */
export async function loadArr(ctx: AppContext, rules: Pick<JanitorRule, 'mediaType'>[]): Promise<ArrSnapshot> {
  const errors: string[] = [];
  const needTv = rules.some((r) => r.mediaType === 'tv');
  const needMovies = rules.some((r) => r.mediaType === 'movie');
  const sonarr = needTv ? ctx.integrations.sonarr() : null;
  const radarr = needMovies ? ctx.integrations.radarr() : null;
  const [series, movies] = await Promise.all([
    sonarr
      ? sonarr.allSeries().then(
          (s) => {
            ctx.integrations.markOk('sonarr');
            return s;
          },
          (err) => {
            ctx.integrations.markError('sonarr', err);
            errors.push(`Sonarr: ${errorMessage(err)}`);
            return null;
          },
        )
      : null,
    radarr
      ? radarr.movies().then(
          (m) => {
            ctx.integrations.markOk('radarr');
            return m;
          },
          (err) => {
            ctx.integrations.markError('radarr', err);
            errors.push(`Radarr: ${errorMessage(err)}`);
            return null;
          },
        )
      : null,
  ]);
  return arrIndex(series, movies, errors);
}

/** `season` -1 stands for the whole title (movies, whole shows): keeping any season of it counts. */
function excludedBy(ex: ExclusionRow[] | undefined, ruleId: number, season: number): ExclusionRow | null {
  return ex?.find((e) => (e.rule_id === null || e.rule_id === ruleId) && (e.season === -1 || season === -1 || e.season === season)) ?? null;
}

function matches(rule: JanitorRule, unit: Unit): boolean {
  const m = rule.match;
  if (m.requestedBy.length && !unit.requests.some((r) => r.userId !== null && m.requestedBy.includes(r.userId))) return false;
  if (m.is4k === 'yes' && !unit.requests.some((r) => r.is4k)) return false;
  if (m.is4k === 'no' && unit.requests.every((r) => r.is4k)) return false;
  if (rule.mediaType === 'tv' && m.seriesStatus !== 'any') {
    if (!unit.seriesStatus) return false;
    const ended = unit.seriesStatus === 'ended';
    if ((m.seriesStatus === 'ended') !== ended) return false;
  }
  return true;
}

/** The unit's requests this rule counts (its 4K filter). */
const ruleRequests = (rule: JanitorRule, unit: Unit): UnitRequest[] => (rule.match.is4k === 'any' ? unit.requests : unit.requests.filter((r) => r.is4k === (rule.match.is4k === 'yes')));

interface Judged {
  row: EvaluationRow;
  unit: Unit;
  context: CandidateContext;
}

/** Judges one rule's units. `claimed` holds titles an earlier rule already handles. */
function judgeRule(ctx: AppContext, rule: JanitorRule, units: Unit[], arr: ArrSnapshot, exclusions: Map<number, ExclusionRow[]>, claimed: Set<number>, now: Date): Judged[] {
  const people = linkedPeople(ctx);
  const out: Judged[] = [];
  for (const unit of units) {
    if (!matches(rule, unit)) continue;
    // The 4K filter narrows which requests count for this rule.
    const requests = ruleRequests(rule, unit);
    const requesterIds = [...new Set(requests.map((r) => r.userId).filter((id): id is number => id !== null))];
    const known = requesterIds.map((id) => ({ id, name: personName(ctx, id) })).filter((p): p is { id: number; name: string } => p.name !== null);
    const unknown = [...new Set(requests.filter((r) => r.userId === null || !known.some((k) => k.id === r.userId)).map((r) => r.requestedBy ?? 'someone'))];
    const requesterNames = [...known.map((k) => k.name), ...unknown];
    const context: CandidateContext = {
      title: unit.title,
      requestIds: requests.map((r) => r.id),
      seerrRequestIds: requests.map((r) => r.seerrRequestId),
      requesterIds,
      requesters: requesterNames,
      sizeBytes: unit.sizeBytes,
    };
    const row: EvaluationRow = {
      ruleId: rule.id,
      titleId: unit.titleId,
      title: unit.title,
      season: unit.season,
      mediaType: unit.mediaType,
      requesters: requesterNames,
      status: 'waiting',
      reason: null,
      eligibleAt: null,
      sizeBytes: unit.sizeBytes,
      candidateId: null,
    };
    out.push({ row, unit, context });
    if (claimed.has(unit.titleId)) {
      row.status = 'claimed';
      row.reason = 'An earlier rule handles this title.';
      continue;
    }
    const ex = excludedBy(exclusions.get(unit.titleId), rule.id, unit.season);
    if (ex) {
      row.status = 'excluded';
      row.reason = ex.until ? `Kept until ${formatDate(ex.until)}${ex.reason ? `: ${ex.reason}` : ''}.` : `Kept${ex.reason ? `: ${ex.reason}` : ''}.`;
      continue;
    }
    if (!unit.inLibrary) {
      row.status = 'not_in_library';
      const later = unit.kind === 'season' ? Math.max(-1, ...requests.flatMap((r) => r.seasons)) : -1;
      // Deleted from Radarr/Sonarr too (by hand, or by Seerr): nothing left to clean up.
      const gone = unit.kind === 'movie' ? arr.radarr !== null && unit.radarrId === null : arr.sonarr !== null && unit.sonarrId === null;
      row.hidden = gone || later > unit.season;
      row.reason = gone
        ? `Gone from Jellyfin and ${unit.kind === 'movie' ? 'Radarr' : 'Sonarr'}.`
        : unit.kind === 'movie'
          ? 'Not in Jellyfin.'
          : later > unit.season
            ? `No longer in Jellyfin; the request continues with season ${later}.`
            : 'No episodes of it are in Jellyfin.';
      continue;
    }
    if (unit.incomplete) {
      row.status = 'incomplete';
      row.reason = unit.incomplete;
      continue;
    }
    const requesters = known.map((p) => progressFor(ctx, p, unit));
    const others = people.filter((p) => !requesterIds.includes(p.id)).map((p) => progressFor(ctx, p, unit));
    const requestedAt = requests.map((r) => r.createdAt).sort().at(-1) ?? null;
    const res = evaluatePolicy({ watchers: rule.watchers, requesters, unknownRequesters: unknown, others, requestedAt, now });
    if (res.eligible) {
      row.status = 'eligible';
      row.eligibleAt = res.eligibleAt;
    } else row.reason = res.reason;
  }
  // A title belongs to the first rule that matches it, whatever its state.
  for (const j of out) claimed.add(j.unit.titleId);
  return out;
}

/** What every rule would do right now, without changing anything (rule preview). */
export async function previewRules(ctx: AppContext, rules: JanitorRule[], now = new Date()): Promise<{ rows: EvaluationRow[]; errors: string[] }> {
  const store = new JanitorStore(ctx.db);
  const arr = await loadArr(ctx, rules);
  const exclusions = store.activeExclusions(now);
  const claimed = new Set<number>();
  const cache = new Map<JanitorUnit, Unit[]>();
  const rows: EvaluationRow[] = [];
  for (const rule of rules) {
    if (!cache.has(rule.unit)) cache.set(rule.unit, buildUnits(ctx, rule.unit, arr));
    for (const j of judgeRule(ctx, rule, cache.get(rule.unit)!, arr, exclusions, claimed, now)) {
      if (j.row.hidden) continue;
      j.row.candidateId = store.candidateFor(rule.id, j.unit.titleId, j.unit.season)?.id ?? null;
      rows.push(j.row);
    }
  }
  return { rows, errors: arr.errors };
}

export function inWindow(now: Date, start: string, end: string): boolean {
  if (!start || !end || start === end) return true;
  const m = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = start.split(':').map(Number) as [number, number];
  const [eh, em] = end.split(':').map(Number) as [number, number];
  const s = sh * 60 + sm;
  const e = eh * 60 + em;
  return s < e ? m >= s && m < e : m >= s || m < e;
}

const waitMs = (s: Extract<JanitorStep, { type: 'wait' }>) => (s.days * 24 + s.hours) * 3600_000;

/** Whether the steps from `from` on still stop for an approval that has not been given. */
export function approvalAhead(rule: Pick<JanitorRule, 'mode' | 'steps'>, c: Pick<CandidateRow, 'approved_at' | 'dry_run'>, from: number): boolean {
  if (c.approved_at || c.dry_run === 1) return false;
  const rest = rule.steps.slice(from);
  return rest.some((s) => s.type === 'approval') || (rule.mode === 'approval' && rest.some((s) => DESTRUCTIVE_STEPS.has(s.type)));
}

const APPROVE_HINT = 'Approve or keep it in JellyWatcher.';

/** When the next deletion after `from` is due, counting the waits before it. */
function nextDeletionAt(steps: JanitorStep[], from: number, anchor: Date): string | null {
  let t = anchor.getTime();
  for (let i = from; i < steps.length; i++) {
    const s = steps[i]!;
    if (s.type === 'wait') t += waitMs(s);
    else if (DESTRUCTIVE_STEPS.has(s.type)) return new Date(t).toISOString();
  }
  return null;
}

export interface RunStats {
  rules: number;
  units: number;
  eligible: number;
  created: number;
  cancelled: number;
  steps: number;
  deleted: number;
  wouldDelete: number;
  failed: number;
  awaitingApproval: number;
  freedBytes: number;
  /** Seasons added to requests (and monitored) by the next-season option. */
  nextSeasons: number;
  blocked?: string;
  errors?: string[];
}

export async function runJanitor(ctx: AppContext, opts: { now?: Date } = {}): Promise<{ status: 'ok' | 'partial' | 'skipped'; stats: Record<string, unknown> }> {
  if (!ctx.config.janitor) return { status: 'skipped', stats: { reason: 'JW_JANITOR is off' } };
  const now = opts.now ?? new Date();
  const store = new JanitorStore(ctx.db);
  const settings = ctx.settings.all();
  const rules = store.rules().filter((r) => r.enabled);
  const stats: RunStats = { rules: rules.length, units: 0, eligible: 0, created: 0, cancelled: 0, steps: 0, deleted: 0, wouldDelete: 0, failed: 0, awaitingApproval: 0, freedBytes: 0, nextSeasons: 0 };
  store.pruneExclusions(now);

  // ---- 1. Evaluate: create candidates for units that became eligible, drop those that no longer are.
  const arr = await loadArr(ctx, rules);
  if (arr.errors.length) stats.errors = arr.errors.map((e) => scrub(e).slice(0, 200));
  const exclusions = store.activeExclusions(now);
  const claimed = new Set<number>();
  const cache = new Map<JanitorUnit, Unit[]>();
  const seen = new Set<number>();
  const nowIsoStr = now.toISOString();
  const nextSeasonUnits: { rule: JanitorRule; unit: Unit }[] = [];
  // Requesters already past the seasons they asked for: those seasons join their request first.
  stats.nextSeasons += catchUp(ctx, store, rules, arr, now);
  // Without Sonarr data for shows (or Radarr for movies) the evaluation would be incomplete; keep what exists.
  const arrFailed = (rule: JanitorRule) => (rule.mediaType === 'tv' ? ctx.integrations.isReady('sonarr') && !arr.sonarr : ctx.integrations.isReady('radarr') && !arr.radarr);
  for (const rule of rules) {
    if (!cache.has(rule.unit)) cache.set(rule.unit, buildUnits(ctx, rule.unit, arr));
    const judged = judgeRule(ctx, rule, cache.get(rule.unit)!, arr, exclusions, claimed, now);
    stats.units += judged.length;
    for (const { row, unit, context } of judged) {
      if (rule.unit === 'season' && rule.nextSeason.enabled && row.status !== 'claimed' && unit.next) nextSeasonUnits.push({ rule, unit });
      const existing = store.candidateFor(rule.id, unit.titleId, unit.season);
      if (row.status === 'eligible') {
        stats.eligible++;
        const prev = existing ? parseJson<CandidateContext>(existing.context, {}) : null;
        const sameRequests = prev && JSON.stringify([...(prev.requestIds ?? [])].sort()) === JSON.stringify([...(context.requestIds ?? [])].sort());
        if (existing && (existing.state !== 'done' || sameRequests)) {
          seen.add(existing.id);
          if (existing.state !== 'done' && existing.state !== 'running') {
            existing.context = JSON.stringify({ ...prev, ...context, dueAt: prev?.dueAt ?? null, freedBytes: prev?.freedBytes ?? 0 });
            store.saveCandidate(existing);
          }
          continue;
        }
        if (existing) store.removeCandidate(existing.id); // done before, requested again since
        const id = store.insertCandidate({ ruleId: rule.id, titleId: unit.titleId, season: unit.season, eligibleAt: row.eligibleAt!, dryRun: rule.mode === 'dry_run', context, now: nowIsoStr });
        seen.add(id);
        stats.created++;
        store.log({ candidateId: id, ruleId: rule.id, ruleName: rule.name, titleId: unit.titleId, title: unit.title, season: unit.season, step: 'start', outcome: 'info', message: `Everyone needed finished it (${formatDate(row.eligibleAt)}).`, at: nowIsoStr });
      } else if (existing) {
        // Kept since: it stops even after deleting something (what is gone stays gone).
        const kept = row.status === 'excluded' && existing.state !== 'done' && existing.state !== 'running';
        if (!kept && (existing.acted || existing.state === 'done' || existing.state === 'running' || arrFailed(rule))) {
          seen.add(existing.id);
          continue;
        }
        store.removeCandidate(existing.id);
        stats.cancelled++;
        store.log({ candidateId: existing.id, ruleId: rule.id, ruleName: rule.name, titleId: unit.titleId, title: unit.title, season: unit.season, step: 'cancel', outcome: 'info', message: row.reason ?? 'No longer eligible.', at: nowIsoStr });
      }
    }
  }
  // Candidates no rule picked up this time (rule turned off, request gone) stop unless they already deleted something.
  for (const c of store.candidates(['waiting', 'awaiting_approval', 'failed'])) {
    if (seen.has(c.id) || c.acted) continue;
    const rule = rules.find((r) => r.id === c.rule_id);
    if (rule && arrFailed(rule)) continue;
    store.removeCandidate(c.id);
    stats.cancelled++;
    const ctxt = parseJson<CandidateContext>(c.context, {});
    store.log({ candidateId: c.id, ruleId: c.rule_id, ruleName: rule?.name ?? store.rule(c.rule_id)?.name, titleId: c.title_id, title: ctxt.title ?? `Title ${c.title_id}`, season: c.season, step: 'cancel', outcome: 'info', message: rule ? 'No longer matches the rule.' : 'The rule was turned off.', at: nowIsoStr });
  }

  // ---- 2. Next seasons for requesters close to the end of a season (not a deletion: no window or limit).
  if (!settings['janitor.paused']) {
    for (const { rule, unit } of nextSeasonUnits) {
      if (await nextSeason(ctx, store, rule, unit, now)) stats.nextSeasons++;
    }
  }

  // ---- 3. Advance candidates that are due.
  if (settings['janitor.paused']) {
    stats.blocked = 'paused';
    return { status: 'ok', stats: { ...stats } };
  }
  const jf = ctx.integrations.get('jellyfin');
  const staleMs = 3 * settings['sync.jellyfinIntervalMinutes'] * 60_000;
  // Freshness of the data is about the real clock, whatever time the run is evaluated for.
  const jellyfinFresh = jf.status === 'ok' && jf.lastOkAt !== null && Date.now() - Date.parse(jf.lastOkAt) <= Math.max(staleMs, 3600_000);
  const windowOpen = inWindow(now, settings['janitor.windowStart'], settings['janitor.windowEnd']);
  let actions = 0;
  let deletedSomething = false;

  const isDue = (c: CandidateRow) => !c.next_run_at || Date.parse(c.next_run_at) <= now.getTime();
  const due = store.candidates(['waiting']).filter(isDue);
  for (const { id } of due) {
    // Earlier candidates can take a while (Sonarr, Home Assistant): read everything again, so whatever
    // an administrator did meanwhile (keep, approve, remove, edit or turn off the rule, pause) counts.
    if (ctx.settings.get('janitor.paused')) {
      stats.blocked = 'paused';
      break;
    }
    const c = store.candidate(id);
    if (!c || c.state !== 'waiting' || !isDue(c)) continue;
    const rule = store.rule(c.rule_id);
    if (!rule?.enabled) continue;
    const ctxt = parseJson<CandidateContext>(c.context, {});
    const title = ctxt.title ?? `Title ${c.title_id}`;
    const label = unitLabel(title, c.season);
    const log = (step: string, outcome: Parameters<JanitorStore['log']>[0]['outcome'], message: string | null, freedBytes = 0) =>
      store.log({ candidateId: c.id, ruleId: rule.id, ruleName: rule.name, titleId: c.title_id, title, season: c.season, step, outcome, message, freedBytes, at: new Date().toISOString() });
    const save = () => {
      c.context = JSON.stringify(ctxt);
      store.saveCandidate(c);
    };
    // A rule switched to dry run stops deleting at once, also for cleanups that already deleted something.
    const dry = c.dry_run === 1 || rule.mode === 'dry_run';
    const prefix = dry ? '[Dry run] ' : '';
    c.state = 'running';
    save();
    let finished = false;
    let stop = false;
    let kept = false;

    while (!stop) {
      const step = rule.steps[c.step_index];
      if (!step) {
        finished = true;
        break;
      }
      const anchor = new Date(c.anchor_at);
      switch (step.type) {
        case 'wait': {
          const dueAt = anchor.getTime() + waitMs(step);
          if (now.getTime() < dueAt) {
            c.next_run_at = new Date(dueAt).toISOString();
            ctxt.dueAt = nextDeletionAt(rule.steps, c.step_index, anchor);
            stop = true;
            break;
          }
          c.anchor_at = new Date(dueAt).toISOString();
          c.step_index++;
          break;
        }
        case 'notify': {
          ctxt.dueAt = nextDeletionAt(rule.steps, c.step_index + 1, now);
          let msg = renderTemplate(step.message, { title, season: c.season, requester: (ctxt.requesters ?? []).join(', '), date: ctxt.dueAt, size: ctxt.sizeBytes ?? null, rule: rule.name });
          // The warning doubles as the approval request: one message, and it can be approved right away.
          if (approvalAhead(rule, c, c.step_index + 1)) {
            msg = `${msg} ${APPROVE_HINT}`;
            ctxt.approvalAsked = true;
          }
          const r = await notifyAdmin(ctx, `${prefix}JellyWatcher Janitor`, msg);
          log('notify', r.ok ? 'ok' : 'skipped', r.ok ? msg : `${msg} (not sent: ${r.error})`);
          c.step_index++;
          c.anchor_at = now.toISOString();
          stats.steps++;
          break;
        }
        case 'approval': {
          if (!c.approved_at) {
            c.state = 'awaiting_approval';
            c.next_run_at = null;
            ctxt.dueAt = null;
            stats.awaitingApproval++;
            log('approval', 'info', 'Waiting for an administrator to approve.');
            if (settings['janitor.notifyApproval'] && !ctxt.approvalAsked) await notifyAdmin(ctx, `${prefix}Janitor: approval needed`, `${label} is ready to be deleted (${formatBytes(ctxt.sizeBytes)}). ${APPROVE_HINT}`);
            save();
            stop = true;
            break;
          }
          c.step_index++;
          c.anchor_at = now.toISOString();
          break;
        }
        case 'gate': {
          const g = await gate(ctx, step.condition, c);
          if (g === 'unknown') {
            // Sonarr unreachable: try again later rather than guessing.
            const msg = 'Sonarr could not be reached, so the condition cannot be checked. Trying again every hour.';
            if (c.last_error !== msg) log('gate', 'failed', msg);
            c.last_error = msg;
            c.next_run_at = new Date(now.getTime() + 3600_000).toISOString();
            stop = true;
            break;
          }
          if (g === 'gone') {
            log('gate', 'info', 'The show is no longer in Sonarr; nothing more to do.');
            finished = true;
            stop = true;
            break;
          }
          if (g === 'no') {
            if (step.otherwise === 'recheck') {
              const note = `Waiting until ${GATE_LABEL[step.condition]}; checked again every day.`;
              if (ctxt.parked !== note) log('gate', 'info', note);
              ctxt.parked = note;
              ctxt.dueAt = null;
              c.next_run_at = new Date(now.getTime() + 86400_000).toISOString();
            } else {
              log('gate', 'info', `Stopped here: it is not true that ${GATE_LABEL[step.condition]}.`);
              finished = true;
            }
            stop = true;
            break;
          }
          ctxt.parked = null;
          c.last_error = null;
          c.step_index++;
          c.anchor_at = now.toISOString();
          break;
        }
        default: {
          // Destructive steps. Only a season's own files spare the rest of the show; everything else
          // removes the whole title, so keeping any of it stops the cleanup.
          const ex = excludedBy(store.activeExclusions(now).get(c.title_id), rule.id, step.type === 'sonarr_delete_season' ? c.season : -1);
          if (ex) {
            log('keep', 'info', `Kept, so it stopped before: ${STEP_LABEL[step.type]}.`);
            kept = true;
            stop = true;
            break;
          }
          if (rule.mode === 'approval' && !c.approved_at && !dry) {
            c.state = 'awaiting_approval';
            c.next_run_at = null;
            ctxt.dueAt = null;
            stats.awaitingApproval++;
            log('approval', 'info', `Waiting for approval before: ${STEP_LABEL[step.type]}.`);
            if (settings['janitor.notifyApproval'] && !ctxt.approvalAsked) await notifyAdmin(ctx, 'Janitor: approval needed', `${label} is ready to be deleted (${formatBytes(ctxt.sizeBytes)}). ${APPROVE_HINT}`);
            save();
            stop = true;
            break;
          }
          if (dry) {
            const what = await describe(ctx, step, c);
            log(step.type, 'would', what);
            stats.wouldDelete++;
            c.step_index++;
            c.anchor_at = now.toISOString();
            stats.steps++;
            break;
          }
          const blocked = !windowOpen ? 'outside the deletion window' : actions >= settings['janitor.maxActionsPerRun'] ? 'deletion limit for this run reached' : !jellyfinFresh ? 'Jellyfin data is not up to date' : null;
          if (blocked) {
            stats.blocked = blocked;
            c.next_run_at = now.toISOString();
            stop = true;
            break;
          }
          try {
            const r = await execute(ctx, step, c);
            stats.steps++;
            // Nothing there to delete: no deletion to count against the limit, and nothing done yet.
            if (!r.skipped) {
              actions++;
              stats.deleted++;
              stats.freedBytes += r.freedBytes;
              ctxt.freedBytes = (ctxt.freedBytes ?? 0) + r.freedBytes;
              c.acted = 1;
              deletedSomething = true;
            }
            c.attempts = 0;
            c.last_error = null;
            log(step.type, r.skipped ? 'skipped' : 'ok', r.message, r.freedBytes);
            c.step_index++;
            c.anchor_at = now.toISOString();
          } catch (err) {
            const message = scrub(errorMessage(err)).slice(0, 500);
            c.attempts++;
            c.last_error = message;
            stats.failed++;
            log(step.type, 'failed', message);
            if (c.attempts >= MAX_ATTEMPTS) {
              c.state = 'failed';
              c.next_run_at = null;
              if (settings['janitor.notifyFailed']) await notifyAdmin(ctx, 'Janitor: deletion failed', `${STEP_LABEL[step.type]} failed for ${label} ${MAX_ATTEMPTS} times: ${message}`);
              save();
            } else {
              c.next_run_at = new Date(now.getTime() + 15 * 60_000 * 2 ** (c.attempts - 1)).toISOString();
            }
            stop = true;
          }
        }
      }
      if (!stop) save();
    }

    if (kept) {
      // Like Keep in the UI: the cleanup goes; once a time-limited keep ends, it starts over.
      store.removeCandidate(c.id);
      continue;
    }
    if (finished) {
      c.state = 'done';
      c.next_run_at = null;
      ctxt.dueAt = null;
      log('finish', 'info', dry ? 'Dry run finished; nothing was deleted.' : c.acted ? `Finished. ${formatBytes(ctxt.freedBytes ?? 0)} freed.` : 'Finished.');
      if (!dry && c.acted && settings['janitor.notifyDone']) await notifyAdmin(ctx, 'Janitor: cleaned up', `${label} was deleted (${formatBytes(ctxt.freedBytes ?? 0)} freed).`);
      save();
    } else if (c.state === 'running') {
      c.state = 'waiting';
      save();
    }
  }

  if (deletedSomething) {
    void triggerJob(ctx, 'seerr', 'event');
    void triggerJob(ctx, 'jellyfin', 'event');
  }
  return { status: stats.failed > 0 || arr.errors.length > 0 ? 'partial' : 'ok', stats: { ...stats } };
}

/**
 * Seasons a requester moved on to before the next-season option (or the Janitor) followed them,
 * e.g. by monitoring them in Sonarr by hand: a request for season 1 while they watch season 4. For
 * season rules with the option on, every later season that is in Jellyfin or monitored in Sonarr
 * joins the request of a requester who watched anything after their requested seasons, or whose
 * requested seasons are gone from Jellyfin and Sonarr. Bookkeeping
 * only (Sonarr is not touched), so dry runs do it too. Returns how many seasons were added.
 */
function catchUp(ctx: AppContext, store: JanitorStore, rules: JanitorRule[], arr: ArrSnapshot, now: Date): number {
  const seasonRules = rules.filter((r) => r.unit === 'season');
  if (!seasonRules.some((r) => r.nextSeason.enabled)) return 0;
  const units = buildUnits(ctx, 'season', arr);
  const byTitle = new Map<number, Unit[]>();
  for (const u of units) byTitle.set(u.titleId, [...(byTitle.get(u.titleId) ?? []), u]);
  const lastWatched = ctx.db.prepare(
    `SELECT MAX(season) AS s FROM (SELECT season FROM watched_episodes WHERE user_id = ? AND title_id = ? UNION ALL SELECT season FROM manual_watches WHERE user_id = ? AND title_id = ? AND season > 0)`,
  );
  const claimed = new Set<number>();
  let added = 0;
  // Season units only reach rules of the same kind, so only those claim titles here.
  for (const rule of seasonRules) {
    for (const [titleId, list] of byTitle) {
      if (claimed.has(titleId) || !list.some((u) => matches(rule, u))) continue;
      claimed.add(titleId);
      if (!rule.nextSeason.enabled) continue;
      const unit = list[0]!;
      const present = unit.presentSeasons;
      const requests = [...new Map(list.flatMap((u) => ruleRequests(rule, u)).map((r) => [r.id, r])).values()];
      for (const r of requests) {
        if (r.userId === null || r.seasons.length === 0) continue;
        const max = Math.max(...r.seasons);
        const seasons = present.filter((s) => s > max);
        if (!seasons.length) continue;
        // They moved on: watched something after the requested seasons, or those are gone already.
        const watched = (lastWatched.get(r.userId, titleId, r.userId, titleId) as { s: number | null }).s;
        if (!((watched !== null && watched > max) || r.seasons.every((s) => !present.includes(s)))) continue;
        const name = personName(ctx, r.userId) ?? r.requestedBy ?? 'someone';
        for (const season of seasons) store.addSeason({ requestIds: [r.id], season, titleId, ruleId: rule.id, monitored: false, now: now.toISOString() });
        added += seasons.length;
        const list2 = seasons.length === 1 ? `season ${seasons[0]}` : `seasons ${seasons.slice(0, -1).join(', ')} and ${seasons.at(-1)}`;
        store.log({
          ruleId: rule.id,
          ruleName: rule.name,
          titleId,
          title: unit.title,
          season: seasons[0]!,
          step: 'next_season',
          outcome: 'ok',
          message: `${name} requested ${r.seasons.length === 1 ? `season ${r.seasons[0]}` : `seasons ${r.seasons.join(', ')}`}, but the show has moved on: ${list2} now ${seasons.length === 1 ? 'counts' : 'count'} as requested by ${name}.`,
          at: now.toISOString(),
        });
      }
    }
  }
  return added;
}

/**
 * The next-season option for one season unit: requesters with at most `episodesLeft` episodes of it
 * to go get the next season added to their request, and Sonarr monitors it (and searches for it)
 * unless it already does. Returns whether a season was added.
 */
async function nextSeason(ctx: AppContext, store: JanitorStore, rule: JanitorRule, unit: Unit, now: Date): Promise<boolean> {
  const next = unit.next!;
  const opt = rule.nextSeason;
  const triggered: { name: string; left: number; requests: UnitRequest[] }[] = [];
  // The show is already past that season (a later one is here): never bring an old one back.
  if (unit.presentSeasons.some((s) => s > next.season)) return false;
  const requests = ruleRequests(rule, unit);
  const seenNext = ctx.db.prepare('SELECT 1 FROM watched_episodes WHERE user_id = ? AND title_id = ? AND season = ? LIMIT 1');
  for (const userId of new Set(requests.map((r) => r.userId).filter((id): id is number => id !== null))) {
    // Only requests listing seasons can miss one; a request for the whole show already has it. Only
    // the season after the last one of the request: never an earlier one they already moved past.
    const missing = requests.filter((r) => r.userId === userId && r.seasons.length > 0 && next.season > Math.max(...r.seasons));
    if (!missing.length) continue;
    const name = personName(ctx, userId);
    if (!name) continue;
    const p = progressFor(ctx, { id: userId, name }, unit);
    if (p.left === null || p.left === undefined || p.left > opt.episodesLeft || !p.watched) continue;
    // Watched some of the next season already (deleted since): it is behind them.
    if (!next.monitored && seenNext.get(userId, unit.titleId, next.season)) continue;
    triggered.push({ name, left: p.left, requests: missing });
  }
  if (!triggered.length) return false;

  const nowIsoStr = now.toISOString();
  const who = triggered.map((t) => (t.left === 0 ? `${t.name} finished season ${unit.season}` : `${t.name} has ${t.left} ${t.left === 1 ? 'episode' : 'episodes'} of season ${unit.season} left`)).join(', ');
  const names = triggered.map((t) => t.name).join(', ');
  const log = (outcome: Parameters<JanitorStore['log']>[0]['outcome'], message: string) =>
    store.log({ ruleId: rule.id, ruleName: rule.name, titleId: unit.titleId, title: unit.title, season: next.season, step: 'next_season', outcome, message, at: nowIsoStr });
  const last = store.lastLog(unit.titleId, next.season, 'next_season');
  if (rule.mode === 'dry_run') {
    // Said once; it happens for real when the rule leaves dry run.
    if (last?.outcome !== 'would') log('would', `${who}: would ${next.monitored ? `count season ${next.season} (already monitored in Sonarr)` : `monitor season ${next.season} in Sonarr${opt.search ? ' and search for it' : ''}, and count it`} as requested by ${names}.`);
    return false;
  }
  const sonarr = ctx.integrations.sonarr();
  try {
    if (!sonarr || unit.sonarrId === null) throw new Error('Sonarr is not connected.');
    if (!next.monitored) {
      if (!(await sonarr.setSeasonMonitored(unit.sonarrId, next.season, true))) throw new Error(`Sonarr has no season ${next.season} of this show.`);
      if (opt.search) await sonarr.searchSeason(unit.sonarrId, next.season);
    }
  } catch (err) {
    const message = `Could not monitor season ${next.season} in Sonarr: ${scrub(errorMessage(err)).slice(0, 300)}`;
    if (last?.outcome !== 'failed' || last.message !== message) log('failed', message);
    return false;
  }
  store.addSeason({ requestIds: triggered.flatMap((t) => t.requests.map((r) => r.id)), season: next.season, titleId: unit.titleId, ruleId: rule.id, monitored: !next.monitored, now: nowIsoStr });
  const did = next.monitored ? `season ${next.season} was already monitored in Sonarr` : `monitored season ${next.season} in Sonarr${opt.search ? ' and searched for it' : ''}`;
  log('ok', `${who}: ${did}. It now counts as requested by ${names}.`);
  return true;
}

interface StepResult {
  freedBytes: number;
  message: string;
  skipped?: boolean;
}

function titleIds(ctx: AppContext, titleId: number) {
  return ctx.db.prepare('SELECT media_type, tmdb_id, tvdb_id FROM titles WHERE id = ?').get(titleId) as { media_type: 'movie' | 'tv'; tmdb_id: number | null; tvdb_id: number | null } | undefined;
}

async function sonarrSeries(ctx: AppContext, c: CandidateRow) {
  const sonarr = ctx.integrations.sonarr();
  if (!sonarr) throw new Error('Sonarr is not connected.');
  const t = titleIds(ctx, c.title_id);
  if (!t) return { sonarr, series: null };
  const all = await sonarr.allSeries();
  const series = findSeries(arrIndex(all, null), t);
  // Never act on a different show: the ids must agree.
  if (series && ((t.tvdb_id && series.tvdbId && series.tvdbId !== t.tvdb_id) || (t.tmdb_id && series.tmdbId && series.tmdbId !== t.tmdb_id))) throw new Error('Sonarr’s show does not match this title’s ids.');
  return { sonarr, series };
}

async function radarrMovie(ctx: AppContext, c: CandidateRow) {
  const radarr = ctx.integrations.radarr();
  if (!radarr) throw new Error('Radarr is not connected.');
  const t = titleIds(ctx, c.title_id);
  const movie = t?.tmdb_id ? ((await radarr.movies()).find((m) => m.tmdbId === t.tmdb_id) ?? null) : null;
  return { radarr, movie };
}

/** Marks the local copies of requests as removed, so they leave the Janitor and the Requests page at once. */
function forgetRequests(ctx: AppContext, ids: number[]) {
  const stmt = ctx.db.prepare("UPDATE requests SET request_status = NULL, media_status = NULL, last_error = 'Removed by the Janitor after it was watched.', synced_at = ? WHERE id = ?");
  ctx.db.transaction(() => ids.forEach((id) => stmt.run(nowIso(), id)))();
}

async function execute(ctx: AppContext, step: JanitorStep, c: CandidateRow): Promise<StepResult> {
  const ctxt = parseJson<CandidateContext>(c.context, {});
  switch (step.type) {
    case 'sonarr_delete_season': {
      const { sonarr, series } = await sonarrSeries(ctx, c);
      if (!series) return { freedBytes: 0, message: 'The show is not in Sonarr; nothing to delete.', skipped: true };
      if (step.unmonitor) await sonarr.setSeasonMonitored(series.id, c.season, false);
      const r = await sonarr.deleteSeasonFiles(series.id, c.season);
      return { freedBytes: r.bytes, message: `Deleted ${r.files} episode ${r.files === 1 ? 'file' : 'files'} of season ${c.season} (${formatBytes(r.bytes)})${step.unmonitor ? ' and unmonitored it' : ''}.` };
    }
    case 'sonarr_delete_series': {
      const { sonarr, series } = await sonarrSeries(ctx, c);
      if (!series) return { freedBytes: 0, message: 'The show is not in Sonarr; nothing to delete.', skipped: true };
      const size = series.statistics?.sizeOnDisk ?? 0;
      const gone = !(await sonarr.deleteSeries(series.id, { importListExclusion: step.importListExclusion }));
      return { freedBytes: gone ? 0 : size, message: gone ? 'The show was already gone from Sonarr.' : `Deleted the show and its files from Sonarr (${formatBytes(size)}).`, skipped: gone };
    }
    case 'radarr_delete_movie': {
      const { radarr, movie } = await radarrMovie(ctx, c);
      if (!movie) return { freedBytes: 0, message: 'The movie is not in Radarr; nothing to delete.', skipped: true };
      const size = movie.sizeOnDisk ?? 0;
      const gone = !(await radarr.deleteMovie(movie.id, { importExclusion: step.importExclusion }));
      return { freedBytes: gone ? 0 : size, message: gone ? 'The movie was already gone from Radarr.' : `Deleted the movie and its files from Radarr (${formatBytes(size)}).`, skipped: gone };
    }
    case 'seerr_delete_request': {
      const seerr = ctx.integrations.seerr();
      if (!seerr) throw new Error('Seerr is not connected.');
      const ids = ctxt.seerrRequestIds ?? [];
      let deleted = 0;
      for (const id of ids) if (await seerr.deleteRequest(id)) deleted++;
      forgetRequests(ctx, ctxt.requestIds ?? []);
      return { freedBytes: 0, message: ids.length ? `Deleted ${deleted} of ${ids.length} ${ids.length === 1 ? 'request' : 'requests'} in Seerr.` : 'No request to delete.', skipped: deleted === 0 };
    }
    case 'seerr_delete_media': {
      const seerr = ctx.integrations.seerr();
      if (!seerr) throw new Error('Seerr is not connected.');
      const t = titleIds(ctx, c.title_id);
      const row = t?.tmdb_id ? (ctx.db.prepare('SELECT seerr_media_id FROM seerr_media WHERE media_type = ? AND tmdb_id = ?').get(t.media_type, t.tmdb_id) as { seerr_media_id: number | null } | undefined) : undefined;
      forgetRequests(ctx, ctxt.requestIds ?? []);
      if (!row?.seerr_media_id) return { freedBytes: 0, message: 'Seerr does not track this title; nothing to remove.', skipped: true };
      const ok = await seerr.deleteMedia(row.seerr_media_id);
      if (t?.tmdb_id) ctx.db.prepare('DELETE FROM seerr_media WHERE media_type = ? AND tmdb_id = ?').run(t.media_type, t.tmdb_id);
      return { freedBytes: 0, message: ok ? 'Removed the title and its requests from Seerr.' : 'Seerr no longer had this title.', skipped: !ok };
    }
    default:
      throw new Error(`Not a deletion step: ${step.type}`);
  }
}

/** What a destructive step would do (dry runs). */
async function describe(ctx: AppContext, step: JanitorStep, c: CandidateRow): Promise<string> {
  const ctxt = parseJson<CandidateContext>(c.context, {});
  try {
    switch (step.type) {
      case 'sonarr_delete_season': {
        const { series } = await sonarrSeries(ctx, c);
        if (!series) return 'Would delete season files, but the show is not in Sonarr.';
        const s = sonarrSeasons(series).find((x) => x.season === c.season);
        return `Would delete ${s?.files ?? 0} episode files of season ${c.season} (${formatBytes(s?.sizeOnDisk)})${step.unmonitor ? ' and unmonitor it' : ''}.`;
      }
      case 'sonarr_delete_series': {
        const { series } = await sonarrSeries(ctx, c);
        return series ? `Would delete the show and its files from Sonarr (${formatBytes(series.statistics?.sizeOnDisk)}).` : 'Would delete the show, but it is not in Sonarr.';
      }
      case 'radarr_delete_movie': {
        const { movie } = await radarrMovie(ctx, c);
        return movie ? `Would delete the movie and its files from Radarr (${formatBytes(movie.sizeOnDisk)}).` : 'Would delete the movie, but it is not in Radarr.';
      }
      case 'seerr_delete_request':
        return `Would delete ${(ctxt.seerrRequestIds ?? []).length} request(s) in Seerr${ctx.integrations.seerr() ? '' : ' (Seerr is not connected)'}.`;
      case 'seerr_delete_media':
        return `Would remove the title and its requests from Seerr${ctx.integrations.seerr() ? '' : ' (Seerr is not connected)'}.`;
      default:
        return STEP_LABEL[step.type];
    }
  } catch (err) {
    return `Would run “${STEP_LABEL[step.type]}”, but: ${scrub(errorMessage(err))}`;
  }
}

/** Whether a gate's condition holds; `gone` when the show left Sonarr, `unknown` when Sonarr cannot be read. */
async function gate(ctx: AppContext, condition: 'series_ended' | 'no_files_left', c: CandidateRow): Promise<'yes' | 'no' | 'gone' | 'unknown'> {
  let series;
  try {
    series = (await sonarrSeries(ctx, c)).series;
  } catch {
    return 'unknown';
  }
  if (!series) return 'gone';
  if (condition === 'series_ended') return series.status === 'ended' ? 'yes' : 'no';
  const seasons = sonarrSeasons(series).filter((s) => s.season > 0);
  if (!seasons.every((s) => s.files === 0)) return 'no';
  // Seasons the Janitor deleted itself are done, even when the step left them monitored.
  const cleaned = new Set(
    (ctx.db.prepare('SELECT season FROM janitor_candidates WHERE title_id = ? AND acted = 1 AND dry_run = 0').all(c.title_id) as { season: number }[]).map((r) => r.season),
  );
  // A monitored season with aired episodes but no files has not been downloaded yet: still to come.
  if (seasons.some((s) => s.season !== c.season && s.monitored && s.episodes > 0 && !cleaned.has(s.season))) return 'no';
  // A season added to a request is still to come (maybe not downloaded yet) until the Janitor deleted it.
  const pending = ctx.db
    .prepare(
      `SELECT 1 FROM janitor_request_seasons s JOIN requests r ON r.id = s.request_id
        WHERE s.title_id = ? AND s.season != ? AND r.request_status IN (2, 5)
          AND NOT EXISTS (SELECT 1 FROM janitor_candidates c WHERE c.title_id = s.title_id AND c.season = s.season AND c.acted = 1 AND c.dry_run = 0)
        LIMIT 1`,
    )
    .get(c.title_id, c.season);
  return pending ? 'no' : 'yes';
}
