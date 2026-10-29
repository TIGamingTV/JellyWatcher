import { useState, type FormEvent } from 'react';
import { ChevronLeft, Play, Server, UserRound } from 'lucide-react';
import { errorText, post, setCsrfToken } from '../lib/api';
import { useRefreshMe } from '../lib/session';
import type { Me, QuickConnectStart } from '../lib/types';
import { Banner, Field, Spinner } from '../components/ui';
import { QuickConnectButton, QuickConnectPanel } from '../components/QuickConnect';

function AuthCard({ title, lede, children }: { title: string; lede: string; children: React.ReactNode }) {
  return (
    <div className="auth-wrap">
      <main className="auth-card">
        <div className="brand-mark" aria-hidden>
          <Play size={24} fill="currentColor" />
        </div>
        <h1 className="title-1">{title}</h1>
        <p className="lede">{lede}</p>
        {children}
      </main>
    </div>
  );
}

function BackButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button className="back-link btn-plain" type="button" style={{ border: 0, background: 'none', cursor: 'pointer', padding: 0 }} onClick={onClick}>
      <ChevronLeft size={16} aria-hidden /> {label}
    </button>
  );
}

/**
 * Sign-in like Seerr: Jellyfin accounts first (password or Quick Connect), local JellyWatcher
 * accounts as the fallback for people without Jellyfin or when Jellyfin is down.
 */
export function LoginPage({ me }: { me: Me }) {
  const refresh = useRefreshMe();
  const jf = me.jellyfinLogin ? me.jellyfin : null;
  const [mode, setMode] = useState<'jellyfin' | 'local' | 'quick'>(me.jellyfinLogin ? 'jellyfin' : 'local');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const server = jf?.serverName ?? null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post(mode === 'local' ? '/auth/login' : '/auth/jellyfin', { username, password });
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const switchTo = (m: typeof mode) => {
    setError(null);
    setMode(m);
  };

  if (mode === 'quick') {
    return (
      <AuthCard title="Quick Connect" lede="Approve this sign-in from any Jellyfin app.">
        <QuickConnectPanel
          serverName={jf?.serverName}
          start={() => post<QuickConnectStart>('/auth/quick-connect')}
          poll={(id) => post('/auth/quick-connect/poll', { id })}
          onAuthorized={async (r) => {
            setCsrfToken(r.csrfToken as string);
            await refresh();
          }}
          onCancel={() => switchTo('jellyfin')}
        />
      </AuthCard>
    );
  }

  const local = mode === 'local';
  return (
    <AuthCard title="Sign In" lede={local ? 'Sign in with your JellyWatcher account.' : `Use your Jellyfin account${server ? ` on ${server}` : ''}.`}>
      <form className="stack" onSubmit={submit} noValidate>
        {error && <Banner kind="error">{error}</Banner>}
        <Field label={local ? 'Username' : 'Jellyfin username'}>
          {(id) => <input id={id} className="input" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} required />}
        </Field>
        <Field label="Password">{(id) => <input id={id} className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        <button className="btn btn-primary btn-large" type="submit" disabled={busy || !username}>
          {busy && <Spinner />}
          {local ? 'Sign In' : 'Sign In with Jellyfin'}
        </button>
      </form>
      {!local && jf?.quickConnect && (
        <div style={{ marginTop: 10 }}>
          <QuickConnectButton onClick={() => switchTo('quick')} />
        </div>
      )}
      {me.jellyfinLogin && (
        <>
          <div className="divider">or</div>
          <button className="btn btn-plain" type="button" style={{ width: '100%' }} onClick={() => switchTo(local ? 'jellyfin' : 'local')}>
            {local ? <Server size={15} aria-hidden /> : <UserRound size={15} aria-hidden />}
            {local ? 'Use Your Jellyfin Account' : 'Use a Local Account'}
          </button>
        </>
      )}
      {!local && jf && !jf.autoCreate && (
        <p className="caption secondary" style={{ textAlign: 'center', margin: '14px 0 0' }}>
          An administrator needs to add your Jellyfin account before you can sign in.
        </p>
      )}
    </AuthCard>
  );
}

type SetupStep = 'choose' | 'jf-server' | 'jf-account' | 'jf-quick' | 'local';

/** First run: claim the instance with the setup code, then connect Jellyfin (like Seerr) or create a local admin. */
export function SetupPage() {
  const refresh = useRefreshMe();
  const [step, setStep] = useState<SetupStep>('choose');
  const [setupCode, setSetupCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jf, setJf] = useState({ url: '', username: '', password: '', allowAll: true });
  const [server, setServer] = useState<{ serverName: string; version: string | null; quickConnect: boolean } | null>(null);
  const [form, setForm] = useState({ username: '', displayName: '', password: '', confirm: '' });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  const mismatch = form.confirm.length > 0 && form.confirm !== form.password;
  const short = form.password.length > 0 && form.password.length < 10;

  const go = (s: SetupStep) => {
    setError(null);
    setStep(s);
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const codeField = (
    <Field
      label="Setup code"
      hint={
        <>
          Shown in the container log on first start. Run <span className="mono">docker logs jellywatcher</span> and look for “First-run setup code”. If you set
          <span className="mono"> JW_SETUP_TOKEN</span>, use that value.
        </>
      }
    >
      {(id, d) => <input id={id} aria-describedby={d} className="input mono" autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} value={setupCode} onChange={(e) => setSetupCode(e.target.value)} />}
    </Field>
  );

  if (step === 'choose') {
    return (
      <AuthCard title="Welcome to JellyWatcher" lede="Connect your Jellyfin server and sign in with its administrator account. Everyone else then signs in with their own Jellyfin account.">
        <div className="stack">
          {codeField}
          <button className="btn btn-primary btn-large" disabled={!setupCode.trim()} onClick={() => go('jf-server')}>
            <Server size={17} aria-hidden /> Set Up with Jellyfin
          </button>
          <button className="btn btn-plain" disabled={!setupCode.trim()} onClick={() => go('local')}>
            Create a Local Administrator Instead
          </button>
        </div>
      </AuthCard>
    );
  }

  if (step === 'jf-server') {
    return (
      <AuthCard title="Your Jellyfin Server" lede="Enter the address JellyWatcher uses to reach Jellyfin.">
        <form
          className="stack"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const r = await post<{ serverName: string; version: string | null; quickConnect: boolean }>('/setup/jellyfin/check', { setupCode, url: jf.url });
              setServer(r);
              setStep('jf-account');
            });
          }}
        >
          <BackButton onClick={() => go('choose')} label="Back" />
          {error && <Banner kind="error">{error}</Banner>}
          <Field label="Server URL" hint="For example http://jellyfin:8096 on the same Docker network, a LAN address, or https://jellyfin.example.com. Include any base path.">
            {(id, d) => <input id={id} aria-describedby={d} className="input" type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="http://jellyfin:8096" value={jf.url} onChange={(e) => setJf({ ...jf, url: e.target.value })} />}
          </Field>
          <button className="btn btn-primary btn-large" type="submit" disabled={busy || !jf.url.trim()}>
            {busy && <Spinner />}
            Continue
          </button>
        </form>
      </AuthCard>
    );
  }

  const allowAll = (
    <label className="inline subhead" style={{ alignItems: 'flex-start', flexWrap: 'nowrap', gap: 10 }}>
      <input type="checkbox" checked={jf.allowAll} onChange={(e) => setJf({ ...jf, allowAll: e.target.checked })} style={{ width: 18, height: 18, marginTop: 2, accentColor: 'var(--accent-fill)', flex: 'none' }} />
      <span>
        Let everyone with an account on this Jellyfin server sign in
        <span className="caption secondary" style={{ display: 'block' }}>
          Off: only people you add in Settings › People. You can change this later.
        </span>
      </span>
    </label>
  );

  if (step === 'jf-quick') {
    return (
      <AuthCard title="Quick Connect" lede={`Approve this setup in ${server?.serverName ?? 'Jellyfin'} with an administrator account.`}>
        {error && <Banner kind="error">{error}</Banner>}
        <QuickConnectPanel
          serverName={server?.serverName}
          start={() => post<QuickConnectStart>('/setup/jellyfin/quick-connect', { setupCode, url: jf.url })}
          poll={(id) => post('/setup/jellyfin/quick-connect/poll', { setupCode, id, allowAll: jf.allowAll })}
          onAuthorized={async (r) => {
            setCsrfToken(r.csrfToken as string);
            await refresh();
          }}
          onCancel={() => go('jf-account')}
        />
      </AuthCard>
    );
  }

  if (step === 'jf-account') {
    return (
      <AuthCard title={`Sign In to ${server?.serverName ?? 'Jellyfin'}`} lede="Use a Jellyfin administrator account. It becomes the JellyWatcher administrator, and JellyWatcher creates its own Jellyfin API key.">
        <form
          className="stack"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const r = await post<{ csrfToken: string }>('/setup/jellyfin', { setupCode, url: jf.url, username: jf.username, password: jf.password, allowAll: jf.allowAll });
              setCsrfToken(r.csrfToken);
              await refresh();
            });
          }}
        >
          <BackButton onClick={() => go('jf-server')} label={server ? `${server.serverName}${server.version ? ` · ${server.version}` : ''}` : 'Back'} />
          {error && <Banner kind="error">{error}</Banner>}
          <Field label="Jellyfin username">
            {(id) => <input id={id} className="input" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={jf.username} onChange={(e) => setJf({ ...jf, username: e.target.value })} />}
          </Field>
          <Field label="Password">{(id) => <input id={id} className="input" type="password" autoComplete="current-password" value={jf.password} onChange={(e) => setJf({ ...jf, password: e.target.value })} />}</Field>
          {allowAll}
          <button className="btn btn-primary btn-large" type="submit" disabled={busy || !jf.username}>
            {busy && <Spinner />}
            Finish Setup
          </button>
          {server?.quickConnect && <QuickConnectButton onClick={() => go('jf-quick')} disabled={busy} />}
        </form>
      </AuthCard>
    );
  }

  const submitLocal = (e: FormEvent) => {
    e.preventDefault();
    if (mismatch || short) return;
    void run(async () => {
      await post('/setup', { setupCode, username: form.username, displayName: form.displayName || undefined, password: form.password });
      await refresh();
    });
  };

  return (
    <AuthCard title="Local Administrator" lede="Create the administrator account. You can connect Jellyfin, Seerr and your watchlists afterwards.">
      <form className="stack" onSubmit={submitLocal} noValidate>
        <BackButton onClick={() => go('choose')} label="Back" />
        {error && <Banner kind="error">{error}</Banner>}
        <Field label="Username">{(id) => <input id={id} className="input" autoComplete="username" autoCapitalize="none" spellCheck={false} value={form.username} onChange={set('username')} />}</Field>
        <Field label="Display name" hint="Optional. Shown in the sidebar and on requests.">
          {(id, d) => <input id={id} aria-describedby={d} className="input" autoComplete="name" value={form.displayName} onChange={set('displayName')} />}
        </Field>
        <Field label="Password" hint="At least 10 characters." error={short ? 'Use at least 10 characters.' : null}>
          {(id, d) => <input id={id} aria-describedby={d} aria-invalid={short} className="input" type="password" autoComplete="new-password" value={form.password} onChange={set('password')} />}
        </Field>
        <Field label="Confirm password" error={mismatch ? 'The passwords don’t match.' : null}>
          {(id, d) => <input id={id} aria-describedby={d} aria-invalid={mismatch} className="input" type="password" autoComplete="new-password" value={form.confirm} onChange={set('confirm')} />}
        </Field>
        <button className="btn btn-primary btn-large" type="submit" disabled={busy || !setupCode || !form.username || !form.password || mismatch || short}>
          {busy && <Spinner />}
          Create Administrator
        </button>
      </form>
    </AuthCard>
  );
}
