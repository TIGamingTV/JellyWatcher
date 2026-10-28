import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, NavLink, Route, Routes } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Plus, Trash2, UserPlus } from 'lucide-react';
import { del, errorText, get, patch, post, put } from '../lib/api';
import { useRefreshMe, useToast, useUser } from '../lib/session';
import type { SyncRun } from '../lib/types';
import { bytes, dateTime } from '../lib/format';
import { Banner, CenterLoading, ConfirmSheet, ErrorState, Field, PageHeader, Segmented, Sheet, Spinner, Time, Toggle } from '../components/ui';

export function SettingsPage() {
  const { isAdmin } = useUser();
  const tabs = [
    { to: '/settings', label: 'General', end: true },
    { to: '/settings/account', label: 'Account' },
    ...(isAdmin
      ? [
          { to: '/settings/users', label: 'Users' },
          { to: '/settings/sync', label: 'Sync' },
          { to: '/settings/system', label: 'System' },
        ]
      : []),
    { to: '/settings/about', label: 'About' },
  ];
  return (
    <>
      <PageHeader title="Settings" />
      <nav className="segmented" aria-label="Settings sections" style={{ marginBottom: 24 }}>
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
      <div style={{ maxWidth: 820 }}>
        <Routes>
          <Route index element={<General />} />
          <Route path="account" element={<Account />} />
          {isAdmin && <Route path="users" element={<Users />} />}
          {isAdmin && <Route path="sync" element={<SyncSettings />} />}
          {isAdmin && <Route path="system" element={<SystemInfo />} />}
          <Route path="about" element={<About />} />
          <Route path="*" element={<Navigate to="/settings" replace />} />
        </Routes>
      </div>
    </>
  );
}

function General() {
  const { user } = useUser();
  const refresh = useRefreshMe();
  const toast = useToast();
  const [name, setName] = useState(user.displayName);
  const setPref = async (p: Record<string, string>) => {
    try {
      await put('/me/preferences', p);
      await refresh();
    } catch (err) {
      toast('error', errorText(err));
    }
  };
  return (
    <div className="stack-l">
      <section>
        <h2 className="group-title">Appearance</h2>
        <div className="group">
          <div className="row">
            <div className="row-main">
              <div className="row-title">Theme</div>
              <div className="row-sub">System follows your device’s light or dark setting.</div>
            </div>
            <Segmented
              label="Theme"
              value={user.preferences.appearance ?? 'system'}
              onChange={(v) => setPref({ appearance: v })}
              options={[
                { value: 'system', label: 'System' },
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ]}
            />
          </div>
          <div className="row">
            <div className="row-main">
              <div className="row-title">Poster size</div>
            </div>
            <Segmented
              label="Poster size"
              value={user.preferences.posterSize ?? 'medium'}
              onChange={(v) => setPref({ posterSize: v })}
              options={[
                { value: 'small', label: 'Small' },
                { value: 'medium', label: 'Medium' },
                { value: 'large', label: 'Large' },
              ]}
            />
          </div>
        </div>
      </section>
      <section>
        <h2 className="group-title">Profile</h2>
        <form
          className="group form-stack"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await put('/me/profile', { displayName: name });
              await refresh();
              toast('success', 'Saved.');
            } catch (err) {
              toast('error', errorText(err));
            }
          }}
        >
          <Field label="Display name">{(id) => <input id={id} className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />}</Field>
          <div className="form-actions">
            <button className="btn btn-primary" disabled={!name.trim() || name === user.displayName}>
              Save
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function Account() {
  const { user } = useUser();
  const toast = useToast();
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => get<{ sessions: { id: string; createdAt: string; lastSeenAt: string; userAgent: string | null; ip: string | null; current: boolean }[] }>('/auth/sessions') });
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mismatch = form.confirm.length > 0 && form.confirm !== form.newPassword;

  const change = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await put<{ signedOutSessions: number }>('/auth/password', { currentPassword: form.currentPassword || undefined, newPassword: form.newPassword });
      toast('success', `Password changed.${r.signedOutSessions ? ` Signed out ${r.signedOutSessions} other session(s).` : ''}`);
      setForm({ currentPassword: '', newPassword: '', confirm: '' });
      void sessions.refetch();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-l">
      <section>
        <h2 className="group-title">{user.hasPassword ? 'Change Password' : 'Set a Password'}</h2>
        <form className="group form-stack" onSubmit={change}>
          {!user.hasPassword && <div className="secondary subhead">You sign in with Jellyfin. A JellyWatcher password lets you sign in even if Jellyfin is unavailable.</div>}
          {user.hasPassword && <Field label="Current password">{(id) => <input id={id} className="input" type="password" autoComplete="current-password" value={form.currentPassword} onChange={(e) => setForm({ ...form, currentPassword: e.target.value })} />}</Field>}
          <Field label="New password" hint="At least 10 characters.">
            {(id, d) => <input id={id} aria-describedby={d} className="input" type="password" autoComplete="new-password" value={form.newPassword} onChange={(e) => setForm({ ...form, newPassword: e.target.value })} />}
          </Field>
          <Field label="Confirm new password" error={mismatch ? 'The passwords don’t match.' : null}>
            {(id, d) => <input id={id} aria-describedby={d} aria-invalid={mismatch} className="input" type="password" autoComplete="new-password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} />}
          </Field>
          {error && <Banner kind="error">{error}</Banner>}
          <div className="form-actions">
            <button className="btn btn-primary" disabled={busy || form.newPassword.length < 10 || mismatch || !form.confirm}>
              {busy && <Spinner />}
              {user.hasPassword ? 'Change Password' : 'Set Password'}
            </button>
          </div>
        </form>
      </section>
      <section>
        <h2 className="group-title">Signed-In Devices</h2>
        <div className="group">
          {sessions.data?.sessions.map((s) => (
            <div key={s.id} className="row">
              <div className="row-main">
                <div className="row-title">
                  {describeAgent(s.userAgent)} {s.current && <span className="pill pill-accent">This device</span>}
                </div>
                <div className="row-sub">
                  {s.ip ?? 'Unknown address'} · active <Time iso={s.lastSeenAt} /> · signed in {dateTime(s.createdAt)}
                </div>
              </div>
            </div>
          ))}
          <div className="row">
            <div className="row-main row-sub">Signs out every device except this one.</div>
            <button
              className="btn btn-small btn-gray"
              onClick={async () => {
                const r = await post<{ revoked: number }>('/auth/sessions/revoke-others');
                toast('success', `Signed out ${r.revoked} other session(s).`);
                void sessions.refetch();
              }}
            >
              Sign Out Others
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function describeAgent(ua: string | null) {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return `${browser}${os ? ` on ${os}` : ''}`;
}

interface UserRow {
  id: number;
  username: string;
  displayName: string;
  role: 'admin' | 'user';
  authSource: 'local' | 'jellyfin';
  jellyfinUserId: string | null;
  jellyfinUsername: string | null;
  seerrUserId: number | null;
  seerrUsername: string | null;
  disabled: number;
  lastSeenAt: string | null;
  listCount: number;
}

function Users() {
  const { user: me, services } = useUser();
  const toast = useToast();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['admin-users'], queryFn: () => get<{ users: UserRow[] }>('/admin/users') });
  const jfUsers = useQuery({ queryKey: ['jf-users'], queryFn: () => get<{ users: { id: string; name: string; isAdmin: boolean; disabled: boolean }[] }>('/admin/jellyfin-users'), enabled: services.jellyfin });
  const seerrUsers = useQuery({ queryKey: ['seerr-users'], queryFn: () => get<{ users: { id: number; name: string; jellyfinUserId: string | null }[] }>('/admin/seerr-users'), enabled: services.seerr });
  const settings = useQuery({ queryKey: ['admin-settings'], queryFn: () => get<{ settings: Record<string, number | boolean> }>('/admin/settings') });
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<UserRow | null>(null);

  const update = async (id: number, body: Record<string, unknown>) => {
    try {
      await patch(`/admin/users/${id}`, body);
      await qc.invalidateQueries({ queryKey: ['admin-users'] });
      if (id === me.id) await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (err) {
      toast('error', errorText(err));
    }
  };
  const setSetting = async (k: string, v: boolean) => {
    try {
      await put('/admin/settings', { [k]: v });
      void settings.refetch();
      void qc.invalidateQueries({ queryKey: ['me'] });
    } catch (err) {
      toast('error', errorText(err));
    }
  };

  if (users.isLoading) return <CenterLoading />;
  if (users.isError) return <ErrorState error={users.error} onRetry={() => users.refetch()} />;
  return (
    <div className="stack-l">
      <section>
        <div className="toolbar" style={{ marginBottom: 10 }}>
          <h2 className="group-title" style={{ margin: 0 }}>
            People
          </h2>
          <span className="spacer" />
          {services.seerr && (
            <button
              className="btn btn-small btn-gray"
              onClick={async () => {
                const r = await post<{ linked: number }>('/admin/users/auto-link-seerr');
                toast('success', r.linked ? `Linked ${r.linked} account(s) to Seerr.` : 'No new matches. Seerr users are matched by Jellyfin account.');
                void users.refetch();
              }}
            >
              Match Seerr Users
            </button>
          )}
          <button className="btn btn-small btn-primary" onClick={() => setCreating(true)}>
            <UserPlus size={14} aria-hidden /> Add Person
          </button>
        </div>
        <div className="stack">
          {users.data!.users.map((u) => (
            <div key={u.id} className="group">
              <div className="row">
                <span className="avatar" aria-hidden>
                  {u.displayName.slice(0, 2).toUpperCase()}
                </span>
                <div className="row-main">
                  <div className="row-title">
                    {u.displayName} {u.id === me.id && <span className="pill pill-accent">You</span>} {u.disabled ? <span className="pill pill-red">Disabled</span> : null}
                  </div>
                  <div className="row-sub">
                    {u.username} · {u.authSource === 'jellyfin' ? 'Signs in with Jellyfin' : 'Local account'} · {u.listCount} lists · {u.lastSeenAt ? <>active <Time iso={u.lastSeenAt} /></> : 'never signed in'}
                  </div>
                </div>
                <select className="select select-compact" aria-label={`Role for ${u.displayName}`} value={u.role} disabled={u.id === me.id} onChange={(e) => update(u.id, { role: e.target.value })}>
                  <option value="user">Member</option>
                  <option value="admin">Administrator</option>
                </select>
              </div>
              <div className="row">
                <div className="row-main">
                  <div className="row-sub">Jellyfin account</div>
                </div>
                {services.jellyfin ? (
                  <select className="select select-compact" aria-label={`Jellyfin account for ${u.displayName}`} value={u.jellyfinUserId ?? ''} onChange={(e) => update(u.id, { jellyfinUserId: e.target.value || null })}>
                    <option value="">Not linked</option>
                    {u.jellyfinUserId && !jfUsers.data?.users.some((j) => j.id === u.jellyfinUserId) && <option value={u.jellyfinUserId}>{u.jellyfinUsername ?? 'Unknown account'}</option>}
                    {jfUsers.data?.users.map((j) => (
                      <option key={j.id} value={j.id}>
                        {j.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="row-value">Jellyfin not connected</span>
                )}
              </div>
              <div className="row">
                <div className="row-main">
                  <div className="row-sub">Seerr user (requests are made as)</div>
                </div>
                {services.seerr ? (
                  <select className="select select-compact" aria-label={`Seerr user for ${u.displayName}`} value={u.seerrUserId ?? ''} onChange={(e) => update(u.id, { seerrUserId: e.target.value ? Number(e.target.value) : null })}>
                    <option value="">Not linked</option>
                    {seerrUsers.data?.users.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="row-value">Seerr not connected</span>
                )}
              </div>
              {u.id !== me.id && (
                <div className="row">
                  <label className="inline subhead row-main">
                    <Toggle checked={!u.disabled} onChange={(v) => update(u.id, { disabled: !v })} label={`Allow ${u.displayName} to sign in`} />
                    Can sign in
                  </label>
                  <button className="btn btn-plain btn-small" style={{ color: 'var(--red)' }} onClick={() => setDeleting(u)}>
                    <Trash2 size={14} aria-hidden /> Delete
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>
      {services.jellyfin && settings.data && (
        <section>
          <h2 className="group-title">Sign In with Jellyfin</h2>
          <div className="group">
            <div className="row">
              <div className="row-main">
                <div className="row-title">Allow Jellyfin sign-in</div>
                <div className="row-sub">People can sign in with their Jellyfin username and password.</div>
              </div>
              <Toggle checked={Boolean(settings.data.settings['auth.jellyfinLogin'])} onChange={(v) => setSetting('auth.jellyfinLogin', v)} label="Allow Jellyfin sign-in" />
            </div>
            <div className="row">
              <div className="row-main">
                <div className="row-title">Create accounts automatically</div>
                <div className="row-sub">Anyone with a Jellyfin account on your server gets a member account on first sign-in. Off: only people you add can sign in.</div>
              </div>
              <Toggle checked={Boolean(settings.data.settings['auth.jellyfinAutoCreate'])} disabled={!settings.data.settings['auth.jellyfinLogin']} onChange={(v) => setSetting('auth.jellyfinAutoCreate', v)} label="Create accounts automatically" />
            </div>
          </div>
        </section>
      )}
      {creating && <CreateUserSheet jfUsers={jfUsers.data?.users ?? []} onClose={() => setCreating(false)} />}
      <ConfirmSheet
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        destructive
        title={`Delete ${deleting?.displayName}?`}
        confirmLabel="Delete Person"
        message="Their lists, connections and sessions are deleted. Requests they made remain in Seerr."
        onConfirm={async () => {
          try {
            await del(`/admin/users/${deleting!.id}`);
            setDeleting(null);
            void users.refetch();
          } catch (err) {
            toast('error', errorText(err));
          }
        }}
      />
    </div>
  );
}

function CreateUserSheet({ jfUsers, onClose }: { jfUsers: { id: string; name: string }[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [mode, setMode] = useState<'local' | 'jellyfin'>(jfUsers.length ? 'jellyfin' : 'local');
  const [form, setForm] = useState({ username: '', displayName: '', password: '', role: 'user', jellyfinUserId: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (mode === 'jellyfin' && form.jellyfinUserId) {
      const j = jfUsers.find((x) => x.id === form.jellyfinUserId);
      if (j && !form.username) setForm((f) => ({ ...f, username: j.name.replace(/[^A-Za-z0-9._@-]/g, ''), displayName: j.name }));
    }
  }, [form.jellyfinUserId, mode, jfUsers, form.username]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await post('/admin/users', {
        username: form.username,
        displayName: form.displayName || undefined,
        password: form.password || undefined,
        role: form.role,
        authSource: mode,
        jellyfinUserId: form.jellyfinUserId || undefined,
      });
      toast('success', 'Person added.');
      void qc.invalidateQueries({ queryKey: ['admin-users'] });
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title="Add Person"
      footer={
        <>
          <button className="btn btn-gray" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy || !form.username || (mode === 'local' ? form.password.length < 10 : !form.jellyfinUserId)}>
            {busy && <Spinner />}
            <Plus size={14} aria-hidden /> Add
          </button>
        </>
      }
    >
      <div className="stack">
        {jfUsers.length > 0 && (
          <Segmented
            label="Account type"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'jellyfin', label: 'Jellyfin Account' },
              { value: 'local', label: 'Local Account' },
            ]}
          />
        )}
        {mode === 'jellyfin' && (
          <Field label="Jellyfin account" hint="They sign in with their Jellyfin password. Turn on “Allow Jellyfin sign-in” below.">
            {(id, d) => (
              <select id={id} aria-describedby={d} className="select" value={form.jellyfinUserId} onChange={(e) => setForm({ ...form, jellyfinUserId: e.target.value })}>
                <option value="">Choose…</option>
                {jfUsers.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        <Field label="Username">{(id) => <input id={id} className="input" autoCapitalize="none" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />}</Field>
        <Field label="Display name">{(id) => <input id={id} className="input" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />}</Field>
        {mode === 'local' && (
          <Field label="Password" hint="At least 10 characters. They can change it in Settings › Account.">
            {(id, d) => <input id={id} aria-describedby={d} className="input" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />}
          </Field>
        )}
        <Field label="Role">
          {(id) => (
            <select id={id} className="select" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="user">Member</option>
              <option value="admin">Administrator</option>
            </select>
          )}
        </Field>
        {error && <Banner kind="error">{error}</Banner>}
      </div>
    </Sheet>
  );
}

const INTERVALS: { key: string; label: string; hint: string; min: number; max: number }[] = [
  { key: 'sync.seerrIntervalMinutes', label: 'Seerr requests', hint: 'How often request status is checked. 2–1440 minutes.', min: 2, max: 1440 },
  { key: 'sync.jellyfinIntervalMinutes', label: 'Jellyfin library and progress', hint: '5–1440 minutes. Large libraries take longer per sync.', min: 5, max: 1440 },
  { key: 'sync.listsIntervalMinutes', label: 'Watchlists (Trakt, Letterboxd RSS)', hint: '15–10080 minutes. Uploaded files never sync automatically.', min: 15, max: 10080 },
  { key: 'sync.metadataIntervalMinutes', label: 'Metadata refresh', hint: '60–10080 minutes.', min: 60, max: 10080 },
];

function SyncSettings() {
  const toast = useToast();
  const settings = useQuery({ queryKey: ['admin-settings'], queryFn: () => get<{ settings: Record<string, number | boolean> }>('/admin/settings') });
  const history = useQuery({ queryKey: ['sync-history'], queryFn: () => get<{ runs: SyncRun[] }>('/admin/sync/history?limit=60'), refetchInterval: 10_000 });
  const [values, setValues] = useState<Record<string, number>>({});
  const [running, setRunning] = useState<string | null>(null);
  useEffect(() => {
    if (settings.data) setValues(Object.fromEntries(INTERVALS.map((i) => [i.key, Number(settings.data.settings[i.key])])));
  }, [settings.data]);

  if (settings.isLoading) return <CenterLoading />;
  const save = async () => {
    try {
      await put('/admin/settings', values);
      toast('success', 'Sync intervals saved.');
      void settings.refetch();
    } catch (err) {
      toast('error', errorText(err));
    }
  };
  const run = async (job: string) => {
    setRunning(job);
    try {
      const r = await post<{ finished: boolean; result: { status: string; error: string | null } | null }>(`/admin/sync/${job}`);
      toast(r.result?.status === 'error' ? 'error' : 'success', r.result?.error ?? (r.finished ? 'Done.' : 'Started; it continues in the background.'));
    } catch (err) {
      toast('error', errorText(err));
    } finally {
      setRunning(null);
      void history.refetch();
    }
  };

  return (
    <div className="stack-l">
      <section>
        <h2 className="group-title">Automatic Sync</h2>
        <div className="group form-stack">
          {INTERVALS.map((i) => (
            <Field key={i.key} label={`${i.label} (minutes)`} hint={i.hint}>
              {(id, d) => <input id={id} aria-describedby={d} className="input tabular" type="number" min={i.min} max={i.max} style={{ maxWidth: 160 }} value={values[i.key] ?? ''} onChange={(e) => setValues({ ...values, [i.key]: Number(e.target.value) })} />}
            </Field>
          ))}
          <div className="form-actions">
            <button className="btn btn-primary" onClick={save}>
              Save Intervals
            </button>
          </div>
        </div>
        <p className="group-footer">Failed jobs retry sooner with backoff (5, 10, 20 minutes…), never more often than the interval allows.</p>
      </section>
      <section>
        <h2 className="group-title">Run Now</h2>
        <div className="group">
          {[
            ['seerr', 'Seerr requests and media status'],
            ['jellyfin', 'Jellyfin library and viewing progress'],
            ['lists', 'All automatically synced lists'],
            ['match', 'Match imported titles'],
            ['metadata', 'Refresh artwork and details'],
          ].map(([job, label]) => (
            <div key={job} className="row">
              <div className="row-main">{label}</div>
              <button className="btn btn-small" disabled={running !== null} onClick={() => run(job!)}>
                {running === job && <Spinner />}
                Run
              </button>
            </div>
          ))}
        </div>
      </section>
      <section>
        <h2 className="group-title">History</h2>
        <div className="group table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Job</th>
                <th scope="col">Started</th>
                <th scope="col">Result</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {history.data?.runs.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.job}
                    {r.scope && <div className="caption secondary">{r.scope}</div>}
                  </td>
                  <td className="tabular">
                    <Time iso={r.started_at} />
                    <div className="caption secondary">{r.trigger}</div>
                  </td>
                  <td>
                    <span className={`pill ${r.status === 'ok' ? 'pill-green' : r.status === 'error' ? 'pill-red' : r.status === 'partial' ? 'pill-orange' : ''}`}>{r.status}</span>
                  </td>
                  <td className="footnote">
                    {r.error ?? Object.entries(r.stats).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

interface Diagnostics {
  version: string;
  node: string;
  platform: string;
  uptimeSeconds: number;
  dataDir: string;
  dbSizeBytes: number;
  counts: Record<string, number>;
  migrations: { name: string; appliedAt: string }[];
  runningJobs: string[];
  integrations: { provider: string; status: string; ready: boolean; lastOkAt: string | null; lastError: string | null }[];
  matchStatus: { status: string; n: number }[];
}

function SystemInfo() {
  const q = useQuery({ queryKey: ['diagnostics'], queryFn: () => get<Diagnostics>('/admin/diagnostics') });
  if (q.isLoading) return <CenterLoading />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  return (
    <div className="stack-l">
      <section>
        <h2 className="group-title">Backup</h2>
        <div className="group">
          <div className="row">
            <div className="row-main">
              <div className="row-title">Download a database backup</div>
              <div className="row-sub">A consistent copy taken while running. Credentials inside stay encrypted; restoring also needs your secret.key (or JW_SECRET_KEY).</div>
            </div>
            <a className="btn btn-small" href="/api/admin/backup" download>
              <Download size={14} aria-hidden /> Download
            </a>
          </div>
        </div>
      </section>
      <section>
        <h2 className="group-title">System</h2>
        <div className="group">
          <div className="row">
            <dl className="kv" style={{ margin: 0 }}>
              <dt>Version</dt>
              <dd>{d.version}</dd>
              <dt>Runtime</dt>
              <dd>
                Node {d.node} · {d.platform}
              </dd>
              <dt>Uptime</dt>
              <dd>{Math.round(d.uptimeSeconds / 3600)} hours</dd>
              <dt>Data folder</dt>
              <dd className="mono">{d.dataDir}</dd>
              <dt>Database size</dt>
              <dd>{bytes(d.dbSizeBytes)}</dd>
              <dt>Migrations</dt>
              <dd>{d.migrations.map((m) => m.name).join(', ')}</dd>
              <dt>Running jobs</dt>
              <dd>{d.runningJobs.length ? d.runningJobs.join(', ') : 'None'}</dd>
            </dl>
          </div>
        </div>
      </section>
      <section>
        <h2 className="group-title">Data</h2>
        <div className="group">
          <div className="row">
            <dl className="kv" style={{ margin: 0 }}>
              {Object.entries(d.counts).map(([k, v]) => (
                <div key={k} style={{ display: 'contents' }}>
                  <dt>{k.replace(/_/g, ' ')}</dt>
                  <dd className="tabular">{v.toLocaleString()}</dd>
                </div>
              ))}
              {d.matchStatus.map((m) => (
                <div key={m.status} style={{ display: 'contents' }}>
                  <dt>entries {m.status}</dt>
                  <dd className="tabular">{m.n.toLocaleString()}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </section>
      <section>
        <h2 className="group-title">Integrations</h2>
        <div className="group">
          {d.integrations.map((i) => (
            <div key={i.provider} className="row">
              <span className={`dot ${!i.ready ? 'dot-gray' : i.status === 'error' ? 'dot-red' : 'dot-green'}`} aria-hidden />
              <div className="row-main">
                <div className="row-title">{i.provider}</div>
                <div className="row-sub">{!i.ready ? 'Not configured' : i.lastError ?? (i.lastOkAt ? `OK · ${dateTime(i.lastOkAt)}` : 'Not checked')}</div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function About() {
  const { version } = useUser();
  return (
    <div className="stack-l">
      <section className="panel">
        <h2 className="title-3">JellyWatcher {version}</h2>
        <p className="secondary" style={{ marginTop: 6 }}>
          A self-hosted hub for your watchlists, Seerr requests and Jellyfin library. Your data stays on your server.
        </p>
      </section>
      <section>
        <h2 className="group-title">Data Sources and Attribution</h2>
        <div className="group">
          <div className="row subhead">This product uses the TMDB API but is not endorsed or certified by TMDB.</div>
          <div className="row subhead">JellyWatcher uses Trakt but is not endorsed or certified by Trakt.</div>
          <div className="row subhead">Letterboxd and IMDb data comes only from export files you upload yourself. JellyWatcher is not affiliated with Letterboxd or IMDb.</div>
          <div className="row subhead">Jellyfin and Seerr are open-source projects; JellyWatcher is not affiliated with either.</div>
        </div>
      </section>
    </div>
  );
}
