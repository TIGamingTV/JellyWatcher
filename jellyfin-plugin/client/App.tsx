import { useEffect, useState } from 'preact/hooks';
import { LIST_KIND_LABEL, PROVIDER_NAME, duration, plural, relativeTime } from '../../web/src/lib/format';
import type { ListView } from '../../web/src/lib/types';
import { api, ApiError, errorText, type Bootstrap, type PageSettings } from './api';
import { navigate, onOurRoute, routeParams, setTitle } from './jf-dom';
import { TimelineScreen } from './Timeline';
import { Banner, Dialog, Icon, Progress, Spinner, Toasts, useToasts, type Toast } from './ui';

export interface Ctx {
  boot: Bootstrap;
  /** Where "Open in JellyWatcher" links go; null when no browser address is known. */
  webUrl: string | null;
  toast: Toast;
}

function useListId(): number | null {
  const read = () => {
    const n = Number(routeParams().get('list'));
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  const [id, setId] = useState(read);
  useEffect(() => {
    const on = () => onOurRoute() && setId(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return id;
}

export function webLink(base: string | null, path: string): string | null {
  return base ? `${base.replace(/\/+$/, '')}${path}` : null;
}

export function App() {
  const listId = useListId();
  const { toasts, push, dismiss } = useToasts();
  const [settings, setSettings] = useState<PageSettings | null>(null);
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    (async () => {
      const s = await api.settings();
      if (!live) return;
      setSettings(s);
      setTitle(s.menuLabel);
      if (!s.configured) return;
      const b = await api.bootstrap();
      if (live) setBoot(b);
    })().catch((e: unknown) => live && setError(e instanceof Error ? e : new Error(errorText(e))));
    return () => {
      live = false;
    };
  }, [attempt]);

  useEffect(() => {
    if (settings) setTitle(settings.menuLabel);
  });

  let body;
  if (error) {
    const code = error instanceof ApiError ? error.code : '';
    const title =
      code === 'not_invited' ? 'No JellyWatcher account yet' : code === 'disabled' ? 'Account disabled' : code === 'plugin_key' ? 'JellyWatcher rejected the plugin key' : 'Your watchlists could not be loaded';
    body = (
      <Banner kind={code === 'not_invited' ? 'info' : 'error'} title={title} action={code === 'not_invited' || code === 'disabled' ? undefined : <button class="jw-btn" onClick={() => setAttempt((n) => n + 1)}>Try Again</button>}>
        {error.message}
      </Banner>
    );
  } else if (settings && !settings.configured) {
    body = (
      <Banner kind="info" title="Almost there">
        An administrator needs to enter JellyWatcher’s address and plugin key in Jellyfin › Dashboard › Plugins › JellyWatcher.
      </Banner>
    );
  } else if (!settings || !boot) {
    body = (
      <div class="jw-center">
        <Spinner />
      </div>
    );
  } else {
    const ctx: Ctx = { boot, webUrl: boot.webUrl ?? settings.publicUrl, toast: push };
    body = listId ? <TimelineScreen key={listId} id={listId} ctx={ctx} /> : <ListsScreen ctx={ctx} title={settings.menuLabel} />;
  }

  return (
    <div class="jw">
      {body}
      <Toasts toasts={toasts} dismiss={dismiss} />
    </div>
  );
}

export function syncLabel(l: ListView): { text: string; kind: 'busy' | 'error' | 'ok' } | null {
  if (l.lastStatus === 'running') return { text: 'Syncing…', kind: 'busy' };
  if (l.pending > 0) return { text: 'Matching titles…', kind: 'busy' };
  if (l.lastStatus === 'error') return { text: l.lastError ? `Sync failed: ${l.lastError}` : 'Sync failed', kind: 'error' };
  if (l.lastSyncedAt && l.canSync) return { text: `Synced ${relativeTime(l.lastSyncedAt)}`, kind: 'ok' };
  return null;
}

export function listSource(l: ListView): string {
  return l.provider === 'local' ? 'Your list' : `${PROVIDER_NAME[l.provider] ?? l.provider} · ${LIST_KIND_LABEL[l.kind] ?? l.kind}`;
}

function ListsScreen({ ctx, title }: { ctx: Ctx; title: string }) {
  const [lists, setLists] = useState<ListView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    api
      .lists()
      .then((r) => {
        if (!live) return;
        setLists(r.lists);
        setError(null);
      })
      .catch((e: unknown) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [tick]);

  // Keep refreshing while lists sync or titles are being matched.
  const busy = lists?.some((l) => l.lastStatus === 'running' || l.pending > 0) ?? false;
  useEffect(() => {
    if (!busy) return;
    const t = window.setTimeout(() => setTick((n) => n + 1), 4000);
    return () => window.clearTimeout(t);
  }, [busy, lists]);

  const greetingName = ctx.boot.user.displayName || ctx.boot.user.username;
  const web = webLink(ctx.webUrl, '/watchlists');
  return (
    <>
      <div class="jw-head">
        <div>
          <h1>{title}</h1>
          <p class="jw-sub">{lists ? `${plural(lists.length, 'list')} for ${greetingName}` : `For ${greetingName}`}</p>
        </div>
        <div class="jw-head-actions">
          {web && (
            <a class="jw-btn jw-btn-plain" href={web} target="_blank" rel="noopener noreferrer">
              <Icon name="open_in_new" size={18} /> JellyWatcher
            </a>
          )}
          <button class="jw-btn jw-btn-primary" onClick={() => setAdding(true)}>
            <Icon name="add" size={18} /> Add List
          </button>
        </div>
      </div>

      {error && (
        <Banner kind="error" action={<button class="jw-btn" onClick={() => setTick((n) => n + 1)}>Try Again</button>}>
          {error}
        </Banner>
      )}
      {!lists && !error && (
        <div class="jw-center">
          <Spinner />
        </div>
      )}
      {lists && lists.length === 0 && (
        <div class="jw-empty">
          <Icon name="bookmarks" size={44} />
          <h2>No watchlists yet</h2>
          <p>Paste a link to a list from IMDb, Trakt, Letterboxd, TMDb, MyAnimeList, AniList or MDBList, or start your own list.</p>
          <button class="jw-btn jw-btn-primary" onClick={() => setAdding(true)}>
            <Icon name="add" size={18} /> Add List
          </button>
        </div>
      )}
      {lists && lists.length > 0 && (
        <div class="jw-cards">
          {lists.map((l) => (
            <ListCard key={l.id} list={l} />
          ))}
        </div>
      )}
      {adding && (
        <AddListDialog
          ctx={ctx}
          onClose={() => setAdding(false)}
          onAdded={(l) => {
            setAdding(false);
            ctx.toast(l.lastStatus === 'error' ? 'error' : 'success', l.lastStatus === 'error' ? `Added “${l.name}”, but it could not sync: ${l.lastError ?? 'unknown error'}` : `Added “${l.name}”.`);
            navigate({ list: l.id });
          }}
        />
      )}
    </>
  );
}

function ListCard({ list: l }: { list: ListView }) {
  const s = l.summary;
  const pct = s && s.totalMinutes > 0 ? Math.round((s.watchedMinutes / s.totalMinutes) * 100) : 0;
  const status = syncLabel(l);
  const facts = [plural(l.itemCount, 'entry', 'entries'), s && s.totalMinutes > 0 ? (s.remainingMinutes > 0 ? `${duration(s.remainingMinutes)} left` : 'All watched') : null, l.needsReview > 0 ? `${l.needsReview} to review` : null].filter(Boolean);
  return (
    <a class="jw-card" href={`#/jellywatcher?list=${l.id}`}>
      <div class="jw-card-source">{listSource(l)}</div>
      <div class="jw-card-name">{l.name}</div>
      <div class="jw-card-facts">{facts.join(' · ')}</div>
      {s && s.totalMinutes > 0 && <Progress pct={pct} />}
      {status && (
        <div class={`jw-card-status jw-status-${status.kind}`}>
          {status.kind === 'busy' && <Spinner />}
          {status.kind === 'error' && <Icon name="error_outline" size={16} />}
          <span>{status.text}</span>
        </div>
      )}
    </a>
  );
}

function AddListDialog({ ctx, onClose, onAdded }: { ctx: Ctx; onClose: () => void; onAdded: (l: ListView) => void }) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<'link' | 'local' | 'trakt' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (kind: 'link' | 'local' | 'trakt', fn: () => Promise<{ list: ListView }>) => {
    setBusy(kind);
    setError(null);
    try {
      onAdded((await fn()).list);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  const trakt = ctx.boot.trakt;
  const web = webLink(ctx.webUrl, '/watchlists/lists');

  return (
    <Dialog title="Add a Watchlist" onClose={onClose}>
      {error && <Banner kind="error">{error}</Banner>}
      <form
        class="jw-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) void run('link', () => api.addLink(url.trim()));
        }}
      >
        <label class="jw-label" for="jw-link">
          Paste a link to a list
        </label>
        <div class="jw-row-input">
          <input id="jw-link" class="jw-input" type="url" inputMode="url" placeholder="https://www.imdb.com/list/ls…" value={url} onInput={(e) => setUrl(e.currentTarget.value)} autoComplete="off" />
          <button class="jw-btn jw-btn-primary" type="submit" disabled={!url.trim() || busy !== null}>
            {busy === 'link' && <Spinner />} Add
          </button>
        </div>
        <p class="jw-hint">
          IMDb, Trakt, Letterboxd, TMDb, MyAnimeList, AniList and MDBList lists and watchlists. Public lists only; JellyWatcher keeps them in sync.
          {!ctx.boot.tmdb.available && ' TMDb lists need an administrator to add a TMDb token first.'}
        </p>
      </form>

      {trakt.available && trakt.connected && !trakt.watchlistImported && (
        <div class="jw-option">
          <div>
            <div class="jw-option-title">Your Trakt Watchlist</div>
            <div class="jw-hint">From the Trakt account connected in JellyWatcher.</div>
          </div>
          <button class="jw-btn" disabled={busy !== null} onClick={() => run('trakt', api.addTraktWatchlist)}>
            {busy === 'trakt' && <Spinner />} Add
          </button>
        </div>
      )}

      <form
        class="jw-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void run('local', () => api.addLocal(name.trim()));
        }}
      >
        <label class="jw-label" for="jw-local">
          Or start your own list
        </label>
        <div class="jw-row-input">
          <input id="jw-local" class="jw-input" type="text" maxLength={120} placeholder="Name, e.g. Weekend Movies" value={name} onInput={(e) => setName(e.currentTarget.value)} />
          <button class="jw-btn" type="submit" disabled={!name.trim() || busy !== null}>
            {busy === 'local' && <Spinner />} Create
          </button>
        </div>
        {web && <p class="jw-hint">Add titles to your own lists in JellyWatcher.</p>}
      </form>

      {web && (
        <p class="jw-hint jw-more">
          Uploading exports (Letterboxd, IMDb, Simkl, MyAnimeList) and connecting Trakt happen in{' '}
          <a href={web} target="_blank" rel="noopener noreferrer">
            JellyWatcher <Icon name="open_in_new" size={14} />
          </a>
          .
        </p>
      )}
    </Dialog>
  );
}
