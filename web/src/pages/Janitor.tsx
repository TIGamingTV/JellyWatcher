import { useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Check, Eye, Pause, Play, Plus, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react';
import { del, errorText, get, patch, post, put } from '../lib/api';
import { useToast } from '../lib/session';
import { bytes, date, dateTime } from '../lib/format';
import { Banner, CenterLoading, ConfirmSheet, EmptyState, ErrorState, Field, PageHeader, Segmented, Sheet, Spinner, Time, Toggle } from '../components/ui';
import {
  DEFAULT_NOTIFY_MESSAGE,
  GATE_LABEL,
  STEPS_FOR_UNIT,
  STEP_LABEL,
  defaultStep,
  type CandidateState,
  type JanitorRule,
  type JanitorRuleInput,
  type JanitorStep,
  type JanitorStepType,
  type JanitorUnit,
  type LogOutcome,
} from '../../../shared/janitor';

// ---- Types of the Janitor API ------------------------------------------------------------------

interface CandidateView {
  id: number;
  ruleId: number;
  ruleName: string | null;
  ruleEnabled: boolean;
  titleId: number;
  title: string;
  year: number | null;
  posterUrl: string | null;
  season: number;
  label: string;
  state: CandidateState;
  stepIndex: number;
  stepCount: number;
  nextStep: string | null;
  nextRunAt: string | null;
  eligibleAt: string;
  dueAt: string | null;
  parked: string | null;
  dryRun: boolean;
  acted: boolean;
  approvedAt: string | null;
  /** Will stop for approval; can be approved ahead of time. */
  needsApproval: boolean;
  /** A notification already asked for the approval. */
  approvalAsked: boolean;
  attempts: number;
  lastError: string | null;
  requesters: string[];
  sizeBytes: number | null;
  freedBytes: number;
}

interface OverviewData {
  settings: Record<string, number | boolean | string>;
  services: { sonarr: boolean; radarr: boolean; seerr: boolean; jellyfin: boolean; homeassistant: boolean };
  rules: { total: number; enabled: number; dryRun: number };
  candidates: CandidateView[];
  freedBytes: { total: number; last30Days: number };
  lastRun: { status: string; started_at: string; error: string | null; stats: Record<string, unknown> } | null;
  running: boolean;
  publicUrl: boolean;
}

interface RuleView extends JanitorRule {
  active?: number;
}

interface PreviewRow {
  ruleId: number;
  titleId: number;
  title: string;
  label: string;
  season: number;
  posterUrl: string | null;
  requesters: string[];
  status: 'eligible' | 'waiting' | 'excluded' | 'incomplete' | 'not_in_library' | 'claimed';
  reason: string | null;
  eligibleAt: string | null;
  sizeBytes: number | null;
  candidateId: number | null;
}

interface ExclusionView {
  id: number;
  titleId: number;
  title: string;
  year: number | null;
  posterUrl: string | null;
  season: number;
  ruleId: number | null;
  ruleName: string | null;
  until: string | null;
  reason: string | null;
  createdAt: string;
  active: boolean;
}

interface LogEntry {
  id: number;
  ruleName: string | null;
  titleId: number | null;
  label: string;
  step: string;
  stepLabel: string;
  outcome: LogOutcome;
  message: string | null;
  freedBytes: number;
  createdAt: string;
}

const MODE_LABEL: Record<JanitorRule['mode'], string> = { dry_run: 'Dry run', approval: 'Ask first', auto: 'Automatic' };
const MODE_PILL: Record<JanitorRule['mode'], string> = { dry_run: 'pill-blue', approval: 'pill-orange', auto: 'pill-red' };
const UNIT_LABEL: Record<JanitorUnit, string> = { movie: 'Movies', season: 'Shows, season by season', series: 'Whole shows' };
const OUTCOME_PILL: Record<LogOutcome, string> = { ok: 'pill-green', would: 'pill-blue', skipped: '', failed: 'pill-red', info: '' };
const OUTCOME_LABEL: Record<LogOutcome, string> = { ok: 'Done', would: 'Would do', skipped: 'Skipped', failed: 'Failed', info: 'Info' };
const PREVIEW_LABEL: Record<PreviewRow['status'], [string, string]> = {
  eligible: ['Ready', 'pill-green'],
  waiting: ['Waiting', 'pill-orange'],
  excluded: ['Kept', 'pill-blue'],
  incomplete: ['Incomplete', ''],
  not_in_library: ['Not in library', ''],
  claimed: ['Other rule', ''],
};

const size = (n: number | null | undefined) => (n && n > 0 ? bytes(n) : null);

// ---- Page --------------------------------------------------------------------------------------

export function JanitorPage() {
  const tabs = [
    { to: '/janitor', label: 'Overview', end: true },
    { to: '/janitor/rules', label: 'Rules' },
    { to: '/janitor/kept', label: 'Kept' },
    { to: '/janitor/log', label: 'Log' },
  ];
  return (
    <>
      <PageHeader title="Janitor" subtitle="Cleans up requests once the people who wanted them have watched them: Sonarr, Radarr and Seerr, step by step, the way your rules say." />
      <nav className="segmented" aria-label="Janitor sections" style={{ marginBottom: 24 }}>
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            style={({ isActive }) => ({
              padding: '5px 14px',
              borderRadius: 7,
              fontWeight: isActive ? 600 : 500,
              fontSize: '0.875rem',
              color: 'var(--label)',
              background: isActive ? 'var(--surface)' : 'transparent',
              boxShadow: isActive ? '0 1px 3px rgba(0,0,0,0.12)' : undefined,
              whiteSpace: 'nowrap',
              textDecoration: 'none',
            })}
          >
            {t.label}
          </NavLink>
        ))}
      </nav>
      <div style={{ maxWidth: 920 }}>
        <Routes>
          <Route index element={<Overview />} />
          <Route path="rules" element={<RulesList />} />
          <Route path="rules/:id" element={<RuleEditor />} />
          <Route path="kept" element={<Exclusions />} />
          <Route path="log" element={<LogView />} />
          <Route path="*" element={<Navigate to="/janitor" replace />} />
        </Routes>
      </div>
    </>
  );
}

function Thumb({ src }: { src: string | null }) {
  return (
    <span style={{ width: 34, height: 51, borderRadius: 5, overflow: 'hidden', background: 'var(--gray-tint)', flex: 'none' }} aria-hidden>
      {src && <img src={src} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />}
    </span>
  );
}

function Section({ title, footer, children, actions }: { title: string; footer?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section>
      <div className="inline" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <h2 className="group-title" style={{ margin: '0 4px' }}>
          {title}
        </h2>
        {actions}
      </div>
      <div className="group">{children}</div>
      {footer && <p className="group-footer">{footer}</p>}
    </section>
  );
}

// ---- Overview ----------------------------------------------------------------------------------

function useOverview() {
  return useQuery({ queryKey: ['janitor-overview'], queryFn: () => get<OverviewData>('/admin/janitor/overview'), refetchInterval: 30_000 });
}

function Overview() {
  const q = useOverview();
  const qc = useQueryClient();
  const toast = useToast();
  const [running, setRunning] = useState(false);
  const [keep, setKeep] = useState<CandidateView | null>(null);
  if (q.isLoading) return <CenterLoading />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const refresh = () => qc.invalidateQueries({ queryKey: ['janitor-overview'] });
  const paused = Boolean(d.settings['janitor.paused']);

  const setPaused = async (v: boolean) => {
    try {
      await put('/admin/settings', { 'janitor.paused': v });
      toast('success', v ? 'Janitor paused. Nothing is deleted until you resume.' : 'Janitor resumed.');
      void refresh();
    } catch (err) {
      toast('error', errorText(err));
    }
  };
  const runNow = async () => {
    setRunning(true);
    try {
      const r = await post<{ finished: boolean; result: { status: string; error: string | null } | null }>('/admin/sync/janitor');
      toast(r.result?.status === 'error' ? 'error' : 'success', r.result?.error ?? (r.finished ? 'Janitor run finished.' : 'Started; it continues in the background.'));
    } catch (err) {
      toast('error', errorText(err));
    } finally {
      setRunning(false);
      void refresh();
    }
  };
  const act = async (c: CandidateView, action: 'approve' | 'retry' | 'forget') => {
    try {
      if (action === 'forget') await del(`/admin/janitor/candidates/${c.id}`);
      else await post(`/admin/janitor/candidates/${c.id}/${action}`);
      toast('success', action === 'approve' ? `Approved: ${c.label}.` : action === 'retry' ? 'Trying again.' : 'Forgotten. If it is still ready, the next run starts it again.');
    } catch (err) {
      toast('error', errorText(err));
    } finally {
      setTimeout(() => void refresh(), 800);
    }
  };

  // Waiting at the deletion, or already announced: approving now lets it run on schedule.
  const approval = d.candidates.filter((c) => c.state === 'awaiting_approval' || (c.needsApproval && c.approvalAsked));
  const failed = d.candidates.filter((c) => c.state === 'failed' || (c.state === 'waiting' && c.lastError && !c.parked));
  const upcoming = d.candidates.filter((c) => !approval.includes(c) && !failed.includes(c));
  const missing = [!d.services.jellyfin && 'Jellyfin', !d.services.seerr && 'Seerr', !d.services.sonarr && 'Sonarr', !d.services.radarr && 'Radarr'].filter(Boolean) as string[];

  return (
    <div className="stack-l">
      {paused && (
        <Banner kind="warn" title="The Janitor is paused" action={<button className="btn btn-small" onClick={() => setPaused(false)}><Play size={14} aria-hidden /> Resume</button>}>
          Rules are still checked so you can see what is coming up, but no step runs.
        </Banner>
      )}
      {missing.length > 0 && (
        <Banner kind="info" title={`Not connected: ${missing.join(', ')}`}>
          Steps that need them fail until you connect them in <Link to="/integrations">Integrations</Link>.
        </Banner>
      )}
      {!d.services.homeassistant && <Banner kind="info">Connect <Link to="/integrations/homeassistant">Home Assistant</Link> to get warned before anything is deleted.</Banner>}
      {d.rules.total === 0 && (
        <Banner kind="info" title="No rules yet" action={<Link className="btn btn-small" to="/janitor/rules">Add a Rule</Link>}>
          Start from a template; new rules start turned off and in dry run.
        </Banner>
      )}

      <Section title="Status">
        <div className="row">
          <div className="row-main">
            <div className="row-title">{paused ? 'Paused' : 'Active'}</div>
            <div className="row-sub">
              {d.rules.enabled} of {d.rules.total} {d.rules.total === 1 ? 'rule' : 'rules'} on{d.rules.dryRun ? ` · ${d.rules.dryRun} in dry run` : ''}
            </div>
          </div>
          <Toggle checked={!paused} onChange={(v) => setPaused(!v)} label="Janitor active" />
        </div>
        <div className="row">
          <div className="row-main">
            <div className="row-title">Last run</div>
            <div className="row-sub">
              {d.lastRun ? (
                <>
                  <Time iso={d.lastRun.started_at} /> · {d.lastRun.status}
                  {d.lastRun.error ? ` · ${d.lastRun.error}` : d.lastRun.stats.blocked ? ` · held back: ${String(d.lastRun.stats.blocked)}` : ''}
                </>
              ) : (
                'Not yet'
              )}
            </div>
          </div>
          <button className="btn btn-small" onClick={runNow} disabled={running || d.running}>
            {running || d.running ? <Spinner /> : <RefreshCw size={14} aria-hidden />}
            Run Now
          </button>
        </div>
        <div className="row">
          <div className="row-main">
            <div className="row-title">Space freed</div>
            <div className="row-sub">
              {bytes(d.freedBytes.last30Days)} in the last 30 days · {bytes(d.freedBytes.total)} in total
            </div>
          </div>
        </div>
      </Section>

      {approval.length > 0 && (
        <Section title="Waiting for Your Approval">
          {approval.map((c) => (
            <CandidateRow key={c.id} c={c}>
              <button className="btn btn-small btn-destructive" onClick={() => act(c, 'approve')}>
                <Check size={14} aria-hidden /> Approve
              </button>
              <button className="btn btn-small" onClick={() => setKeep(c)}>
                <ShieldCheck size={14} aria-hidden /> Keep
              </button>
            </CandidateRow>
          ))}
        </Section>
      )}

      {failed.length > 0 && (
        <Section title="Problems">
          {failed.map((c) => (
            <CandidateRow key={c.id} c={c}>
              <button className="btn btn-small" onClick={() => act(c, 'retry')}>
                Retry
              </button>
              <button className="btn btn-small btn-gray" onClick={() => setKeep(c)}>
                Keep
              </button>
            </CandidateRow>
          ))}
        </Section>
      )}

      <Section title="Coming Up" footer="Each cleanup follows its rule’s steps. Keep something to stop it and exclude it from now on; deletions that already happened stay done.">
        {upcoming.length === 0 ? (
          <div className="row secondary">Nothing is scheduled. Titles appear here once everyone needed has watched them.</div>
        ) : (
          upcoming.map((c) => (
            <CandidateRow key={c.id} c={c}>
              {c.needsApproval && (
                <button className="btn btn-small btn-gray" onClick={() => act(c, 'approve')}>
                  <Check size={14} aria-hidden /> Approve
                </button>
              )}
              <button className="btn btn-small" onClick={() => setKeep(c)}>
                <ShieldCheck size={14} aria-hidden /> Keep
              </button>
              {!c.acted && (
                <button className="icon-btn" title="Forget (starts again if still ready)" aria-label={`Forget ${c.label}`} onClick={() => act(c, 'forget')}>
                  <X size={16} />
                </button>
              )}
            </CandidateRow>
          ))
        )}
      </Section>

      <JanitorSettings settings={d.settings} publicUrl={d.publicUrl} onSaved={refresh} />
      {keep && <KeepSheet c={keep} onClose={() => setKeep(null)} onDone={() => void refresh()} />}
    </div>
  );
}

function CandidateRow({ c, children }: { c: CandidateView; children: ReactNode }) {
  const when =
    c.state === 'awaiting_approval'
      ? 'Next: ' + (c.nextStep ?? 'deletion')
      : c.parked
        ? c.parked
        : c.dueAt
          ? `${c.dryRun ? 'Would be deleted' : 'Deleted'} ${dateTime(c.dueAt)}${c.needsApproval ? ' once you approve it' : c.approvedAt ? ' · approved' : ''}`
          : c.nextRunAt
            ? `Next: ${c.nextStep ?? 'step'} · ${dateTime(c.nextRunAt)}`
            : c.nextStep
              ? `Next: ${c.nextStep}`
              : '';
  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      <Thumb src={c.posterUrl} />
      <div className="row-main">
        <div className="row-title">
          <Link to={`/titles/${c.titleId}`} style={{ color: 'inherit' }}>
            {c.label}
          </Link>{' '}
          {c.dryRun && <span className="pill pill-blue">Dry run</span>} {c.acted && <span className="pill pill-orange">Partly done</span>}
        </div>
        <div className="row-sub">
          {c.ruleName ?? 'Deleted rule'} · step {Math.min(c.stepIndex + 1, c.stepCount)} of {c.stepCount}
          {c.requesters.length > 0 && ` · requested by ${c.requesters.join(', ')}`}
          {size(c.sizeBytes) && ` · ${size(c.sizeBytes)}`}
        </div>
        {when && <div className="row-sub">{when}</div>}
        {c.lastError && !c.parked && <div className="row-sub" style={{ color: 'var(--red)' }}>{c.state === 'failed' ? 'Stopped after repeated failures: ' : `Attempt ${c.attempts} failed: `}{c.lastError}</div>}
        {!c.ruleEnabled && <div className="row-sub" style={{ color: 'var(--orange)' }}>Its rule is turned off, so it waits.</div>}
      </div>
      <div className="inline" style={{ flexWrap: 'nowrap' }}>{children}</div>
    </div>
  );
}

function KeepSheet({ c, onClose, onDone }: { c: { id?: number; titleId: number; season: number; label: string; ruleId?: number }; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [span, setSpan] = useState<'forever' | '30' | '90' | '365'>('forever');
  const [reason, setReason] = useState('');
  const [onlyRule, setOnlyRule] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const days = span === 'forever' ? null : Number(span);
      if (c.id) await post(`/admin/janitor/candidates/${c.id}/keep`, { days, reason: reason || undefined, onlyThisRule: onlyRule });
      else await post('/admin/janitor/exclusions', { titleId: c.titleId, season: c.season, ruleId: onlyRule && c.ruleId ? c.ruleId : null, days, reason: reason || undefined });
      toast('success', `${c.label} is kept${days ? ` for ${days} days` : ''}.`);
      onDone();
      onClose();
    } catch (err) {
      toast('error', errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title={`Keep ${c.label}`}
      footer={
        <>
          <button className="btn btn-gray" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy && <Spinner />}
            Keep
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="secondary" style={{ margin: 0 }}>
          The Janitor stops here and leaves it alone. Anything it already deleted stays deleted.
        </p>
        <Segmented
          label="How long"
          value={span}
          onChange={setSpan}
          options={[
            { value: 'forever', label: 'Always' },
            { value: '30', label: '30 days' },
            { value: '90', label: '90 days' },
            { value: '365', label: '1 year' },
          ]}
        />
        <Field label="Reason (optional)">{(id) => <input id={id} className="input" maxLength={200} value={reason} placeholder="e.g. Family favourite" onChange={(e) => setReason(e.target.value)} />}</Field>
        {(c.id || c.ruleId) && (
          <label className="inline">
            <input type="checkbox" checked={onlyRule} onChange={(e) => setOnlyRule(e.target.checked)} /> Only for this rule
          </label>
        )}
      </div>
    </Sheet>
  );
}

function JanitorSettings({ settings, publicUrl, onSaved }: { settings: OverviewData['settings']; publicUrl: boolean; onSaved: () => void }) {
  const toast = useToast();
  const [v, setV] = useState(settings);
  useEffect(() => setV(settings), [settings]);
  const save = async () => {
    try {
      const { 'janitor.paused': _paused, ...rest } = v;
      await put('/admin/settings', rest);
      toast('success', 'Janitor settings saved.');
      onSaved();
    } catch (err) {
      toast('error', errorText(err));
    }
  };
  const num = (k: string) => Number(v[k]);
  return (
    <Section title="Settings" footer={<>Times use the server’s time zone (TZ). {publicUrl ? '' : 'Set JW_PUBLIC_URL so notifications link back here.'}</>}>
      <div className="form-stack">
        <div className="cols-2" style={{ gap: 16 }}>
          <Field label="Check every (minutes)" hint="5–1440. It also runs after every Jellyfin sync.">
            {(id, d) => <input id={id} aria-describedby={d} className="input tabular" type="number" min={5} max={1440} value={num('janitor.intervalMinutes')} onChange={(e) => setV({ ...v, 'janitor.intervalMinutes': Number(e.target.value) })} />}
          </Field>
          <Field label="Deletions per run at most" hint="A safety net against mistakes in a rule.">
            {(id, d) => <input id={id} aria-describedby={d} className="input tabular" type="number" min={1} max={500} value={num('janitor.maxActionsPerRun')} onChange={(e) => setV({ ...v, 'janitor.maxActionsPerRun': Number(e.target.value) })} />}
          </Field>
        </div>
        <Field label="Delete only between" hint="Waits, notifications and approvals happen any time; deletions wait for this window. Leave both empty to allow any time.">
          {(id, d) => (
            <div className="inline">
              <input id={id} aria-describedby={d} aria-label="From" className="input tabular" type="time" style={{ width: 140 }} value={String(v['janitor.windowStart'] ?? '')} onChange={(e) => setV({ ...v, 'janitor.windowStart': e.target.value })} />
              <span>and</span>
              <input aria-label="Until" className="input tabular" type="time" style={{ width: 140 }} value={String(v['janitor.windowEnd'] ?? '')} onChange={(e) => setV({ ...v, 'janitor.windowEnd': e.target.value })} />
            </div>
          )}
        </Field>
        {(
          [
            ['janitor.notifyApproval', 'Notify when a deletion needs approval'],
            ['janitor.notifyDone', 'Notify when something was deleted'],
            ['janitor.notifyFailed', 'Notify when a deletion keeps failing'],
          ] as const
        ).map(([k, label]) => (
          <div key={k} className="inline" style={{ justifyContent: 'space-between' }}>
            <span>{label}</span>
            <Toggle checked={Boolean(v[k])} onChange={(x) => setV({ ...v, [k]: x })} label={label} />
          </div>
        ))}
        <div className="form-actions">
          <button className="btn btn-primary" onClick={save}>
            Save Settings
          </button>
        </div>
      </div>
    </Section>
  );
}

// ---- Rules -------------------------------------------------------------------------------------

function ruleSummary(r: JanitorRule): string {
  const w = r.watchers;
  const who =
    w.requester === 'required'
      ? w.others === 'none'
        ? 'requester'
        : `requester + ${OTHERS_SHORT[w.others]}`
      : w.othersMode === 'at_least'
        ? `${w.atLeast}+ of ${OTHERS_SHORT[w.others]}`
        : `all ${OTHERS_SHORT[w.others]}`;
  const next = r.unit === 'season' && r.nextSeason.enabled ? ` · next season at ${r.nextSeason.episodesLeft} left` : '';
  return `${UNIT_LABEL[r.unit]} · ${who} watched${next} · ${r.steps.length} ${r.steps.length === 1 ? 'step' : 'steps'}`;
}

const OTHERS_SHORT: Record<JanitorRule['watchers']['others'], string> = {
  none: 'nobody else',
  active: 'active watchers',
  watchlisted: 'people with it on a list',
  active_or_watchlisted: 'active watchers and list owners',
  all_linked: 'linked people',
};

function RulesList() {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['janitor-rules'], queryFn: () => get<{ rules: RuleView[] }>('/admin/janitor/rules') });
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const [previewing, setPreviewing] = useState(false);
  if (q.isLoading) return <CenterLoading />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const rules = q.data.rules;
  const refresh = () => qc.invalidateQueries({ queryKey: ['janitor-rules'] });

  const create = async (kind: 'movie' | 'tv_season' | 'tv_series') => {
    try {
      const r = await post<{ rule: JanitorRule }>(`/admin/janitor/templates/${kind}`);
      await refresh();
      navigate(`/janitor/rules/${r.rule.id}`);
    } catch (err) {
      toast('error', errorText(err));
    }
  };
  const toggle = async (r: RuleView, enabled: boolean) => {
    try {
      await patch(`/admin/janitor/rules/${r.id}`, { enabled });
      void refresh();
    } catch (err) {
      toast('error', errorText(err));
    }
  };
  const move = async (i: number, dir: -1 | 1) => {
    const ids = rules.map((r) => r.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    try {
      await post('/admin/janitor/rules/reorder', { ids });
      void refresh();
    } catch (err) {
      toast('error', errorText(err));
    }
  };
  const previewAll = async () => {
    setPreviewing(true);
    try {
      setPreview((await post<{ rows: PreviewRow[]; errors: string[] }>('/admin/janitor/preview', {})).rows);
    } catch (err) {
      toast('error', errorText(err));
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <div className="stack-l">
      <Section
        title="Rules"
        footer="Every request belongs to the first turned-on rule that matches it, from the top. Use the arrows to change the order."
        actions={
          <button className="btn btn-small" onClick={previewAll} disabled={previewing || !rules.some((r) => r.enabled)}>
            {previewing ? <Spinner /> : <Eye size={14} aria-hidden />} Preview
          </button>
        }
      >
        {rules.length === 0 && <div className="row secondary">No rules yet. Start from one of the templates below.</div>}
        {rules.map((r, i) => (
          <div key={r.id} className="row">
            <div className="inline" style={{ flexDirection: 'column', gap: 0 }}>
              <button className="icon-btn" style={{ width: 26, height: 22 }} aria-label={`Move ${r.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUp size={14} />
              </button>
              <button className="icon-btn" style={{ width: 26, height: 22 }} aria-label={`Move ${r.name} down`} disabled={i === rules.length - 1} onClick={() => move(i, 1)}>
                <ArrowDown size={14} />
              </button>
            </div>
            <Link to={`/janitor/rules/${r.id}`} className="row-main" style={{ color: 'inherit' }}>
              <div className="row-title">
                {r.name} <span className={`pill ${MODE_PILL[r.mode]}`}>{MODE_LABEL[r.mode]}</span>
              </div>
              <div className="row-sub">
                {ruleSummary(r)}
                {r.active ? ` · ${r.active} in progress` : ''}
              </div>
            </Link>
            <Toggle checked={r.enabled} onChange={(v) => toggle(r, v)} label={`${r.name} on`} />
          </div>
        ))}
      </Section>

      <Section title="Add a Rule" footer="Templates start turned off and in dry run: turn them on, check the log, then switch to “Ask first” or “Automatic”.">
        {(
          [
            ['movie', 'Watched movies', 'Wait a week, warn, wait 3 days, delete in Radarr, delete the request.'],
            ['tv_season', 'Watched seasons', 'Delete each finished season in Sonarr; once the show ended and nothing is left, delete the show and the request.'],
            ['tv_series', 'Finished shows', 'Ended shows watched completely: delete the whole show and the request.'],
          ] as const
        ).map(([kind, title, sub]) => (
          <button key={kind} className="row row-link" style={{ width: '100%', border: 0, background: 'none', textAlign: 'left', cursor: 'pointer', font: 'inherit' }} onClick={() => create(kind)}>
            <Plus size={18} aria-hidden style={{ color: 'var(--accent)' }} />
            <div className="row-main">
              <div className="row-title">{title}</div>
              <div className="row-sub">{sub}</div>
            </div>
          </button>
        ))}
      </Section>

      {preview && <PreviewTable rows={preview} rules={rules} onClose={() => setPreview(null)} />}
    </div>
  );
}

function PreviewTable({ rows, rules, onClose }: { rows: PreviewRow[]; rules?: JanitorRule[]; onClose?: () => void }) {
  const [keep, setKeep] = useState<PreviewRow | null>(null);
  const [kept, setKept] = useState<Set<string>>(new Set());
  const ruleName = (id: number) => rules?.find((r) => r.id === id)?.name;
  const order: PreviewRow['status'][] = ['eligible', 'waiting', 'incomplete', 'excluded', 'not_in_library', 'claimed'];
  const sorted = [...rows].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.label.localeCompare(b.label));
  return (
    <Section
      title={`Preview · ${rows.filter((r) => r.status === 'eligible').length} ready, ${rows.filter((r) => r.status === 'waiting').length} waiting`}
      footer="Nothing changes until the rule runs. “Ready” titles start the rule’s steps on the next run."
      actions={onClose && <button className="btn btn-small btn-gray" onClick={onClose}>Close</button>}
    >
      {sorted.length === 0 ? (
        <div className="row secondary">No approved Seerr requests match.</div>
      ) : (
        sorted.map((r) => (
          <div key={`${r.ruleId}:${r.titleId}:${r.season}`} className="row">
            <Thumb src={r.posterUrl} />
            <div className="row-main">
              <div className="row-title">
                <Link to={`/titles/${r.titleId}`} style={{ color: 'inherit' }}>
                  {r.label}
                </Link>{' '}
                <span className={`pill ${PREVIEW_LABEL[r.status][1]}`}>{PREVIEW_LABEL[r.status][0]}</span>
              </div>
              <div className="row-sub">
                {[rules && rules.length > 1 ? ruleName(r.ruleId) : null, r.requesters.length ? `requested by ${r.requesters.join(', ')}` : null, size(r.sizeBytes)].filter(Boolean).join(' · ')}
              </div>
              <div className="row-sub">{r.status === 'eligible' ? `Everyone needed finished it ${date(r.eligibleAt)}.` : r.reason}</div>
            </div>
            {(r.status === 'eligible' || r.status === 'waiting') && !kept.has(`${r.titleId}:${r.season}`) && (
              <button className="btn btn-small btn-gray" onClick={() => setKeep(r)}>
                Keep
              </button>
            )}
          </div>
        ))
      )}
      {keep && <KeepSheet c={{ titleId: keep.titleId, season: keep.season, label: keep.label, ruleId: keep.ruleId || undefined }} onClose={() => setKeep(null)} onDone={() => setKept(new Set([...kept, `${keep.titleId}:${keep.season}`]))} />}
    </Section>
  );
}

// ---- Rule editor -------------------------------------------------------------------------------

function RuleEditor() {
  const id = Number(useParams().id);
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['janitor-rule', id], queryFn: () => get<{ rule: JanitorRule }>(`/admin/janitor/rules/${id}`) });
  const users = useQuery({ queryKey: ['admin-users'], queryFn: () => get<{ users: { id: number; username: string; displayName: string | null; disabled: number | boolean }[] }>('/admin/users') });
  const [draft, setDraft] = useState<JanitorRuleInput | null>(null);
  const [busy, setBusy] = useState<'save' | 'preview' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmAuto, setConfirmAuto] = useState(false);

  useEffect(() => {
    if (q.data) {
      const { id: _id, position: _p, createdAt: _c, updatedAt: _u, ...rest } = q.data.rule as RuleView;
      delete (rest as { active?: number }).active;
      setDraft(rest);
    }
  }, [q.data]);

  if (q.isLoading || !draft) return q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : <CenterLoading />;
  const set = (patch: Partial<JanitorRuleInput>) => setDraft({ ...draft, ...patch });
  const allowed = STEPS_FOR_UNIT[draft.unit];

  const setUnit = (unit: JanitorUnit) => {
    const steps = draft.steps.filter((s) => STEPS_FOR_UNIT[unit].includes(s.type));
    set({
      unit,
      mediaType: unit === 'movie' ? 'movie' : 'tv',
      steps,
      match: { ...draft.match, seriesStatus: unit === 'movie' ? 'any' : draft.match.seriesStatus },
      nextSeason: { ...draft.nextSeason, enabled: unit === 'season' && draft.nextSeason.enabled },
    });
  };
  const setStep = (i: number, s: JanitorStep) => set({ steps: draft.steps.map((x, j) => (j === i ? s : x)) });
  const moveStep = (i: number, dir: -1 | 1) => {
    const steps = [...draft.steps];
    const j = i + dir;
    if (j < 0 || j >= steps.length) return;
    [steps[i], steps[j]] = [steps[j]!, steps[i]!];
    set({ steps });
  };

  const save = async (override?: Partial<JanitorRuleInput>) => {
    setBusy('save');
    setError(null);
    try {
      await put(`/admin/janitor/rules/${id}`, { ...draft, ...override });
      if (override) set(override);
      toast('success', 'Rule saved.');
      await qc.invalidateQueries({ queryKey: ['janitor-rules'] });
      await qc.invalidateQueries({ queryKey: ['janitor-rule', id] });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };
  const runPreview = async () => {
    setBusy('preview');
    setError(null);
    try {
      setPreview((await post<{ rows: PreviewRow[] }>('/admin/janitor/preview', { rule: { ...draft, id } })).rows);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    try {
      await del(`/admin/janitor/rules/${id}`);
      await qc.invalidateQueries({ queryKey: ['janitor-rules'] });
      navigate('/janitor/rules');
    } catch (err) {
      toast('error', errorText(err));
    }
  };
  const people = (users.data?.users ?? []).filter((u) => !u.disabled);

  return (
    <div className="stack-l">
      <Link to="/janitor/rules" className="back-link">
        ← Rules
      </Link>
      <Section title="Rule">
        <div className="form-stack">
          <Field label="Name">{(fid) => <input id={fid} className="input" maxLength={80} value={draft.name} onChange={(e) => set({ name: e.target.value })} />}</Field>
          <div className="inline" style={{ justifyContent: 'space-between' }}>
            <span>Turned on</span>
            <Toggle checked={draft.enabled} onChange={(v) => set({ enabled: v })} label="Rule turned on" />
          </div>
          <Field label="Handles" hint="Shows by season: each season someone requested is cleaned up on its own once watched.">
            {(fid) => (
              <select id={fid} className="select" value={draft.unit} onChange={(e) => setUnit(e.target.value as JanitorUnit)}>
                {(Object.keys(UNIT_LABEL) as JanitorUnit[]).map((u) => (
                  <option key={u} value={u}>
                    {UNIT_LABEL[u]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Mode" hint={draft.mode === 'dry_run' ? 'Runs every step but only logs what it would delete. Notifications say “[Dry run]”.' : draft.mode === 'approval' ? 'Stops before the first deletion until you approve it in the Overview.' : 'Deletes on its own when the steps say so.'}>
            {() => (
              <Segmented
                label="Mode"
                value={draft.mode}
                onChange={(m) => (m === 'auto' && draft.mode !== 'auto' ? setConfirmAuto(true) : set({ mode: m }))}
                options={[
                  { value: 'dry_run', label: MODE_LABEL.dry_run },
                  { value: 'approval', label: MODE_LABEL.approval },
                  { value: 'auto', label: MODE_LABEL.auto },
                ]}
              />
            )}
          </Field>
        </div>
      </Section>

      <Section title="Which Requests" footer="Only titles requested through Seerr are ever touched. Requests still pending or declined are ignored.">
        <div className="form-stack">
          <Field label="Requested by" hint="None selected: anyone.">
            {() => (
              <div className="chips">
                {people.map((u) => {
                  const on = draft.match.requestedBy.includes(u.id);
                  return (
                    <button
                      key={u.id}
                      type="button"
                      className={`pill ${on ? 'pill-accent' : ''}`}
                      style={{ border: 0, cursor: 'pointer', fontSize: '0.8125rem', padding: '5px 11px' }}
                      aria-pressed={on}
                      onClick={() => set({ match: { ...draft.match, requestedBy: on ? draft.match.requestedBy.filter((x) => x !== u.id) : [...draft.match.requestedBy, u.id] } })}
                    >
                      {u.displayName || u.username}
                    </button>
                  );
                })}
              </div>
            )}
          </Field>
          <Field label="4K requests">
            {() => (
              <Segmented
                label="4K requests"
                value={draft.match.is4k}
                onChange={(v) => set({ match: { ...draft.match, is4k: v } })}
                options={[
                  { value: 'any', label: 'Both' },
                  { value: 'no', label: 'Regular only' },
                  { value: 'yes', label: '4K only' },
                ]}
              />
            )}
          </Field>
          {draft.mediaType === 'tv' && (
            <Field label="Show status in Sonarr">
              {() => (
                <Segmented
                  label="Show status"
                  value={draft.match.seriesStatus}
                  onChange={(v) => set({ match: { ...draft.match, seriesStatus: v } })}
                  options={[
                    { value: 'any', label: 'Any' },
                    { value: 'ended', label: 'Ended' },
                    { value: 'continuing', label: 'Continuing' },
                  ]}
                />
              )}
            </Field>
          )}
        </div>
      </Section>

      <Section title="Who Has to Watch It" footer="Watched means played to the end in Jellyfin, marked as watched, or marked “Not Watching”. Only people with a linked Jellyfin account are known.">
        <div className="form-stack">
          <Field label="Requester">
            {(fid) => (
              <select id={fid} className="select" value={draft.watchers.requester} onChange={(e) => set({ watchers: { ...draft.watchers, requester: e.target.value as 'required' | 'ignored' } })}>
                <option value="required">Must have watched it</option>
                <option value="ignored">Counts like everyone else</option>
              </select>
            )}
          </Field>
          <Field label={draft.watchers.requester === 'required' ? 'Also wait for' : 'Wait for'}>
            {(fid) => (
              <select id={fid} className="select" value={draft.watchers.others} onChange={(e) => set({ watchers: { ...draft.watchers, others: e.target.value as JanitorRule['watchers']['others'] } })}>
                <option value="none">Nobody else</option>
                <option value="active">People who started watching it</option>
                <option value="watchlisted">People with it on a watchlist</option>
                <option value="active_or_watchlisted">People who started it or have it on a watchlist</option>
                <option value="all_linked">Everyone with a linked Jellyfin account</option>
              </select>
            )}
          </Field>
          {draft.watchers.others !== 'none' && (
            <>
              <div className="inline">
                <Segmented
                  label="How many of them"
                  value={draft.watchers.othersMode}
                  onChange={(v) => set({ watchers: { ...draft.watchers, othersMode: v } })}
                  options={[
                    { value: 'all', label: 'All of them' },
                    { value: 'at_least', label: 'At least' },
                  ]}
                />
                {draft.watchers.othersMode === 'at_least' && (
                  <input
                    className="input tabular"
                    type="number"
                    min={1}
                    max={100}
                    style={{ width: 90 }}
                    aria-label="At least this many people"
                    value={draft.watchers.atLeast}
                    onChange={(e) => set({ watchers: { ...draft.watchers, atLeast: Math.max(1, Number(e.target.value)) } })}
                  />
                )}
              </div>
              <div className="inline">
                <label className="inline">
                  <input type="checkbox" checked={draft.watchers.dropAfterDays !== null} onChange={(e) => set({ watchers: { ...draft.watchers, dropAfterDays: e.target.checked ? 30 : null } })} /> Stop waiting for people inactive for
                </label>
                <input
                  className="input tabular"
                  type="number"
                  min={1}
                  max={3650}
                  style={{ width: 90 }}
                  aria-label="Days without watching"
                  disabled={draft.watchers.dropAfterDays === null}
                  value={draft.watchers.dropAfterDays ?? 30}
                  onChange={(e) => set({ watchers: { ...draft.watchers, dropAfterDays: Math.max(1, Number(e.target.value)) } })}
                />
                <span>days</span>
              </div>
            </>
          )}
        </div>
      </Section>

      {draft.unit === 'season' && (
        <Section
          title="Next Season"
          footer="Requests in Seerr usually list only the first season. With this on, the season the requester moves on to counts as part of their request, so it is cleaned up like the one they asked for, and the request is only deleted once they are done. Not a deletion: it happens in “Ask first” and “Automatic” mode, outside the deletion window too. Dry runs only log it."
        >
          <div className="form-stack">
            <div className="inline" style={{ justifyContent: 'space-between' }}>
              <span>Monitor the next season in Sonarr</span>
              <Toggle checked={draft.nextSeason.enabled} onChange={(v) => set({ nextSeason: { ...draft.nextSeason, enabled: v } })} label="Monitor the next season" />
            </div>
            {draft.nextSeason.enabled && (
              <>
                <div className="inline">
                  <span>When a requester has</span>
                  <input
                    className="input tabular"
                    type="number"
                    min={0}
                    max={100}
                    style={{ width: 80 }}
                    aria-label="Episodes left"
                    value={draft.nextSeason.episodesLeft}
                    onChange={(e) => set({ nextSeason: { ...draft.nextSeason, episodesLeft: Math.min(100, Math.max(0, Number(e.target.value))) } })}
                  />
                  <span>{draft.nextSeason.episodesLeft === 1 ? 'episode' : 'episodes'} of a season left to watch</span>
                </div>
                <label className="inline row-sub">
                  <input type="checkbox" checked={draft.nextSeason.search} onChange={(e) => set({ nextSeason: { ...draft.nextSeason, search: e.target.checked } })} /> Search for it right away (otherwise Sonarr only picks up new releases)
                </label>
              </>
            )}
          </div>
        </Section>
      )}

      <Section title="Steps" footer="Steps run from the top. Waits count from when the last person needed finished watching, then from the step before.">
        {draft.steps.map((s, i) => (
          <StepCard key={i} index={i} step={s} count={draft.steps.length} onChange={(x) => setStep(i, x)} onMove={(dir) => moveStep(i, dir)} onRemove={() => set({ steps: draft.steps.filter((_, j) => j !== i) })} />
        ))}
        <div className="row">
          <Plus size={16} aria-hidden style={{ color: 'var(--accent)' }} />
          <select
            className="select select-compact"
            aria-label="Add a step"
            value=""
            onChange={(e) => {
              if (e.target.value) set({ steps: [...draft.steps, defaultStep(e.target.value as JanitorStepType)] });
            }}
          >
            <option value="">Add a step…</option>
            {allowed.map((t) => (
              <option key={t} value={t}>
                {STEP_LABEL[t]}
              </option>
            ))}
          </select>
        </div>
      </Section>

      {error && <Banner kind="error">{error}</Banner>}
      <div className="form-actions">
        <button className="btn btn-primary" onClick={() => save()} disabled={busy !== null || !draft.name.trim()}>
          {busy === 'save' && <Spinner />}
          Save Rule
        </button>
        <button className="btn" onClick={runPreview} disabled={busy !== null}>
          {busy === 'preview' ? <Spinner /> : <Eye size={14} aria-hidden />}
          Preview
        </button>
        <span className="spacer" />
        <button className="btn btn-plain" style={{ color: 'var(--red)' }} onClick={() => setConfirmDelete(true)}>
          <Trash2 size={14} aria-hidden /> Delete Rule
        </button>
      </div>
      <p className="footnote secondary" style={{ margin: 0 }}>
        Saving starts this rule’s pending cleanups over (dry-run results included); timers keep counting from when people finished watching. Deletions already done stay done.
      </p>
      {preview && <PreviewTable rows={preview} onClose={() => setPreview(null)} />}

      <ConfirmSheet open={confirmDelete} onClose={() => setConfirmDelete(false)} onConfirm={remove} destructive title={`Delete “${draft.name}”?`} confirmLabel="Delete Rule" message="Its pending cleanups stop. The log is kept." />
      <ConfirmSheet
        open={confirmAuto}
        onClose={() => setConfirmAuto(false)}
        onConfirm={() => {
          set({ mode: 'auto' });
          setConfirmAuto(false);
        }}
        destructive
        title="Delete without asking?"
        confirmLabel="Use Automatic"
        message="Files are deleted in Sonarr and Radarr as soon as the steps allow, within the deletion window and per-run limit. Run the rule in dry run first and check the log."
      />
    </div>
  );
}

function StepCard({ index, step, count, onChange, onMove, onRemove }: { index: number; step: JanitorStep; count: number; onChange: (s: JanitorStep) => void; onMove: (dir: -1 | 1) => void; onRemove: () => void }) {
  const destructive = ['sonarr_delete_season', 'sonarr_delete_series', 'radarr_delete_movie', 'seerr_delete_request', 'seerr_delete_media'].includes(step.type);
  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      <span className={`pill ${destructive ? 'pill-red' : step.type === 'wait' ? '' : 'pill-accent'}`} style={{ minWidth: 26, justifyContent: 'center', marginTop: 2 }} aria-hidden>
        {index + 1}
      </span>
      <div className="row-main stack" style={{ gap: 8 }}>
        <div className="row-title">{STEP_LABEL[step.type]}</div>
        <StepFields step={step} onChange={onChange} />
      </div>
      <div className="inline" style={{ gap: 0, flexWrap: 'nowrap' }}>
        <button className="icon-btn" aria-label={`Move step ${index + 1} up`} disabled={index === 0} onClick={() => onMove(-1)}>
          <ArrowUp size={15} />
        </button>
        <button className="icon-btn" aria-label={`Move step ${index + 1} down`} disabled={index === count - 1} onClick={() => onMove(1)}>
          <ArrowDown size={15} />
        </button>
        <button className="icon-btn" aria-label={`Remove step ${index + 1}`} onClick={onRemove} style={{ color: 'var(--red)' }}>
          <X size={15} />
        </button>
      </div>
    </div>
  );
}

function StepFields({ step, onChange }: { step: JanitorStep; onChange: (s: JanitorStep) => void }) {
  const check = (label: string, checked: boolean, on: (v: boolean) => void) => (
    <label className="inline row-sub">
      <input type="checkbox" checked={checked} onChange={(e) => on(e.target.checked)} /> {label}
    </label>
  );
  switch (step.type) {
    case 'wait':
      return (
        <div className="inline">
          <input className="input tabular" type="number" min={0} max={3650} style={{ width: 90 }} aria-label="Days" value={step.days} onChange={(e) => onChange({ ...step, days: Math.max(0, Number(e.target.value)) })} />
          <span>days</span>
          <input className="input tabular" type="number" min={0} max={23} style={{ width: 80 }} aria-label="Hours" value={step.hours} onChange={(e) => onChange({ ...step, hours: Math.min(23, Math.max(0, Number(e.target.value))) })} />
          <span>hours</span>
        </div>
      );
    case 'notify':
      return (
        <>
          <textarea className="textarea" rows={2} maxLength={500} value={step.message} placeholder={DEFAULT_NOTIFY_MESSAGE} onChange={(e) => onChange({ ...step, message: e.target.value })} aria-label="Message" />
          <div className="row-sub">
            Placeholders: {'{title}'} (with the season), {'{show}'}, {'{date}'} of the next deletion, {'{requester}'}, {'{size}'}, {'{rule}'}.
          </div>
        </>
      );
    case 'approval':
      return <div className="row-sub">Stops until you approve it in the Overview. In “Ask first” mode this happens before the first deletion anyway.</div>;
    case 'gate':
      return (
        <div className="inline">
          <select className="select select-compact" aria-label="Condition" value={step.condition} onChange={(e) => onChange({ ...step, condition: e.target.value as 'series_ended' | 'no_files_left' })}>
            {(Object.keys(GATE_LABEL) as (keyof typeof GATE_LABEL)[]).map((k) => (
              <option key={k} value={k}>
                {GATE_LABEL[k]}
              </option>
            ))}
          </select>
          <select className="select select-compact" aria-label="Otherwise" value={step.otherwise} onChange={(e) => onChange({ ...step, otherwise: e.target.value as 'stop' | 'recheck' })}>
            <option value="recheck">otherwise check again daily</option>
            <option value="stop">otherwise stop here</option>
          </select>
        </div>
      );
    case 'sonarr_delete_season':
      return (
        <>
          <div className="row-sub">Deletes this season’s episode files.</div>
          {check('Unmonitor the season first, so Sonarr does not download it again', step.unmonitor, (v) => onChange({ ...step, unmonitor: v }))}
        </>
      );
    case 'sonarr_delete_series':
      return (
        <>
          <div className="row-sub">Removes the show from Sonarr with all its files.</div>
          {check('Add an import list exclusion', step.importListExclusion, (v) => onChange({ ...step, importListExclusion: v }))}
        </>
      );
    case 'radarr_delete_movie':
      return (
        <>
          <div className="row-sub">Removes the movie from Radarr with its files.</div>
          {check('Add an import exclusion', step.importExclusion, (v) => onChange({ ...step, importExclusion: v }))}
        </>
      );
    case 'seerr_delete_request':
      return <div className="row-sub">Deletes the request(s) in Seerr. Seerr updates the title’s availability on its next scan.</div>;
    case 'seerr_delete_media':
      return <div className="row-sub">Clears the title in Seerr (status and every request), so it can be requested again right away.</div>;
  }
}

// ---- Exclusions --------------------------------------------------------------------------------

function Exclusions() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['janitor-exclusions'], queryFn: () => get<{ exclusions: ExclusionView[] }>('/admin/janitor/exclusions') });
  if (q.isLoading) return <CenterLoading />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const remove = async (e: ExclusionView) => {
    try {
      await del(`/admin/janitor/exclusions/${e.id}`);
      toast('success', `${e.title} can be cleaned up again.`);
      void qc.invalidateQueries({ queryKey: ['janitor-exclusions'] });
    } catch (err) {
      toast('error', errorText(err));
    }
  };
  if (q.data.exclusions.length === 0) {
    return (
      <EmptyState icon={<ShieldCheck size={28} />} title="Nothing is kept">
        Keep a title from the Overview, a rule preview, or the title’s page, and the Janitor leaves it alone.
      </EmptyState>
    );
  }
  return (
    <Section title="Kept" footer="Kept titles are never cleaned up by the rules shown. Expired entries are removed automatically.">
      {q.data.exclusions.map((e) => (
        <div key={e.id} className="row">
          <Thumb src={e.posterUrl} />
          <div className="row-main">
            <div className="row-title">
              <Link to={`/titles/${e.titleId}`} style={{ color: 'inherit' }}>
                {e.title}
                {e.season >= 0 ? ` · Season ${e.season}` : ''}
              </Link>
            </div>
            <div className="row-sub">
              {e.ruleName ? `Only for “${e.ruleName}”` : 'Every rule'} · {e.until ? `until ${date(e.until)}` : 'always'}
              {e.reason ? ` · ${e.reason}` : ''}
            </div>
          </div>
          <button className="btn btn-small btn-gray" onClick={() => remove(e)}>
            Remove
          </button>
        </div>
      ))}
    </Section>
  );
}

// ---- Log ---------------------------------------------------------------------------------------

function LogView() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [more, setMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const load = async (before?: number) => {
    setLoading(true);
    setError(null);
    try {
      const r = await get<{ entries: LogEntry[] }>(`/admin/janitor/log?limit=100${before ? `&before=${before}` : ''}`);
      setEntries((cur) => (before ? [...cur, ...r.entries] : r.entries));
      setMore(r.entries.length === 100);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  if (error) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!loading && entries.length === 0) return <EmptyState icon={<Pause size={28} />} title="Nothing happened yet">Every step the Janitor takes, and everything a dry run would do, is listed here.</EmptyState>;
  return (
    <div className="stack">
      <div className="group table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Title</th>
              <th scope="col">Step</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="tabular" style={{ whiteSpace: 'nowrap' }}>
                  <Time iso={e.createdAt} />
                </td>
                <td>
                  {e.titleId ? <Link to={`/titles/${e.titleId}`}>{e.label}</Link> : e.label}
                  {e.ruleName && <div className="caption secondary">{e.ruleName}</div>}
                </td>
                <td>{e.stepLabel === e.step ? e.step.replace(/^./, (c) => c.toUpperCase()) : e.stepLabel}</td>
                <td>
                  <span className={`pill ${OUTCOME_PILL[e.outcome]}`}>{OUTCOME_LABEL[e.outcome]}</span>
                  {e.message && <div className="footnote secondary" style={{ marginTop: 4 }}>{e.message}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more && (
        <div>
          <button className="btn btn-small" disabled={loading} onClick={() => load(entries.at(-1)?.id)}>
            {loading && <Spinner />}
            Load More
          </button>
        </div>
      )}
    </div>
  );
}

// ---- Title page section ------------------------------------------------------------------------

/** Janitor state of one title, for administrators on the title page. */
export function TitleJanitor({ titleId, title, mediaType }: { titleId: number; title: string; mediaType: 'movie' | 'tv' }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ['janitor-title', titleId],
    queryFn: () => get<{ candidates: CandidateView[]; exclusions: ExclusionView[]; requested: boolean; addedSeasons: { season: number; requesters: string[]; monitored: boolean; addedAt: string }[] }>(`/admin/janitor/titles/${titleId}`),
  });
  const [keep, setKeep] = useState(false);
  if (!q.data) return null;
  const { candidates, exclusions, requested, addedSeasons } = q.data;
  const active = candidates.filter((c) => c.state !== 'done');
  if (!requested && active.length === 0 && exclusions.length === 0) return null;
  const refresh = () => qc.invalidateQueries({ queryKey: ['janitor-title', titleId] });
  const removeEx = async (id: number) => {
    try {
      await del(`/admin/janitor/exclusions/${id}`);
      void refresh();
    } catch (err) {
      toast('error', errorText(err));
    }
  };
  const kept = exclusions.filter((e) => e.active && e.season === -1 && e.ruleId === null);
  return (
    <section style={{ marginTop: 28 }} aria-labelledby="janitor-h">
      <h2 className="group-title" id="janitor-h">
        Janitor
      </h2>
      <div className="group">
        {active.map((c) => (
          <div key={c.id} className="row">
            <div className="row-main">
              <div className="row-title">
                {c.season >= 0 ? `Season ${c.season}` : mediaType === 'tv' ? 'Whole show' : 'Movie'} · {c.state === 'awaiting_approval' ? 'waiting for approval' : c.state === 'failed' ? 'failed' : c.dryRun ? 'dry run' : 'scheduled'}
              </div>
              <div className="row-sub">
                {c.ruleName} · {c.parked ?? (c.dueAt ? `deletion ${dateTime(c.dueAt)}` : c.nextStep ? `next: ${c.nextStep}` : '')}
              </div>
            </div>
            <Link className="btn btn-small btn-gray" to="/janitor">
              Open
            </Link>
          </div>
        ))}
        {addedSeasons.map((a) => (
          <div key={`added-${a.season}`} className="row">
            <div className="row-main">
              <div className="row-title">Season {a.season} · added to the request</div>
              <div className="row-sub">
                Counts as requested by {a.requesters.join(', ')} · {a.monitored ? 'monitored in Sonarr' : 'was already monitored'} {date(a.addedAt)}
              </div>
            </div>
          </div>
        ))}
        {exclusions.map((e) => (
          <div key={e.id} className="row">
            <ShieldCheck size={16} aria-hidden style={{ color: 'var(--green)' }} />
            <div className="row-main">
              <div className="row-title">Kept{e.season >= 0 ? ` · Season ${e.season}` : ''}</div>
              <div className="row-sub">
                {e.ruleName ? `For “${e.ruleName}”` : 'For every rule'} · {e.until ? `until ${date(e.until)}` : 'always'}
                {e.reason ? ` · ${e.reason}` : ''}
              </div>
            </div>
            <button className="btn btn-small btn-gray" onClick={() => removeEx(e.id)}>
              Remove
            </button>
          </div>
        ))}
        {kept.length === 0 && (
          <div className="row">
            <div className="row-main row-sub">{active.length ? 'Keep it to stop the cleanup.' : 'Requested through Seerr, so rules may clean it up once it is watched.'}</div>
            <button className="btn btn-small" onClick={() => setKeep(true)}>
              <ShieldCheck size={14} aria-hidden /> Keep
            </button>
          </div>
        )}
      </div>
      {keep && <KeepSheet c={{ titleId, season: -1, label: title }} onClose={() => setKeep(false)} onDone={() => void refresh()} />}
    </section>
  );
}
