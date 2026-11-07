import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import type { AppContext } from '../context.js';
import { nowIso, parseJson } from '../db/index.js';
import { ApiError } from '../http/errors.js';
import { IdParam, parse } from '../http/validate.js';
import { approvalAhead, previewRules } from '../janitor/engine.js';
import { notifyAdmin } from '../janitor/notify.js';
import { RuleInputSchema } from '../janitor/schema.js';
import { JanitorStore, type CandidateContext, type CandidateRow } from '../janitor/store.js';
import { requireAdmin } from '../security/auth.js';
import { posterUrl } from '../services/cards.js';
import { triggerJob } from '../sync/scheduler.js';
import { NEXT_SEASON_LABEL, STEP_LABEL, templateRule, unitLabel, type CandidateState, type JanitorRule } from '../../shared/janitor.js';

/** Janitor administration. Registered only with JW_JANITOR on; every route needs an administrator. */

const STATES = ['waiting', 'awaiting_approval', 'running', 'done', 'failed'] as const;

function titleInfo(ctx: AppContext, titleId: number) {
  const t = ctx.db.prepare('SELECT id, title, year, media_type, poster_path FROM titles WHERE id = ?').get(titleId) as
    | { id: number; title: string; year: number | null; media_type: 'movie' | 'tv'; poster_path: string | null }
    | undefined;
  if (!t) return null;
  const jf = ctx.db.prepare('SELECT id, image_tag FROM jellyfin_items WHERE title_id = ? LIMIT 1').get(titleId) as { id: string; image_tag: string | null } | undefined;
  return { title: t.title, year: t.year, mediaType: t.media_type, posterUrl: posterUrl(t, jf ?? null) };
}

export function candidateView(ctx: AppContext, c: CandidateRow, rules: Map<number, JanitorRule>) {
  const rule = rules.get(c.rule_id);
  const ctxt = parseJson<CandidateContext>(c.context, {});
  const info = titleInfo(ctx, c.title_id);
  const step = rule?.steps[c.step_index];
  return {
    id: c.id,
    ruleId: c.rule_id,
    ruleName: rule?.name ?? null,
    ruleEnabled: rule?.enabled ?? false,
    titleId: c.title_id,
    title: info?.title ?? ctxt.title ?? `Title ${c.title_id}`,
    year: info?.year ?? null,
    mediaType: info?.mediaType ?? null,
    posterUrl: info?.posterUrl ?? null,
    season: c.season,
    label: unitLabel(info?.title ?? ctxt.title ?? `Title ${c.title_id}`, c.season),
    state: c.state,
    stepIndex: c.step_index,
    stepCount: rule?.steps.length ?? 0,
    nextStep: step ? STEP_LABEL[step.type] : null,
    nextRunAt: c.next_run_at,
    eligibleAt: c.eligible_at,
    dueAt: ctxt.dueAt ?? null,
    parked: ctxt.parked ?? null,
    dryRun: c.dry_run === 1,
    acted: c.acted === 1,
    approvedAt: c.approved_at,
    /** Will stop for approval; can be approved ahead of time. */
    needsApproval: c.state === 'awaiting_approval' || (rule ? c.state === 'waiting' && approvalAhead(rule, c, c.step_index) : false),
    approvalAsked: ctxt.approvalAsked ?? false,
    attempts: c.attempts,
    lastError: c.last_error,
    requesters: ctxt.requesters ?? [],
    sizeBytes: ctxt.sizeBytes ?? null,
    freedBytes: ctxt.freedBytes ?? 0,
    updatedAt: c.updated_at,
  };
}

function exclusionView(ctx: AppContext, e: { id: number; title_id: number; season: number; rule_id: number | null; until: string | null; reason: string | null; created_at: string }, rules: Map<number, JanitorRule>) {
  const info = titleInfo(ctx, e.title_id);
  return {
    id: e.id,
    titleId: e.title_id,
    title: info?.title ?? `Title ${e.title_id}`,
    year: info?.year ?? null,
    posterUrl: info?.posterUrl ?? null,
    season: e.season,
    ruleId: e.rule_id,
    ruleName: e.rule_id ? (rules.get(e.rule_id)?.name ?? null) : null,
    until: e.until,
    reason: e.reason,
    createdAt: e.created_at,
    active: !e.until || Date.parse(e.until) > Date.now(),
  };
}

export async function janitorRoutes(app: FastifyInstance, { ctx }: AppDeps) {
  if (!ctx.config.janitor) return;
  const store = new JanitorStore(ctx.db);
  const ruleMap = () => new Map(store.rules().map((r) => [r.id, r]));
  const settingsView = () => {
    const s = ctx.settings.all();
    return Object.fromEntries(Object.entries(s).filter(([k]) => k.startsWith('janitor.')));
  };

  app.get('/admin/janitor/overview', async (req) => {
    requireAdmin(req);
    const rules = ruleMap();
    const active = store.candidates(['waiting', 'awaiting_approval', 'running', 'failed']).map((c) => candidateView(ctx, c, rules));
    const since = new Date(Date.now() - 30 * 86400_000).toISOString();
    return {
      settings: settingsView(),
      services: {
        sonarr: ctx.integrations.isReady('sonarr'),
        radarr: ctx.integrations.isReady('radarr'),
        seerr: ctx.integrations.isReady('seerr'),
        jellyfin: ctx.integrations.isReady('jellyfin'),
        homeassistant: ctx.integrations.isReady('homeassistant'),
      },
      rules: { total: rules.size, enabled: [...rules.values()].filter((r) => r.enabled).length, dryRun: [...rules.values()].filter((r) => r.enabled && r.mode === 'dry_run').length },
      candidates: active,
      freedBytes: { total: store.freedBytes(), last30Days: store.freedBytes(since) },
      lastRun: ctx.jobs.lastRun('janitor'),
      running: ctx.jobs.isRunning('janitor'),
      publicUrl: Boolean(ctx.config.publicUrl),
    };
  });

  // ---- Rules

  app.get('/admin/janitor/rules', async (req) => {
    requireAdmin(req);
    const counts = new Map(
      (ctx.db.prepare("SELECT rule_id, COUNT(*) AS n FROM janitor_candidates WHERE state != 'done' GROUP BY rule_id").all() as { rule_id: number; n: number }[]).map((r) => [r.rule_id, r.n]),
    );
    return { rules: store.rules().map((r) => ({ ...r, active: counts.get(r.id) ?? 0 })) };
  });

  app.get('/admin/janitor/rules/:id', async (req) => {
    requireAdmin(req);
    const { id } = parse(IdParam, req.params);
    const rule = store.rule(id);
    if (!rule) throw new ApiError(404, 'not_found', 'Rule not found.');
    return { rule };
  });

  app.post('/admin/janitor/rules', async (req) => {
    requireAdmin(req);
    const input = parse(RuleInputSchema, req.body);
    return { rule: store.createRule(input) };
  });

  app.post('/admin/janitor/templates/:kind', async (req) => {
    requireAdmin(req);
    const { kind } = parse(z.object({ kind: z.enum(['movie', 'tv_season', 'tv_series']) }), req.params);
    return { rule: store.createRule(templateRule(kind)) };
  });

  app.put('/admin/janitor/rules/:id', async (req) => {
    requireAdmin(req);
    const { id } = parse(IdParam, req.params);
    const input = parse(RuleInputSchema, req.body);
    const rule = store.updateRule(id, input);
    if (rule.enabled) void triggerJob(ctx, 'janitor', 'event');
    return { rule };
  });

  app.patch('/admin/janitor/rules/:id', async (req) => {
    requireAdmin(req);
    const { id } = parse(IdParam, req.params);
    const body = parse(z.object({ enabled: z.boolean() }), req.body);
    if (!store.rule(id)) throw new ApiError(404, 'not_found', 'Rule not found.');
    store.setEnabled(id, body.enabled);
    if (body.enabled) void triggerJob(ctx, 'janitor', 'event');
    return { rule: store.rule(id) };
  });

  app.delete('/admin/janitor/rules/:id', async (req) => {
    requireAdmin(req);
    const { id } = parse(IdParam, req.params);
    if (ctx.db.prepare("SELECT 1 FROM janitor_candidates WHERE rule_id = ? AND state = 'running'").get(id)) throw new ApiError(409, 'rule_busy', 'This rule is running right now. Try again in a moment.');
    store.deleteRule(id);
    return { ok: true };
  });

  app.post('/admin/janitor/rules/reorder', async (req) => {
    requireAdmin(req);
    const { ids } = parse(z.object({ ids: z.array(z.number().int().positive()).max(500) }), req.body);
    store.reorder(ids);
    return { rules: store.rules() };
  });

  /** Starts a rule's candidates over (dry-run results included). Nothing already deleted is affected. */
  app.post('/admin/janitor/rules/:id/reset', async (req) => {
    requireAdmin(req);
    const { id } = parse(IdParam, req.params);
    return { removed: store.resetCandidates(id) };
  });

  /**
   * What the rules would pick up right now. With `rule`, previews that (possibly unsaved) rule on
   * its own; otherwise every enabled rule in order.
   */
  app.post('/admin/janitor/preview', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    requireAdmin(req);
    const body = parse(z.object({ rule: z.unknown().optional() }), req.body);
    let rules: JanitorRule[];
    if (body.rule !== undefined) {
      const input = parse(RuleInputSchema, body.rule);
      const id = typeof (body.rule as { id?: unknown }).id === 'number' ? (body.rule as { id: number }).id : 0;
      rules = [{ ...input, id, position: 0, createdAt: nowIso(), updatedAt: nowIso() }];
    } else rules = store.rules().filter((r) => r.enabled);
    const res = await previewRules(ctx, rules);
    const rows = res.rows.map((r) => ({ ...r, label: unitLabel(r.title, r.season), posterUrl: titleInfo(ctx, r.titleId)?.posterUrl ?? null }));
    return { rows, errors: res.errors };
  });

  // ---- Candidates

  app.get('/admin/janitor/candidates', async (req) => {
    requireAdmin(req);
    const q = parse(z.object({ state: z.enum(STATES).optional() }), req.query);
    const rules = ruleMap();
    return { candidates: store.candidates(q.state ? [q.state as CandidateState] : undefined).slice(0, 500).map((c) => candidateView(ctx, c, rules)) };
  });

  const candidateOr404 = (id: number) => {
    const c = store.candidate(id);
    if (!c) throw new ApiError(404, 'not_found', 'This cleanup no longer exists.');
    if (c.state === 'running') throw new ApiError(409, 'running', 'This cleanup is running right now. Try again in a moment.');
    return c;
  };

  app.post('/admin/janitor/candidates/:id/approve', async (req) => {
    requireAdmin(req);
    const { id } = parse(IdParam, req.params);
    const c = candidateOr404(id);
    const rule = store.rule(c.rule_id);
    // Approving ahead of time: it then runs on schedule without stopping.
    const early = c.state === 'waiting' && rule !== null && approvalAhead(rule, c, c.step_index);
    if (c.state !== 'awaiting_approval' && !early) throw new ApiError(409, 'not_waiting', 'This cleanup is not waiting for approval.');
    c.approved_at = nowIso();
    if (!early) {
      c.state = 'waiting';
      c.next_run_at = nowIso();
    }
    store.saveCandidate(c);
    const ctxt = parseJson<CandidateContext>(c.context, {});
    store.log({ candidateId: c.id, ruleId: c.rule_id, ruleName: store.rule(c.rule_id)?.name, titleId: c.title_id, title: ctxt.title ?? `Title ${c.title_id}`, season: c.season, step: 'approval', outcome: 'info', message: `Approved by ${req.user!.displayName}.` });
    void triggerJob(ctx, 'janitor', 'manual');
    return { ok: true };
  });

  /** Keeps the unit: an exclusion (for every rule, or this rule) and the cleanup stops. */
  app.post('/admin/janitor/candidates/:id/keep', async (req) => {
    const u = requireAdmin(req);
    const { id } = parse(IdParam, req.params);
    const body = parse(z.object({ days: z.number().int().min(1).max(3650).nullable().default(null), reason: z.string().trim().max(200).optional(), onlyThisRule: z.boolean().default(false) }), req.body);
    const c = candidateOr404(id);
    store.addExclusion({ titleId: c.title_id, season: c.season, ruleId: body.onlyThisRule ? c.rule_id : null, until: body.days ? new Date(Date.now() + body.days * 86400_000).toISOString() : null, reason: body.reason || null, userId: u.id });
    store.removeCandidate(c.id);
    const ctxt = parseJson<CandidateContext>(c.context, {});
    store.log({ candidateId: c.id, ruleId: c.rule_id, ruleName: store.rule(c.rule_id)?.name, titleId: c.title_id, title: ctxt.title ?? `Title ${c.title_id}`, season: c.season, step: 'keep', outcome: 'info', message: `Kept by ${u.displayName}${body.days ? ` for ${body.days} days` : ''}.` });
    return { ok: true };
  });

  app.post('/admin/janitor/candidates/:id/retry', async (req) => {
    requireAdmin(req);
    const { id } = parse(IdParam, req.params);
    const c = candidateOr404(id);
    if (c.state !== 'failed' && !c.last_error) throw new ApiError(409, 'not_failed', 'Nothing to retry.');
    c.state = 'waiting';
    c.attempts = 0;
    c.last_error = null;
    c.next_run_at = nowIso();
    store.saveCandidate(c);
    void triggerJob(ctx, 'janitor', 'manual');
    return { ok: true };
  });

  /** Forgets a cleanup; if it is still eligible, the next run starts it again from the first step. */
  app.delete('/admin/janitor/candidates/:id', async (req) => {
    requireAdmin(req);
    const { id } = parse(IdParam, req.params);
    const c = candidateOr404(id);
    store.removeCandidate(c.id);
    return { ok: true };
  });

  // ---- Exclusions

  app.get('/admin/janitor/exclusions', async (req) => {
    requireAdmin(req);
    const rules = ruleMap();
    return { exclusions: store.exclusions().map((e) => exclusionView(ctx, e, rules)) };
  });

  app.post('/admin/janitor/exclusions', async (req) => {
    const u = requireAdmin(req);
    const body = parse(
      z.object({
        titleId: z.number().int().positive(),
        season: z.number().int().min(-1).max(1000).default(-1),
        ruleId: z.number().int().positive().nullable().default(null),
        days: z.number().int().min(1).max(3650).nullable().default(null),
        reason: z.string().trim().max(200).optional(),
      }),
      req.body,
    );
    if (!ctx.titles.get(body.titleId)) throw new ApiError(404, 'not_found', 'Title not found.');
    if (body.ruleId && !store.rule(body.ruleId)) throw new ApiError(404, 'not_found', 'Rule not found.');
    const id = store.addExclusion({ titleId: body.titleId, season: body.season, ruleId: body.ruleId, until: body.days ? new Date(Date.now() + body.days * 86400_000).toISOString() : null, reason: body.reason || null, userId: u.id });
    // Waiting cleanups of what is now kept stop right away (deletions already done stay done).
    const stopped = ctx.db
      .prepare(`DELETE FROM janitor_candidates WHERE title_id = ? AND (? = -1 OR season = ?) AND (? IS NULL OR rule_id = ?) AND acted = 0 AND state != 'running'`)
      .run(body.titleId, body.season, body.season, body.ruleId, body.ruleId).changes;
    return { id, stopped };
  });

  app.delete('/admin/janitor/exclusions/:id', async (req) => {
    requireAdmin(req);
    const { id } = parse(IdParam, req.params);
    if (!store.removeExclusion(id)) throw new ApiError(404, 'not_found', 'Exclusion not found.');
    return { ok: true };
  });

  // ---- Log, title view, notifications

  app.get('/admin/janitor/log', async (req) => {
    requireAdmin(req);
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), before: z.coerce.number().int().positive().optional() }), req.query);
    const rows = store.logEntries(q.limit, q.before);
    return {
      entries: rows.map((r) => ({
        id: r.id,
        candidateId: r.candidate_id,
        ruleId: r.rule_id,
        ruleName: r.rule_name,
        titleId: r.title_id,
        title: r.title,
        season: r.season,
        label: unitLabel(r.title, r.season),
        step: r.step,
        stepLabel: r.step === 'next_season' ? NEXT_SEASON_LABEL : ((STEP_LABEL as Record<string, string>)[r.step] ?? r.step),
        outcome: r.outcome,
        message: r.message,
        freedBytes: r.freed_bytes,
        createdAt: r.created_at,
      })),
    };
  });

  app.get('/admin/janitor/titles/:id', async (req) => {
    requireAdmin(req);
    const { id } = parse(IdParam, req.params);
    const rules = ruleMap();
    return {
      candidates: store.forTitle(id).map((c) => candidateView(ctx, c, rules)),
      exclusions: store
        .exclusions()
        .filter((e) => e.title_id === id)
        .map((e) => exclusionView(ctx, e, rules)),
      requested: Boolean(ctx.db.prepare('SELECT 1 FROM requests WHERE title_id = ? AND seerr_request_id IS NOT NULL AND request_status IN (2, 5)').get(id)),
      // Seasons the next-season option added to requests, one row per season.
      addedSeasons: [
        ...store
          .addedSeasonsFor(id)
          .reduce((m, r) => {
            const e = m.get(r.season) ?? { season: r.season, requesters: [] as string[], monitored: false, addedAt: r.created_at };
            const name = r.display_name ?? r.requested_by ?? 'someone';
            if (!e.requesters.includes(name)) e.requesters.push(name);
            e.monitored ||= r.monitored === 1;
            m.set(r.season, e);
            return m;
          }, new Map<number, { season: number; requesters: string[]; monitored: boolean; addedAt: string }>())
          .values(),
      ],
    };
  });

  app.post('/admin/janitor/test-notification', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    requireAdmin(req);
    const r = await notifyAdmin(ctx, 'JellyWatcher Janitor', 'Test notification: Janitor notifications reach you here.');
    if (!r.ok) throw new ApiError(502, 'notify_failed', r.error ?? 'The notification could not be sent.');
    return { ok: true };
  });
}
