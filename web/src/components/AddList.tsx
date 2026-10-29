import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Heart, Link2, Plus, Search, Upload } from 'lucide-react';
import { api, errorText, get, post, qs } from '../lib/api';
import { useToast, useUser } from '../lib/session';
import type { ListView, SourceDescriptor, SourceId, SourcesResponse, TraktListInfo, UploadSource } from '../lib/types';
import { plural } from '../lib/format';
import { Banner, ProviderMark, Segmented, Sheet, Spinner } from './ui';

export function useInvalidateLists() {
  const qc = useQueryClient();
  return () => {
    for (const k of ['lists', 'catalog', 'home', 'review', 'sources']) void qc.invalidateQueries({ queryKey: [k] });
  };
}

/** File upload for Letterboxd / IMDb exports. `replaceListId` updates one existing list. */
/** Renders **bold** in source instructions. */
export function rich(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part));
}

function useDescriptor(id: SourceId): SourceDescriptor | undefined {
  return useUser().sources.find((s) => s.id === id);
}

export function UploadBox({ provider, replaceListId, onDone }: { provider: UploadSource; replaceListId?: number; onDone?: (lists: (ListView & { applied: { added: number; removed: number; total: number; skipped: number } })[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const toast = useToast();
  const invalidate = useInvalidateLists();
  const desc = useDescriptor(provider);
  const accept = desc?.upload?.accept ?? '.csv';
  const label = desc?.upload?.label ?? 'Export file';

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    setResult(null);
    const form = new FormData();
    form.append('provider', provider);
    if (replaceListId) form.append('replaceListId', String(replaceListId));
    form.append('file', file);
    try {
      const res = await api<{ lists: (ListView & { applied: { added: number; removed: number; total: number; skipped: number } })[] }>('/lists/upload', { method: 'POST', form });
      const summary = res.lists.map((l) => `${l.name}: ${plural(l.applied.total, 'title')}${l.applied.skipped ? `, ${l.applied.skipped} skipped` : ''}`).join(' · ');
      setResult(summary);
      toast('success', replaceListId ? 'List updated.' : `Imported ${plural(res.lists.length, 'list')}.`);
      invalidate();
      onDone?.(res.lists);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div className="stack">
      <div
        className={`dropzone${drag ? ' drag' : ''}`}
        role="button"
        tabIndex={0}
        aria-label={`Choose a file to upload: ${label}`}
        onClick={() => input.current?.click()}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), input.current?.click())}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          const f = e.dataTransfer.files[0];
          if (f) void upload(f);
        }}
      >
        {busy ? <Spinner large label="Uploading" /> : <Upload size={26} aria-hidden style={{ margin: '0 auto 8px' }} />}
        <div style={{ fontWeight: 600 }}>{busy ? 'Importing…' : 'Drop a file here or click to choose'}</div>
        <div className="footnote">{label}</div>
      </div>
      <input ref={input} type="file" accept={accept} hidden onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
      {error && <Banner kind="error">{error}</Banner>}
      {result && <Banner kind="success" title="Import finished">{result}. Titles without IDs are matched in the background; check Needs Review afterwards.</Banner>}
    </div>
  );
}

export function UploadInstructions({ provider }: { provider: UploadSource }) {
  const desc = useDescriptor(provider);
  if (!desc?.upload) return null;
  return (
    <ol className="subhead secondary" style={{ paddingLeft: 18, margin: 0 }}>
      {desc.upload.steps.map((step) => (
        <li key={step}>{rich(step)}</li>
      ))}
    </ol>
  );
}

/** Adds a list from a shared link (any supported source; the server recognises the link). */
export function LinkForm({ hint, placeholder, onAdded }: { hint?: string; placeholder?: string; onAdded?: (l: ListView) => void }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const invalidate = useInvalidateLists();
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await post<{ list: ListView }>('/lists/link', { url: url.trim() });
      if (res.list.lastStatus === 'error') toast('error', `Added, but the first sync failed: ${res.list.lastError}`);
      else toast('success', `Added “${res.list.name}” with ${plural(res.list.itemCount, 'entry', 'entries')}.`);
      setUrl('');
      invalidate();
      onAdded?.(res.list);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="field">
        <span className="field-label">List link</span>
        <div className="inline" style={{ flexWrap: 'nowrap' }}>
          <input className="input" type="url" inputMode="url" placeholder={placeholder ?? 'https://letterboxd.com/…/list/…, https://trakt.tv/users/…/lists/…, …'} value={url} onChange={(e) => setUrl(e.target.value)} />
          <button className="btn btn-primary" type="submit" disabled={!url.trim() || busy}>
            {busy ? <Spinner /> : <Link2 size={15} aria-hidden />}
            Add
          </button>
        </div>
        <span className="field-hint">
          {hint ?? 'Paste a shared link to a public list from IMDb, Trakt, Letterboxd, TMDb, MyAnimeList, AniList or MDBList. No sign-in needed; the list keeps its order and syncs automatically.'}
        </span>
      </label>
      {error && <Banner kind="error">{error}</Banner>}
    </form>
  );
}

function TraktListRow({ l, onAdd, busy }: { l: TraktListInfo; onAdd: () => void; busy: boolean }) {
  return (
    <div className="row">
      <div className="row-main">
        <div className="row-title">{l.name}</div>
        <div className="row-sub">
          {[l.ownerName && `by ${l.ownerName}`, l.itemCount != null && plural(l.itemCount, 'item'), l.likes ? `${l.likes.toLocaleString()} likes` : null].filter(Boolean).join(' · ')}
        </div>
      </div>
      {l.imported ? (
        <span className="pill pill-green">Added</span>
      ) : (
        <button className="btn btn-small" onClick={onAdd} disabled={busy} aria-label={`Add ${l.name}`}>
          {busy ? <Spinner /> : <Plus size={14} aria-hidden />}
          Add
        </button>
      )}
    </div>
  );
}

function TraktPanel({ sources, onAdded }: { sources: SourcesResponse; onAdded: (l: ListView) => void }) {
  const src = sources.sources.find((s) => s.id === 'trakt')!;
  const connected = src.connection && src.connection.status !== 'needs_reauth';
  const [tab, setTab] = useState<'mine' | 'link' | 'search'>(connected ? 'mine' : 'link');
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const invalidate = useInvalidateLists();

  const mine = useQuery({ queryKey: ['trakt-my-lists'], queryFn: () => get<{ watchlistImported: boolean; owned: TraktListInfo[]; liked: TraktListInfo[] }>('/trakt/my-lists'), enabled: Boolean(connected) && tab === 'mine' });
  const search = useQuery({
    queryKey: ['trakt-search', submitted],
    queryFn: () => (submitted ? get<{ lists: TraktListInfo[] }>(`/trakt/lists/search${qs({ q: submitted })}`) : get<{ lists: TraktListInfo[] }>('/trakt/lists/discover?kind=popular')),
    enabled: tab === 'search',
  });

  if (!src.available) {
    return (
      <Banner kind="warn" title="Trakt isn’t set up yet">
        Trakt only answers apps with a Client ID, so an administrator needs to register a free Trakt API app once in Integrations › Trakt. After that, anyone can add public Trakt lists by link without a Trakt account.
      </Banner>
    );
  }

  const add = async (body: Record<string, unknown>, key: string) => {
    setBusyId(key);
    setError(null);
    try {
      const res = await post<{ list: ListView }>('/lists/trakt', body);
      if (res.list.lastStatus === 'error') toast('error', `Added, but the first sync failed: ${res.list.lastError}`);
      else toast('success', `Added “${res.list.name}” with ${plural(res.list.itemCount, 'title')}.`);
      invalidate();
      void mine.refetch();
      void search.refetch();
      onAdded(res.list);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusyId(null);
    }
  };
  const idOf = (l: TraktListInfo) => Number(l.externalId.replace('list:', ''));

  return (
    <div className="stack">
      <Segmented
        label="Trakt list source"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'mine', label: 'Your Lists' },
          { value: 'link', label: 'Paste Link' },
          { value: 'search', label: 'Public Lists' },
        ]}
      />
      {error && <Banner kind="error">{error}</Banner>}
      {tab === 'mine' &&
        (!connected ? (
          <Banner kind="info" title="Connect your Trakt account" action={<Link className="btn btn-small" to="/integrations/trakt">Connect</Link>}>
            Signing in lets JellyWatcher read your watchlist and your own lists. Public lists work without it.
          </Banner>
        ) : mine.isLoading ? (
          <Spinner />
        ) : mine.isError ? (
          <Banner kind="error">{errorText(mine.error)}</Banner>
        ) : (
          mine.data && (
            <>
              <div className="group" style={{ background: 'var(--surface-2)' }}>
                <TraktListRow l={{ externalId: 'watchlist', name: 'Watchlist', kind: 'watchlist', imported: mine.data.watchlistImported }} busy={busyId === 'watchlist'} onAdd={() => add({ mode: 'watchlist' }, 'watchlist')} />
                {mine.data.owned.map((l) => (
                  <TraktListRow key={l.externalId} l={l} busy={busyId === l.externalId} onAdd={() => add({ mode: 'owned', traktId: idOf(l) }, l.externalId)} />
                ))}
              </div>
              {mine.data.liked.length > 0 && (
                <>
                  <div className="group-title inline" style={{ marginTop: 6 }}>
                    <Heart size={13} aria-hidden /> Lists you liked
                  </div>
                  <div className="group" style={{ background: 'var(--surface-2)' }}>
                    {mine.data.liked.map((l) => (
                      <TraktListRow key={l.externalId} l={l} busy={busyId === l.externalId} onAdd={() => add({ mode: 'liked', traktId: idOf(l) }, l.externalId)} />
                    ))}
                  </div>
                </>
              )}
            </>
          )
        ))}
      {tab === 'link' && (
        <LinkForm
          placeholder="https://trakt.tv/users/name/lists/list-name"
          hint="Any public list works without connecting your Trakt account: franchises, watch orders, filmographies, community lists. A user’s public watchlist link works too."
          onAdded={(l) => {
            void mine.refetch();
            onAdded(l);
          }}
        />
      )}
      {tab === 'search' && (
        <>
          <form
            className="inline"
            onSubmit={(e) => {
              e.preventDefault();
              setSubmitted(query.trim());
            }}
          >
            <div className="search-field" style={{ maxWidth: 'none' }}>
              <Search size={16} aria-hidden />
              <input className="input" type="search" placeholder="Search lists, e.g. “Nolan” or “A24”" aria-label="Search public Trakt lists" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <button className="btn" type="submit">
              Search
            </button>
          </form>
          <div className="footnote secondary">{submitted ? `Results for “${submitted}”` : 'Popular on Trakt'}</div>
          {search.isLoading ? (
            <Spinner />
          ) : search.isError ? (
            <Banner kind="error">{errorText(search.error)}</Banner>
          ) : search.data?.lists.length === 0 ? (
            <div className="secondary">No lists found.</div>
          ) : (
            <div className="group" style={{ background: 'var(--surface-2)' }}>
              {search.data?.lists.map((l) => (
                <TraktListRow key={l.externalId} l={l} busy={busyId === l.externalId} onAdd={() => add({ mode: 'public', traktId: idOf(l) }, l.externalId)} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Link and file import for every source except Trakt (which has its own panel). */
function SourcePanel({ source }: { source: SourcesResponse['sources'][number] }) {
  return (
    <>
      {source.link &&
        (source.linkReady ? (
          <LinkForm placeholder={source.link.example} hint={source.link.hint} />
        ) : (
          <Banner kind="warn" title={`${source.name} links need a server connection`}>
            {source.limitations[0]}
          </Banner>
        ))}
      {source.upload && (
        <>
          {source.link && (
            <div className="group-title" style={{ margin: '0 4px -12px' }}>
              Or import a file
            </div>
          )}
          <UploadInstructions provider={source.id as UploadSource} />
          <UploadBox provider={source.id as UploadSource} />
        </>
      )}
    </>
  );
}

export function AddListSheet({ open, onClose, initial }: { open: boolean; onClose: () => void; initial?: SourceId }) {
  const [provider, setProvider] = useState<SourceId | null>(initial ?? null);
  const sources = useQuery({ queryKey: ['sources'], queryFn: () => get<SourcesResponse>('/sources'), enabled: open });
  const close = () => {
    setProvider(initial ?? null);
    onClose();
  };
  const desc = sources.data?.sources.find((s) => s.id === provider);

  return (
    <Sheet open={open} onClose={close} title={provider ? `Add from ${desc?.name ?? ''}` : 'Add a Watchlist'} wide>
      {!sources.data ? (
        <Spinner />
      ) : !provider ? (
        <div className="stack-l">
          <LinkForm onAdded={() => undefined} />
          <div className="group-title" style={{ margin: '0 4px -16px' }}>
            Or choose a source
          </div>
          <div className="group" style={{ background: 'var(--surface-2)' }}>
            {sources.data.sources.map((s) => (
              <button key={s.id} className="row row-link" style={{ width: '100%', border: 0, background: 'none', textAlign: 'left', cursor: 'pointer' }} onClick={() => setProvider(s.id)}>
                <ProviderMark provider={s.id} />
                <div className="row-main">
                  <div className="row-title">{s.name}</div>
                  <div className="row-sub">{s.summary}</div>
                  <div className="caption secondary" style={{ marginTop: 2 }}>
                    {s.method}
                  </div>
                </div>
                <ChevronRight size={18} className="row-chevron" aria-hidden />
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="stack-l">
          {!initial && (
            <button className="back-link btn-plain" style={{ border: 0, background: 'none', cursor: 'pointer', padding: 0 }} onClick={() => setProvider(null)}>
              <ChevronLeft size={16} aria-hidden /> All sources
            </button>
          )}
          {provider === 'trakt' ? <TraktPanel sources={sources.data} onAdded={() => undefined} /> : desc && <SourcePanel source={desc} />}
          {desc && (
            <details>
              <summary className="footnote secondary" style={{ cursor: 'pointer' }}>
                What {desc.name} supports
              </summary>
              <ul className="footnote secondary" style={{ paddingLeft: 18, marginTop: 8 }}>
                {desc.limitations.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </Sheet>
  );
}
