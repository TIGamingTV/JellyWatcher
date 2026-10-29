import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Copy, ExternalLink, Eye, EyeOff, RefreshCw, Smartphone } from 'lucide-react';
import { del, errorText, get, post, put } from '../lib/api';
import { useRefreshMe, useToast, useUser } from '../lib/session';
import type { IntegrationView, QuickConnectStart, SourceId, SourcesResponse, SyncRun, TestResult, UploadSource } from '../lib/types';
import { plural } from '../lib/format';
import { Banner, CenterLoading, ConfirmSheet, Field, PageHeader, ProviderMark, Spinner, SyncButton, Time, Toggle } from '../components/ui';
import { AddListSheet, LinkForm, UploadBox, UploadInstructions, useInvalidateLists } from '../components/AddList';
import { SERVICE_COPY } from './Integrations';
import { QuickConnectPanel } from '../components/QuickConnect';

const VALID = ['jellyfin', 'seerr', 'tmdb', 'trakt', 'letterboxd', 'imdb'];

export function IntegrationDetail() {
  const provider = useParams().provider ?? '';
  if (!VALID.includes(provider)) return <Navigate to="/integrations" replace />;
  return (
    <>
      <Link to="/integrations" className="back-link">
        <ChevronLeft size={18} aria-hidden /> Integrations
      </Link>
      {provider === 'jellyfin' && <JellyfinPage />}
      {provider === 'seerr' && <SeerrPage />}
      {provider === 'tmdb' && <TmdbPage />}
      {provider === 'trakt' && <TraktPage />}
      {provider === 'letterboxd' && <LetterboxdPage />}
      {provider === 'imdb' && <SourcePage id="imdb" />}
    </>
  );
}

function Header({ provider, title, subtitle }: { provider: string; title: string; subtitle: string }) {
  return (
    <div className="inline" style={{ gap: 16, alignItems: 'center', marginBottom: 6 }}>
      <ProviderMark provider={provider} size={52} />
      <div style={{ flex: 1 }}>
        <PageHeader title={title} subtitle={subtitle} />
      </div>
    </div>
  );
}

function Section({ title, footer, children }: { title: string; footer?: ReactNode; children: ReactNode }) {
  return (
    <section className="group-wrap" style={{ marginTop: 28 }}>
      <h2 className="group-title">{title}</h2>
      <div className="group">{children}</div>
      {footer && <div className="group-footer">{footer}</div>}
    </section>
  );
}

function useIntegration(provider: string) {
  return useQuery({ queryKey: ['integrations'], queryFn: () => get<{ integrations: IntegrationView[] }>('/integrations'), select: (d) => d.integrations.find((i) => i.provider === provider)! });
}

function SecretInput({ id, value, onChange, isSet, describedBy, placeholder }: { id: string; value: string; onChange: (v: string) => void; isSet: boolean; describedBy?: string; placeholder?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <input
        id={id}
        className="input mono"
        type={show ? 'text' : 'password'}
        autoComplete="off"
        spellCheck={false}
        value={value}
        aria-describedby={describedBy}
        placeholder={isSet ? '•••••••• saved — leave empty to keep' : placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{ paddingRight: 44 }}
      />
      <button type="button" className="icon-btn" style={{ position: 'absolute', right: 2, top: '50%', transform: 'translateY(-50%)' }} aria-label={show ? 'Hide' : 'Show'} onClick={() => setShow(!show)}>
        {show ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  );
}

interface FieldDef {
  key: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
  hint?: ReactNode;
  optional?: boolean;
  type?: string;
}

/** Admin form for a server-wide integration: Save & Test, Test, Disconnect. Secrets are write-only. */
function ServerForm({ provider, fields, intro, onSaved }: { provider: 'jellyfin' | 'seerr' | 'tmdb' | 'trakt'; fields: FieldDef[]; intro?: ReactNode; onSaved?: () => void }) {
  const q = useIntegration(provider);
  const qc = useQueryClient();
  const toast = useToast();
  const refreshMe = useRefreshMe();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const loaded = useRef(false);

  useEffect(() => {
    if (q.data && !loaded.current) {
      loaded.current = true;
      setValues(Object.fromEntries(fields.filter((f) => !f.secret).map((f) => [f.key, String(q.data.config?.[f.key] ?? '')])));
    }
  }, [q.data, fields]);

  if (!q.data) return <CenterLoading />;
  const v = q.data;
  const body = () => ({
    config: Object.fromEntries(fields.filter((f) => !f.secret).map((f) => [f.key, values[f.key] ?? ''])),
    secrets: Object.fromEntries(fields.filter((f) => f.secret).map((f) => [f.key, values[f.key] || undefined])),
  });
  const run = async (kind: 'save' | 'test', e?: FormEvent) => {
    e?.preventDefault();
    setBusy(kind);
    setError(null);
    setResult(null);
    try {
      if (kind === 'save') {
        const r = await put<{ test: TestResult }>(`/integrations/${provider}`, body());
        setResult(r.test);
        setValues((cur) => Object.fromEntries(Object.entries(cur).filter(([k]) => !fields.find((f) => f.key === k)?.secret)));
        toast(r.test.ok ? 'success' : 'error', r.test.ok ? `${SERVICE_COPY[provider]!.name} saved and connected.` : 'Saved, but the connection test failed.');
        await qc.invalidateQueries({ queryKey: ['integrations'] });
        await refreshMe();
        onSaved?.();
      } else {
        const r = await post<{ test: TestResult }>(`/integrations/${provider}/test`, body());
        setResult(r.test);
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };
  const disconnect = async () => {
    await del(`/integrations/${provider}`);
    setConfirm(false);
    loaded.current = false;
    setValues({});
    setResult(null);
    await qc.invalidateQueries({ queryKey: ['integrations'] });
    await refreshMe();
    toast('success', 'Disconnected.');
  };
  const missingRequired = fields.some((f) => !f.optional && !f.secret && !values[f.key]?.trim()) || fields.some((f) => f.secret && !f.optional && !values[f.key] && !v.secretsSet?.[f.key]);

  return (
    <section className="group-wrap" style={{ marginTop: 20 }}>
      <h2 className="group-title">Server Connection</h2>
      <div className="group">
        <div className="row">
          <div className="row-main">
            <div className="row-title">Status</div>
            <div className="row-sub">
              {!v.ready ? 'Not configured' : v.status === 'error' ? `Problem: ${v.lastError}` : v.lastOkAt ? <>Working · last successful contact <Time iso={v.lastOkAt} /></> : 'Saved, not checked yet'}
            </div>
          </div>
          <span className={`dot ${!v.ready ? 'dot-gray' : v.status === 'error' ? 'dot-red' : 'dot-green'}`} aria-hidden />
        </div>
        {v.serverInfo && Object.keys(v.serverInfo).length > 0 && (
          <div className="row">
            <dl className="kv" style={{ margin: 0 }}>
              {Object.entries(v.serverInfo)
                .filter(([, val]) => val !== null && val !== undefined && val !== '')
                .map(([k, val]) => (
                  <div key={k} style={{ display: 'contents' }}>
                    <dt>{k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}</dt>
                    <dd>{String(val)}</dd>
                  </div>
                ))}
            </dl>
          </div>
        )}
        <form className="form-stack" onSubmit={(e) => run('save', e)} style={{ borderTop: '1px solid var(--separator)' }}>
          {intro}
          {fields.map((f) => (
            <Field key={f.key} label={`${f.label}${f.optional ? ' (optional)' : ''}`} hint={f.hint}>
              {(id, d) =>
                f.secret ? (
                  <SecretInput id={id} describedBy={d} value={values[f.key] ?? ''} isSet={Boolean(v.secretsSet?.[f.key])} placeholder={f.placeholder} onChange={(x) => setValues({ ...values, [f.key]: x })} />
                ) : (
                  <input id={id} aria-describedby={d} className="input" type={f.type ?? 'text'} inputMode={f.type === 'url' ? 'url' : undefined} spellCheck={false} autoCapitalize="none" placeholder={f.placeholder} value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
                )
              }
            </Field>
          ))}
          {error && <Banner kind="error">{error}</Banner>}
          {result &&
            (result.ok ? (
              <Banner kind="success" title="Connection works">
                {(result.warnings ?? []).join(' ') || 'Everything checks out.'}
              </Banner>
            ) : (
              <Banner kind="error" title="Connection failed">
                {result.message}
              </Banner>
            ))}
          <div className="form-actions">
            <button className="btn btn-primary" type="submit" disabled={busy !== null || missingRequired}>
              {busy === 'save' && <Spinner />}
              Save and Test
            </button>
            <button className="btn" type="button" onClick={() => run('test')} disabled={busy !== null || missingRequired}>
              {busy === 'test' && <Spinner />}
              Test Without Saving
            </button>
            <span className="spacer" />
            {v.ready && (
              <button type="button" className="btn btn-plain" style={{ color: 'var(--red)' }} onClick={() => setConfirm(true)}>
                Disconnect
              </button>
            )}
          </div>
        </form>
      </div>
      <ConfirmSheet
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={disconnect}
        destructive
        title={`Disconnect ${SERVICE_COPY[provider]!.name}?`}
        confirmLabel="Disconnect"
        message="The stored credentials are deleted. Data synced from this service is removed or marked unknown until you connect again."
      />
    </section>
  );
}

function JobStatus({ job, label }: { job: 'jellyfin' | 'seerr'; label: string }) {
  const { isAdmin } = useUser();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: ['sync-history', job], queryFn: () => get<{ runs: SyncRun[] }>(`/admin/sync/history?job=${job}&limit=5`), enabled: isAdmin, refetchInterval: busy ? 2000 : 30_000 });
  if (!isAdmin) return null;
  const run = async () => {
    setBusy(true);
    try {
      const r = await post<{ finished: boolean; result: { status: string; error: string | null } | null }>(`/admin/sync/${job}`);
      if (r.finished && r.result?.status === 'error') toast('error', r.result.error ?? 'Sync failed.');
      else toast('success', r.finished ? 'Sync finished.' : 'Sync started. It continues in the background.');
    } catch (err) {
      toast('error', errorText(err));
    } finally {
      setBusy(false);
      void q.refetch();
      void qc.invalidateQueries({ queryKey: ['integrations'] });
    }
  };
  return (
    <Section title={label}>
      <div className="row">
        <div className="row-main">
          <div className="row-title">Sync now</div>
          <div className="row-sub">Runs automatically on the interval set in Settings › Sync.</div>
        </div>
        <SyncButton busy={busy} onClick={run} label="Sync Now" />
      </div>
      {q.data?.runs.map((r) => (
        <div key={r.id} className="row">
          <span className={`dot ${r.status === 'ok' ? 'dot-green' : r.status === 'error' ? 'dot-red' : r.status === 'running' ? 'dot-orange' : 'dot-gray'}`} aria-hidden />
          <div className="row-main">
            <div className="subhead">
              <Time iso={r.started_at} /> · {r.trigger} · {r.status}
            </div>
            <div className="row-sub">{r.error ?? Object.entries(r.stats).filter(([k]) => k !== 'durationMs').map(([k, v]) => `${k}: ${v}`).join(' · ')}</div>
          </div>
        </div>
      ))}
    </Section>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  const toast = useToast();
  return (
    <div className="row">
      <div className="row-main">
        <div className="row-sub">{label}</div>
        <div className="mono" style={{ overflowWrap: 'anywhere' }}>
          {value}
        </div>
      </div>
      <button
        className="icon-btn"
        aria-label={`Copy ${label}`}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => toast('success', 'Copied.'));
        }}
      >
        <Copy size={16} />
      </button>
    </div>
  );
}

function WebhookSection({ target }: { target: 'seerr' | 'jellyfin' }) {
  const q = useQuery({ queryKey: ['webhook'], queryFn: () => get<{ token: string }>('/integrations/webhook') });
  const qc = useQueryClient();
  if (!q.data) return null;
  const url = `${window.location.origin}/api/webhooks/${target}`;
  return (
    <Section
      title="Instant Updates (Optional)"
      footer={
        target === 'seerr' ? (
          <>In Seerr open Settings › Notifications › Webhook, enable it, paste the URL, set Authorization Header to the value above, and select the request notification types. Without a webhook, JellyWatcher checks Seerr on a schedule.</>
        ) : (
          <>Install the official Jellyfin Webhook plugin, add a Generic destination with this URL, add a header “Authorization” with the value above, and enable “Item Added”. Without it, JellyWatcher checks Jellyfin on a schedule.</>
        )
      }
    >
      <CopyField label="Webhook URL" value={url} />
      <CopyField label="Authorization header" value={`Bearer ${q.data.token}`} />
      <div className="row">
        <div className="row-main row-sub">The webhook only triggers a sync; JellyWatcher never trusts its contents.</div>
        <button
          className="btn btn-small btn-gray"
          onClick={async () => {
            await post('/integrations/webhook/regenerate');
            void qc.invalidateQueries({ queryKey: ['webhook'] });
          }}
        >
          Regenerate
        </button>
      </div>
    </Section>
  );
}

function JellyfinPage() {
  const { isAdmin, user, services } = useUser();
  const refreshMe = useRefreshMe();
  const toast = useToast();
  const [form, setForm] = useState({ username: user.jellyfin?.username ?? user.username, password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quick, setQuick] = useState(false);

  const link = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/connections/jellyfin', form);
      toast('success', 'Jellyfin account linked. Viewing progress appears after the next sync.');
      setForm({ ...form, password: '' });
      await refreshMe();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const unlink = async () => {
    try {
      await del('/connections/jellyfin');
      await refreshMe();
    } catch (err) {
      toast('error', errorText(err));
    }
  };

  return (
    <>
      <Header provider="jellyfin" title="Jellyfin" subtitle="The source of truth for what’s in your library and what you’ve watched. JellyWatcher only reads from Jellyfin." />
      {isAdmin && (
        <ServerForm
          provider="jellyfin"
          fields={[
            { key: 'url', label: 'Server URL', type: 'url', placeholder: 'http://jellyfin:8096', hint: 'The address JellyWatcher’s container uses to reach Jellyfin, e.g. a container name on the same Docker network, a LAN IP, or a public URL. Include any base path.' },
            { key: 'publicUrl', label: 'Browser URL', type: 'url', optional: true, placeholder: 'https://jellyfin.example.com', hint: 'Used for “Play in Jellyfin” links if browsers reach Jellyfin at a different address.' },
            { key: 'apiKey', label: 'API key', secret: true, placeholder: 'Paste the key', hint: 'Created automatically when you set JellyWatcher up with Jellyfin. To replace it: Jellyfin › Dashboard › API Keys › +, name it “JellyWatcher”. It is stored encrypted and never shown again.' },
          ]}
        />
      )}
      {!isAdmin && !services.jellyfin && <Banner kind="info">An administrator needs to connect the Jellyfin server first.</Banner>}
      {services.jellyfin && (
        <Section title="Your Jellyfin Account" footer="Linking proves the account is yours by signing in once. Only your Jellyfin user ID is kept; the password and session are discarded immediately.">
          {user.jellyfin ? (
            <div className="row">
              <div className="row-main">
                <div className="row-title">Linked as {user.jellyfin.username}</div>
                <div className="row-sub">Your watched status and progress come from this account.</div>
              </div>
              <button className="btn btn-gray btn-small" onClick={unlink}>
                Unlink
              </button>
            </div>
          ) : quick ? (
            <div className="form-stack">
              <QuickConnectPanel
                start={() => post<QuickConnectStart>('/connections/jellyfin/quick-connect')}
                poll={(id) => post('/connections/jellyfin/quick-connect/poll', { id })}
                onAuthorized={async () => {
                  toast('success', 'Jellyfin account linked. Viewing progress appears after the next sync.');
                  setQuick(false);
                  await refreshMe();
                }}
                onCancel={() => setQuick(false)}
              />
            </div>
          ) : (
            <form className="form-stack" onSubmit={link}>
              <Field label="Jellyfin username">{(id) => <input id={id} className="input" autoComplete="username" autoCapitalize="none" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />}</Field>
              <Field label="Jellyfin password">{(id) => <input id={id} className="input" type="password" autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />}</Field>
              {error && <Banner kind="error">{error}</Banner>}
              <div className="form-actions">
                <button className="btn btn-primary" type="submit" disabled={busy || !form.username}>
                  {busy && <Spinner />}
                  Link Account
                </button>
                <button className="btn btn-gray" type="button" onClick={() => setQuick(true)}>
                  <Smartphone size={15} aria-hidden /> Use Quick Connect
                </button>
              </div>
            </form>
          )}
        </Section>
      )}
      {isAdmin && services.jellyfin && <JobStatus job="jellyfin" label="Library Sync" />}
      {isAdmin && services.jellyfin && <WebhookSection target="jellyfin" />}
    </>
  );
}

function SeerrPage() {
  const { isAdmin, user, services } = useUser();
  return (
    <>
      <Header provider="seerr" title="Seerr" subtitle="Requests go to Seerr, and Seerr decides approvals, quotas and downloads. Works with Overseerr and Jellyseerr too." />
      {isAdmin && (
        <ServerForm
          provider="seerr"
          fields={[
            { key: 'url', label: 'Server URL', type: 'url', placeholder: 'http://seerr:5055', hint: 'The address JellyWatcher’s container uses to reach Seerr. Do not add /api/v1.' },
            { key: 'publicUrl', label: 'Browser URL', type: 'url', optional: true, placeholder: 'https://requests.example.com', hint: 'Used for “Open in Seerr” links.' },
            { key: 'apiKey', label: 'API key', secret: true, placeholder: 'Paste the key', hint: 'In Seerr: Settings › General › API Key. It grants administrator access; JellyWatcher uses it to make requests on behalf of each linked user, so their own permissions and quotas apply.' },
          ]}
        />
      )}
      {!isAdmin && !services.seerr && <Banner kind="info">An administrator needs to connect Seerr first.</Banner>}
      {services.seerr && (
        <Section title="Your Seerr Account" footer={isAdmin ? <>Accounts link automatically when the Jellyfin account matches a Seerr user. Otherwise link them in <Link to="/settings/users">Settings › Users</Link>.</> : 'Accounts link automatically when your Jellyfin account matches your Seerr user. Otherwise an administrator links them.'}>
          <div className="row">
            <div className="row-main">
              <div className="row-title">{user.seerr ? `Requests are made as ${user.seerr.username ?? `user #${user.seerr.userId}`}` : 'Not linked'}</div>
              <div className="row-sub">{user.seerr ? 'Approval rules and quotas of this Seerr user apply.' : 'You need a linked Seerr user to request titles.'}</div>
            </div>
            <span className={`dot ${user.seerr ? 'dot-green' : 'dot-gray'}`} aria-hidden />
          </div>
        </Section>
      )}
      {isAdmin && services.seerr && <JobStatus job="seerr" label="Request Sync" />}
      {isAdmin && services.seerr && <WebhookSection target="seerr" />}
    </>
  );
}

function TmdbPage() {
  const { isAdmin, services } = useUser();
  return (
    <>
      <Header provider="tmdb" title="TMDb" subtitle="Artwork, synopses, genres and identifier matching for imported titles." />
      {!services.tmdb && services.seerr && (
        <Banner kind="info" title="Optional while Seerr is connected">
          Without a TMDb token, JellyWatcher uses Seerr’s built-in TMDb access. A token of your own is faster for large imports and keeps working if Seerr is down.
        </Banner>
      )}
      {isAdmin ? (
        <ServerForm
          provider="tmdb"
          fields={[
            {
              key: 'token',
              label: 'API Read Access Token',
              secret: true,
              placeholder: 'eyJhbGciOi…',
              hint: (
                <>
                  Free for personal use. Sign in at themoviedb.org, open Settings › API, and copy the long “API Read Access Token” (not the shorter API key).{' '}
                  <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer noopener">
                    Open TMDb settings <ExternalLink size={12} aria-hidden />
                  </a>
                </>
              ),
            },
          ]}
        />
      ) : (
        <Banner kind="info">{services.tmdb ? 'TMDb is connected.' : 'An administrator can add a TMDb token.'}</Banner>
      )}
      <p className="footnote secondary" style={{ marginTop: 20 }}>
        This product uses the TMDB API but is not endorsed or certified by TMDB.
      </p>
    </>
  );
}

interface DeviceState {
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
}

function TraktPage() {
  const { isAdmin, services } = useUser();
  const qc = useQueryClient();
  const toast = useToast();
  const invalidate = useInvalidateLists();
  const sources = useQuery({ queryKey: ['sources'], queryFn: () => get<SourcesResponse>('/sources') });
  const [device, setDevice] = useState<DeviceState | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const timer = useRef<number | null>(null);
  const conn = sources.data?.sources.find((s) => s.id === 'trakt')?.connection ?? null;

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);

  const poll = (delay: number) => {
    timer.current = window.setTimeout(async () => {
      try {
        const r = await post<{ status: string; retryIn?: number }>('/connections/trakt/poll');
        if (r.status === 'authorized') {
          setDevice(null);
          setStatus(null);
          toast('success', 'Trakt connected. Your watchlist is being imported.');
          await qc.invalidateQueries({ queryKey: ['sources'] });
          invalidate();
          return;
        }
        if (r.status === 'pending') return poll((r.retryIn ?? 5) * 1000);
        setDevice(null);
        setError(r.status === 'expired' ? 'The code expired. Start again.' : r.status === 'denied' ? 'Access was denied on Trakt.' : 'Sign-in could not be completed. Start again.');
      } catch (err) {
        setDevice(null);
        setError(errorText(err));
      }
    }, delay);
  };
  const start = async () => {
    setError(null);
    try {
      const r = await post<{ userCode: string; verificationUrl: string; expiresIn: number; interval: number }>('/connections/trakt/device');
      setDevice({ userCode: r.userCode, verificationUrl: r.verificationUrl, expiresAt: Date.now() + r.expiresIn * 1000 });
      setStatus('Waiting for you to approve on Trakt…');
      poll(r.interval * 1000);
    } catch (err) {
      setError(errorText(err));
    }
  };
  const disconnect = async () => {
    await del('/connections/trakt?removeLists=1');
    setConfirm(false);
    await qc.invalidateQueries({ queryKey: ['sources'] });
    invalidate();
    toast('success', 'Trakt disconnected.');
  };

  return (
    <>
      <Header provider="trakt" title="Trakt" subtitle="Sync your watchlist, your lists, lists you liked, and any public list." />
      {isAdmin && (
        <ServerForm
          provider="trakt"
          intro={
            <Banner kind="info" title="One-time setup for this server">
              <ol style={{ paddingLeft: 18, margin: '4px 0 0' }}>
                <li>
                  Create a Trakt API app at{' '}
                  <a href="https://trakt.tv/oauth/applications/new" target="_blank" rel="noreferrer noopener">
                    trakt.tv/oauth/applications
                  </a>{' '}
                  (Trakt requires a verified GitHub-linked account for new apps).
                </li>
                <li>
                  Name it “JellyWatcher”. For Redirect URI enter <span className="mono">urn:ietf:wg:oauth:2.0:oob</span> or your JellyWatcher URL; device sign-in doesn’t use it.
                </li>
                <li>Copy the Client ID and Client Secret here.</li>
              </ol>
              <div style={{ marginTop: 6 }}>Trakt deletes apps that go unused for 30 days, and free Trakt accounts can connect two community apps.</div>
            </Banner>
          }
          fields={[
            { key: 'clientId', label: 'Client ID', placeholder: '64-character ID' },
            { key: 'clientSecret', label: 'Client Secret', secret: true, optional: true, placeholder: 'Recommended' },
          ]}
        />
      )}
      {!services.trakt ? (
        !isAdmin && <Banner kind="info">An administrator needs to add a Trakt API app before you can connect.</Banner>
      ) : (
        <Section title="Your Trakt Account" footer="JellyWatcher reads your lists; it never changes anything on Trakt. Tokens are stored encrypted and refreshed automatically.">
          {conn && !device ? (
            <>
              <div className="row">
                <div className="row-main">
                  <div className="row-title">Signed in as {conn.accountName}</div>
                  <div className="row-sub">
                    {conn.status === 'needs_reauth' ? <span style={{ color: 'var(--red)' }}>Sign-in expired: {conn.lastError}</span> : conn.lastSyncedAt ? <>Last synced <Time iso={conn.lastSyncedAt} /></> : 'Connected'}
                  </div>
                </div>
                {conn.status === 'needs_reauth' ? (
                  <button className="btn btn-primary btn-small" onClick={start}>
                    Reconnect
                  </button>
                ) : (
                  <span className="dot dot-green" aria-hidden />
                )}
              </div>
              <div className="row">
                <div className="row-main">
                  <div className="row-title">Lists</div>
                  <div className="row-sub">{plural(sources.data?.sources.find((s) => s.id === 'trakt')?.listCount ?? 0, 'Trakt list')} added</div>
                </div>
                <button className="btn btn-small" onClick={() => setAdding(true)}>
                  Add Lists
                </button>
              </div>
              <div className="row">
                <div className="row-main row-sub">Disconnecting revokes the token and removes your watchlist and own lists. Public lists stay.</div>
                <button className="btn btn-plain btn-small" style={{ color: 'var(--red)' }} onClick={() => setConfirm(true)}>
                  Disconnect
                </button>
              </div>
            </>
          ) : device ? (
            <div className="form-stack" style={{ textAlign: 'center' }}>
              <div className="subhead secondary">
                Open{' '}
                <a href={device.verificationUrl} target="_blank" rel="noreferrer noopener">
                  {device.verificationUrl.replace(/^https?:\/\//, '')} <ExternalLink size={12} aria-hidden />
                </a>{' '}
                on any device and enter this code:
              </div>
              <div className="code-box" aria-label={`Code ${device.userCode.split('').join(' ')}`}>
                {device.userCode}
              </div>
              <div className="inline secondary subhead" style={{ justifyContent: 'center' }} aria-live="polite">
                <Spinner /> {status}
              </div>
              <div>
                <button
                  className="btn btn-gray btn-small"
                  onClick={() => {
                    if (timer.current) window.clearTimeout(timer.current);
                    setDevice(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="row">
              <div className="row-main">
                <div className="row-title">Not connected</div>
                <div className="row-sub">Connect to import your watchlist and your own lists. Public lists work without connecting.</div>
              </div>
              <button className="btn btn-primary btn-small" onClick={start}>
                Connect Trakt
              </button>
            </div>
          )}
        </Section>
      )}
      {error && (
        <div style={{ marginTop: 14 }}>
          <Banner kind="error" action={<button className="btn btn-small" onClick={start}><RefreshCw size={13} aria-hidden /> Try Again</button>}>
            {error}
          </Banner>
        </div>
      )}
      <p className="footnote secondary" style={{ marginTop: 20 }}>
        JellyWatcher uses Trakt but is not endorsed or certified by Trakt.
      </p>
      <AddListSheet open={adding} onClose={() => setAdding(false)} initial="trakt" />
      <ConfirmSheet open={confirm} onClose={() => setConfirm(false)} onConfirm={disconnect} destructive title="Disconnect Trakt?" confirmLabel="Disconnect" message="Your Trakt token is revoked, and your Trakt watchlist and own lists are removed from JellyWatcher. Requests stay in Seerr." />
    </>
  );
}

function LetterboxdPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const sources = useQuery({ queryKey: ['sources'], queryFn: () => get<SourcesResponse>('/sources') });
  const conn = sources.data?.sources.find((s) => s.id === 'letterboxd')?.connection ?? null;
  const desc = sources.data?.sources.find((s) => s.id === 'letterboxd');
  const [username, setUsername] = useState('');
  const [rss, setRss] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (conn) {
      setUsername(conn.accountName ?? '');
      setRss(conn.config.rss !== false);
    }
  }, [conn]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await put('/connections/letterboxd', { username: username.trim(), rss });
      toast('success', rss ? 'Saved. Your recent diary is synced from RSS.' : 'Saved.');
      await qc.invalidateQueries({ queryKey: ['sources'] });
      void qc.invalidateQueries({ queryKey: ['lists'] });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Header provider="letterboxd" title="Letterboxd" subtitle="Add public lists by link, import your export, and sync your diary." />
      <Banner kind="info" title="No sign-in needed">
        Letterboxd doesn’t grant API access to personal or self-hosted projects. Public lists and watchlists are added by their link and read from the public page; private lists and your full history come from an export you download yourself.
      </Banner>
      {desc?.link && (
        <Section title="Add a List by Link">
          <div className="form-stack">
            <LinkForm placeholder={desc.link.example} hint={desc.link.hint} />
          </div>
        </Section>
      )}
      <Section title="Upload an Export">
        <div className="form-stack">
          <UploadInstructions provider="letterboxd" />
          <UploadBox provider="letterboxd" />
        </div>
      </Section>
      <Section title="Recent Diary via RSS (Optional)" footer="Your public RSS feed lists your ~50 most recent diary entries with TMDb IDs. It updates automatically but doesn’t include your watchlist.">
        <form className="form-stack" onSubmit={save}>
          <Field label="Letterboxd username">{(id) => <input id={id} className="input" autoCapitalize="none" spellCheck={false} placeholder="yourname" value={username} onChange={(e) => setUsername(e.target.value)} />}</Field>
          <label className="inline">
            <Toggle checked={rss} onChange={setRss} label="Sync my diary from RSS" />
            Sync my diary from RSS
          </label>
          {error && <Banner kind="error">{error}</Banner>}
          <div className="form-actions">
            <button className="btn btn-primary" type="submit" disabled={busy || !username.trim()}>
              {busy && <Spinner />}
              Save
            </button>
            {conn && (
              <button
                type="button"
                className="btn btn-plain"
                style={{ color: 'var(--red)' }}
                onClick={async () => {
                  await del('/connections/letterboxd');
                  setUsername('');
                  await qc.invalidateQueries({ queryKey: ['sources'] });
                  void qc.invalidateQueries({ queryKey: ['lists'] });
                }}
              >
                Remove
              </button>
            )}
          </div>
        </form>
      </Section>
      {desc && (
        <Section title="Limitations">
          {desc.limitations.map((l) => (
            <div key={l} className="row subhead">
              {l}
            </div>
          ))}
        </Section>
      )}
    </>
  );
}

/** Route /integrations/sources/:source — link and file import for one watchlist source. */
export function SourceDetail() {
  const id = useParams().source ?? '';
  if (!['imdb', 'tmdb', 'myanimelist', 'anilist', 'simkl', 'mdblist'].includes(id)) return <Navigate to="/integrations" replace />;
  return (
    <>
      <Link to="/integrations" className="back-link">
        <ChevronLeft size={18} aria-hidden /> Integrations
      </Link>
      <SourcePage id={id as SourceId} />
    </>
  );
}

function SourcePage({ id }: { id: SourceId }) {
  const { isAdmin } = useUser();
  const sources = useQuery({ queryKey: ['sources'], queryFn: () => get<SourcesResponse>('/sources') });
  if (sources.isLoading) return <CenterLoading />;
  const desc = sources.data?.sources.find((s) => s.id === id);
  if (!desc) return <Navigate to="/integrations" replace />;
  return (
    <>
      <Header provider={id} title={desc.name} subtitle={desc.summary} />
      {desc.link && (
        <Section title="Add a List by Link" footer={desc.linkReady ? undefined : desc.limitations[0]}>
          <div className="form-stack">
            {desc.linkReady ? (
              <LinkForm placeholder={desc.link.example} hint={desc.link.hint} />
            ) : (
              <Banner kind="warn" action={isAdmin ? <Link className="btn btn-small" to="/integrations/tmdb">Set Up</Link> : undefined}>
                Links need a server connection that isn’t set up yet.
              </Banner>
            )}
          </div>
        </Section>
      )}
      {desc.upload && (
        <Section title={desc.link ? 'Or Import a File' : 'Import a File'}>
          <div className="form-stack">
            <UploadInstructions provider={id as UploadSource} />
            <UploadBox provider={id as UploadSource} />
          </div>
        </Section>
      )}
      <Section title="Limitations">
        {desc.limitations.map((l) => (
          <div key={l} className="row subhead">
            {l}
          </div>
        ))}
      </Section>
    </>
  );
}
