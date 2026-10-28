import { useState, type FormEvent } from 'react';
import { Play } from 'lucide-react';
import { errorText, post } from '../lib/api';
import { useRefreshMe } from '../lib/session';
import { Banner, Field, Spinner } from '../components/ui';

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

export function LoginPage({ jellyfinLogin }: { jellyfinLogin: boolean }) {
  const refresh = useRefreshMe();
  const [mode, setMode] = useState<'local' | 'jellyfin'>('local');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <AuthCard title="Sign In" lede={mode === 'local' ? 'Sign in to your JellyWatcher account.' : 'Sign in with your Jellyfin username and password.'}>
      <form className="stack" onSubmit={submit} noValidate>
        {error && <Banner kind="error">{error}</Banner>}
        <Field label={mode === 'local' ? 'Username' : 'Jellyfin username'}>
          {(id) => <input id={id} className="input" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} required />}
        </Field>
        <Field label="Password">{(id) => <input id={id} className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        <button className="btn btn-primary btn-large" type="submit" disabled={busy || !username}>
          {busy && <Spinner />}
          {mode === 'local' ? 'Sign In' : 'Sign In with Jellyfin'}
        </button>
      </form>
      {jellyfinLogin && (
        <>
          <div className="divider">or</div>
          <button className="btn btn-gray btn-large" style={{ width: '100%' }} onClick={() => setMode(mode === 'local' ? 'jellyfin' : 'local')}>
            {mode === 'local' ? 'Use Your Jellyfin Account' : 'Use a JellyWatcher Account'}
          </button>
        </>
      )}
    </AuthCard>
  );
}

export function SetupPage() {
  const refresh = useRefreshMe();
  const [form, setForm] = useState({ setupCode: '', username: '', displayName: '', password: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  const mismatch = form.confirm.length > 0 && form.confirm !== form.password;
  const short = form.password.length > 0 && form.password.length < 10;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (mismatch || short) return;
    setBusy(true);
    setError(null);
    try {
      await post('/setup', { setupCode: form.setupCode, username: form.username, displayName: form.displayName || undefined, password: form.password });
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Welcome to JellyWatcher" lede="Create the administrator account. You’ll connect Jellyfin, Seerr and your watchlists next.">
      <form className="stack" onSubmit={submit} noValidate>
        {error && <Banner kind="error">{error}</Banner>}
        <Field
          label="Setup code"
          hint={
            <>
              Shown in the container log on first start. Run <span className="mono">docker logs jellywatcher</span> and look for “First-run setup code”. If you set
              <span className="mono"> JW_SETUP_TOKEN</span>, use that value.
            </>
          }
        >
          {(id, d) => <input id={id} aria-describedby={d} className="input mono" autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} value={form.setupCode} onChange={set('setupCode')} />}
        </Field>
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
        <button className="btn btn-primary btn-large" type="submit" disabled={busy || !form.setupCode || !form.username || !form.password || mismatch || short}>
          {busy && <Spinner />}
          Create Administrator
        </button>
      </form>
    </AuthCard>
  );
}
