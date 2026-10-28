import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertTriangle, ExternalLink, ListVideo, Pencil, Plus, Search, Trash2, Upload, Wand2, X } from 'lucide-react';
import { del, errorText, get, patch, post, qs } from '../lib/api';
import { useToast, useUser } from '../lib/session';
import type { ListView, TitleCard } from '../lib/types';
import { LIST_KIND_LABEL, PROVIDER_NAME, plural } from '../lib/format';
import { Banner, CenterLoading, ConfirmSheet, EmptyState, ErrorState, PageHeader, PosterSkeletons, ProviderMark, SearchField, Segmented, Sheet, Spinner, SyncButton, Time, Toggle } from '../components/ui';
import { PosterGrid, PosterImage } from '../components/Poster';
import { AddListSheet, UploadBox, useInvalidateLists } from '../components/AddList';

interface CatalogResponse {
  total: number;
  items: TitleCard[];
  facets: { genres: { name: string; count: number }[] };
}

function useDebounced<T>(value: T, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function WatchlistsPage() {
  const review = useQuery({ queryKey: ['review'], queryFn: () => get<{ items: unknown[]; pending: number }>('/review') });
  const n = review.data?.items.length ?? 0;
  return (
    <>
      <PageHeader title="Watchlists" />
      <nav className="segmented" aria-label="Watchlist views" style={{ marginBottom: 20 }}>
        {[
          { to: '/watchlists', label: 'All Titles', end: true },
          { to: '/watchlists/lists', label: 'Lists' },
          { to: '/watchlists/review', label: n ? `Needs Review (${n})` : 'Needs Review' },
        ].map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end} style={({ isActive }) => segStyle(isActive)}>
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Routes>
        <Route index element={<Catalog />} />
        <Route path="lists" element={<ListsOverview />} />
        <Route path="lists/:id" element={<ListDetail />} />
        <Route path="review" element={<ReviewQueue />} />
        <Route path="*" element={<Navigate to="/watchlists" replace />} />
      </Routes>
    </>
  );
}

function segStyle(active: boolean): React.CSSProperties {
  return {
    display: 'inline-block',
    padding: '5px 14px',
    borderRadius: 7,
    fontWeight: active ? 600 : 500,
    fontSize: '0.875rem',
    color: 'var(--label)',
    background: active ? 'var(--surface)' : 'transparent',
    boxShadow: active ? '0 1px 3px rgba(0,0,0,0.12)' : undefined,
    whiteSpace: 'nowrap',
    textDecoration: 'none',
  };
}

const PAGE = 120;

/** Filterable, searchable catalog. Filter state lives in the URL so views can be shared and restored. */
export function Catalog({ listId }: { listId?: number }) {
  const { user } = useUser();
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');
  const q = useDebounced(text);
  const [limit, setLimit] = useState(PAGE);
  const get_ = (k: string) => params.get(k) ?? '';
  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
    setLimit(PAGE);
  };
  useEffect(() => {
    if ((params.get('q') ?? '') !== q) setParam('q', q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const filters = { listId, q: get_('q'), type: get_('type'), provider: get_('provider'), genre: get_('genre'), availability: get_('availability'), request: get_('request'), viewing: get_('viewing'), sort: get_('sort') };
  const query = useQuery({
    queryKey: ['catalog', filters, limit],
    queryFn: ({ signal }) => get<CatalogResponse>(`/catalog${qs({ ...filters, limit })}`, signal),
    placeholderData: keepPreviousData,
  });
  const active = ['type', 'provider', 'genre', 'availability', 'request', 'viewing'].filter((k) => params.get(k)).length;
  const clear = () => {
    setText('');
    setParams(new URLSearchParams(), { replace: true });
  };

  return (
    <>
      <div className="toolbar-sticky">
        <div className="toolbar">
          <SearchField value={text} onChange={setText} placeholder="Search titles" label="Search titles in your watchlists" />
          <Segmented
            label="Type"
            value={(get_('type') || 'all') as 'all' | 'movie' | 'tv'}
            onChange={(v) => setParam('type', v === 'all' ? '' : v)}
            options={[
              { value: 'all', label: 'All' },
              { value: 'movie', label: 'Movies' },
              { value: 'tv', label: 'Shows' },
            ]}
          />
        </div>
        <div className="toolbar" style={{ marginTop: 10 }}>
          {!listId && (
            <FilterSelect label="Source" value={get_('provider')} onChange={(v) => setParam('provider', v)} options={[['trakt', 'Trakt'], ['letterboxd', 'Letterboxd'], ['imdb', 'IMDb']]} />
          )}
          <FilterSelect label="Library" value={get_('availability')} onChange={(v) => setParam('availability', v)} options={[['in_library', 'In Library'], ['not_in_library', 'Not in Library'], ['unknown', 'Unknown']]} />
          <FilterSelect label="Request" value={get_('request')} onChange={(v) => setParam('request', v)} options={[['not_requested', 'Not Requested'], ['active', 'Requested'], ['available', 'Available in Seerr'], ['declined', 'Declined'], ['failed', 'Failed']]} />
          {user.jellyfin && <FilterSelect label="Watched" value={get_('viewing')} onChange={(v) => setParam('viewing', v)} options={[['unwatched', 'Unwatched'], ['in_progress', 'In Progress'], ['watched', 'Watched']]} />}
          {query.data && query.data.facets.genres.length > 0 && (
            <FilterSelect label="Genre" value={get_('genre')} onChange={(v) => setParam('genre', v)} options={query.data.facets.genres.map((g) => [g.name, `${g.name} (${g.count})`])} />
          )}
          <span className="spacer" />
          <label className="inline footnote secondary">
            Sort
            <select className="select select-compact" value={get_('sort') || (listId ? 'position' : 'added')} onChange={(e) => setParam('sort', e.target.value)} aria-label="Sort by">
              {listId && <option value="position">List Order</option>}
              <option value="added">Date Added</option>
              <option value="title">Title</option>
              <option value="year">Release Year</option>
              <option value="status">Status</option>
            </select>
          </label>
          {(active > 0 || text) && (
            <button className="btn btn-plain btn-small" onClick={clear}>
              <X size={14} aria-hidden /> Clear Filters
            </button>
          )}
        </div>
      </div>

      {query.isLoading ? (
        <PosterSkeletons />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : query.data!.total === 0 ? (
        active > 0 || text ? (
          <EmptyState icon={<Search size={26} />} title="No Matches" actions={<button className="btn" onClick={clear}>Clear Filters</button>}>
            Nothing in your watchlists matches these filters.
          </EmptyState>
        ) : listId ? (
          <EmptyState icon={<ListVideo size={26} />} title="This List Is Empty">
            Titles appear here after the list syncs and its entries are matched.
          </EmptyState>
        ) : (
          <EmptyState icon={<ListVideo size={26} />} title="No Titles Yet" actions={<Link className="btn btn-primary" to="/watchlists/lists?add=1">Add a Watchlist</Link>}>
            Add a list from Trakt, Letterboxd or IMDb and its titles show up here, combined and without duplicates.
          </EmptyState>
        )
      ) : (
        <>
          <p className="footnote secondary" aria-live="polite" style={{ marginBottom: 14 }}>
            {plural(query.data!.total, 'title')}
            {query.isFetching && ' · Updating…'}
          </p>
          <PosterGrid items={query.data!.items} size={user.preferences.posterSize} />
          {query.data!.items.length < query.data!.total && (
            <div style={{ textAlign: 'center', marginTop: 28 }}>
              <button className="btn btn-gray" onClick={() => setLimit(limit + PAGE)} disabled={query.isFetching}>
                {query.isFetching && <Spinner />}
                Show More
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <select className="select select-compact" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} style={value ? { background: 'var(--accent-tint)', color: 'var(--accent)' } : undefined}>
      <option value="">{label}: Any</option>
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
}

function syncLine(l: ListView) {
  if (l.lastStatus === 'running') return 'Syncing…';
  if (!l.canSync) return l.lastSyncedAt ? 'Imported' : 'Not imported yet';
  return l.lastSyncedAt ? 'Synced' : 'Never synced';
}

function ListsOverview() {
  const [params, setParams] = useSearchParams();
  const lists = useQuery({ queryKey: ['lists'], queryFn: () => get<{ lists: ListView[] }>('/lists'), refetchInterval: (q) => (q.state.data?.lists.some((l) => l.lastStatus === 'running' || l.pending > 0) ? 4000 : false) });
  const adding = params.get('add') === '1';
  const setAdding = (v: boolean) => setParams(v ? { add: '1' } : {}, { replace: true });
  const grouped = useMemo(() => {
    const g = new Map<string, ListView[]>();
    for (const l of lists.data?.lists ?? []) g.set(l.provider, [...(g.get(l.provider) ?? []), l]);
    return g;
  }, [lists.data]);

  return (
    <>
      <div className="toolbar" style={{ marginBottom: 18 }}>
        <span className="secondary subhead">Each list syncs on its own and feeds the combined catalog.</span>
        <span className="spacer" />
        <button className="btn btn-primary" onClick={() => setAdding(true)}>
          <Plus size={16} aria-hidden /> Add List
        </button>
      </div>
      {lists.isLoading && <CenterLoading />}
      {lists.isError && <ErrorState error={lists.error} onRetry={() => lists.refetch()} />}
      {lists.data && lists.data.lists.length === 0 && (
        <EmptyState icon={<ListVideo size={26} />} title="No Lists Yet" actions={<button className="btn btn-primary" onClick={() => setAdding(true)}>Add a Watchlist</button>}>
          Bring in your Trakt watchlist and lists, public collections like franchises or filmographies, or exports from Letterboxd and IMDb.
        </EmptyState>
      )}
      <div className="stack-l">
        {[...grouped.entries()].map(([provider, ls]) => (
          <section key={provider} aria-labelledby={`p-${provider}`}>
            <h2 className="group-title" id={`p-${provider}`}>
              {PROVIDER_NAME[provider]}
            </h2>
            <div className="list-cards">
              {ls.map((l) => (
                <Link key={l.id} to={`/watchlists/lists/${l.id}`} className="list-card">
                  <ProviderMark provider={l.provider} />
                  <div className="row-main">
                    <div className="row-title" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {l.name}
                    </div>
                    <div className="row-sub">
                      {LIST_KIND_LABEL[l.kind]} · {plural(l.itemCount, 'title')}
                      {l.needsReview > 0 && ` · ${l.needsReview} to review`}
                    </div>
                    <div className="caption secondary inline" style={{ gap: 6, marginTop: 2 }}>
                      {l.lastStatus === 'error' ? (
                        <>
                          <span className="dot dot-red" aria-hidden />
                          Sync failed
                        </>
                      ) : l.lastStatus === 'running' ? (
                        <>
                          <Spinner /> Syncing…
                        </>
                      ) : (
                        <>
                          <span className={`dot ${l.lastSyncedAt ? 'dot-green' : 'dot-gray'}`} aria-hidden />
                          {syncLine(l)} {l.lastSyncedAt && <Time iso={l.lastSyncedAt} />}
                          {l.canSync && !l.autoSync && ' · Manual'}
                        </>
                      )}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
      <AddListSheet open={adding} onClose={() => setAdding(false)} />
    </>
  );
}

function ListDetail() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const toast = useToast();
  const invalidate = useInvalidateLists();
  const q = useQuery({ queryKey: ['lists', id], queryFn: () => get<{ list: ListView }>(`/lists/${id}`), refetchInterval: (s) => (s.state.data?.list.pending ? 4000 : false) });
  const [syncing, setSyncing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [name, setName] = useState('');

  if (q.isLoading) return <CenterLoading />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const l = q.data!.list;

  const sync = async () => {
    setSyncing(true);
    try {
      const r = await post<{ result: { added: number; removed: number; total: number } }>(`/lists/${id}/sync`);
      toast('success', `Synced: ${r.result.added} added, ${r.result.removed} removed.`);
    } catch (err) {
      toast('error', errorText(err));
    } finally {
      setSyncing(false);
      invalidate();
    }
  };
  const remove = async () => {
    await del(`/lists/${id}`);
    invalidate();
    toast('success', `Removed “${l.name}”.`);
    navigate('/watchlists/lists');
  };
  const update = async (body: Record<string, unknown>) => {
    try {
      await patch(`/lists/${id}`, body);
      invalidate();
    } catch (err) {
      toast('error', errorText(err));
    }
  };

  return (
    <>
      <div className="panel" style={{ marginBottom: 20 }}>
        <div className="inline" style={{ alignItems: 'flex-start', gap: 16 }}>
          <ProviderMark provider={l.provider} size={48} />
          <div className="row-main">
            <h2 className="title-2">{l.name}</h2>
            <div className="secondary subhead" style={{ marginTop: 4 }}>
              {PROVIDER_NAME[l.provider]} {LIST_KIND_LABEL[l.kind]?.toLowerCase()}
              {l.ownerName && ` by ${l.ownerName}`} · {plural(l.itemCount, 'entry', 'entries')} · {plural(l.matched, 'matched title')}
            </div>
            {l.description && (
              <p className="subhead" style={{ marginTop: 8, maxWidth: '70ch' }}>
                {l.description}
              </p>
            )}
            <div className="footnote secondary" style={{ marginTop: 6 }}>
              {l.lastSyncedAt ? (
                <>
                  Last successful {l.canSync ? 'sync' : 'import'} <Time iso={l.lastSyncedAt} />
                </>
              ) : (
                'Not synced yet'
              )}
              {l.pending > 0 && ` · Matching ${l.pending} entries…`}
            </div>
          </div>
        </div>
        {l.lastStatus === 'error' && (
          <div style={{ marginTop: 14 }}>
            <Banner kind="error" title="The last sync failed">
              {l.lastError} The titles shown are from the last successful sync.
            </Banner>
          </div>
        )}
        {l.needsReview > 0 && (
          <div style={{ marginTop: 14 }}>
            <Banner kind="warn" action={<Link className="btn btn-small" to="/watchlists/review">Review</Link>}>
              {plural(l.needsReview, 'entry', 'entries')} could not be matched with certainty.
            </Banner>
          </div>
        )}
        <div className="toolbar" style={{ marginTop: 16 }}>
          {l.canSync ? (
            <>
              <SyncButton busy={syncing || l.lastStatus === 'running'} onClick={sync} label="Sync Now" />
              <label className="inline subhead">
                <Toggle checked={l.autoSync} onChange={(v) => update({ autoSync: v })} label="Sync automatically" />
                Sync automatically
              </label>
            </>
          ) : (
            <button className="btn" onClick={() => setReplacing(true)}>
              <Upload size={15} aria-hidden /> Upload New Export
            </button>
          )}
          <span className="spacer" />
          {l.url && (
            <a className="btn btn-plain" href={l.url} target="_blank" rel="noreferrer noopener">
              Open on {PROVIDER_NAME[l.provider]} <ExternalLink size={14} aria-hidden />
            </a>
          )}
          <button
            className="btn btn-plain"
            onClick={() => {
              setName(l.name);
              setRenaming(true);
            }}
          >
            <Pencil size={14} aria-hidden /> Rename
          </button>
          <button className="btn btn-plain" style={{ color: 'var(--red)' }} onClick={() => setConfirmDelete(true)}>
            <Trash2 size={14} aria-hidden /> Remove
          </button>
        </div>
        {!l.canSync && (
          <p className="footnote secondary" style={{ marginTop: 10, marginBottom: 0 }}>
            {PROVIDER_NAME[l.provider]} offers no API for personal projects, so this list updates when you upload a newer export.
          </p>
        )}
      </div>
      <Catalog listId={id} />
      <ConfirmSheet
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={remove}
        destructive
        title={`Remove “${l.name}”?`}
        confirmLabel="Remove List"
        message="The list and its entries are removed from JellyWatcher. Nothing changes on the source service, and requests you made stay in Seerr."
      />
      <Sheet
        open={renaming}
        onClose={() => setRenaming(false)}
        title="Rename List"
        footer={
          <>
            <button className="btn btn-gray" onClick={() => setRenaming(false)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={!name.trim()}
              onClick={async () => {
                await update({ name: name.trim() });
                setRenaming(false);
              }}
            >
              Save
            </button>
          </>
        }
      >
        <label className="field">
          <span className="field-label">Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus />
          {l.canSync && <span className="field-hint">The next sync may restore the name used on {PROVIDER_NAME[l.provider]}.</span>}
        </label>
      </Sheet>
      {(l.provider === 'letterboxd' || l.provider === 'imdb') && (
        <Sheet open={replacing} onClose={() => setReplacing(false)} title="Upload New Export">
          <p className="secondary subhead">Upload the latest CSV for this list. Titles no longer in the file are removed; your match decisions are kept.</p>
          <UploadBox provider={l.provider} replaceListId={l.id} onDone={() => setReplacing(false)} />
        </Sheet>
      )}
    </>
  );
}

interface ReviewItem {
  id: number;
  title: string;
  year: number | null;
  mediaType: 'movie' | 'tv' | null;
  sourceUrl: string | null;
  status: 'review' | 'unmatched';
  confidence: number | null;
  listName: string;
  provider: string;
  candidates: { tmdbId: number; mediaType: 'movie' | 'tv'; title: string; year: number | null; posterUrl: string | null; score: number }[];
}

function ReviewQueue() {
  const q = useQuery({ queryKey: ['review'], queryFn: () => get<{ items: ReviewItem[]; pending: number; metadataSource: string | null }>('/review'), refetchInterval: (s) => (s.state.data?.pending ? 5000 : false) });
  const [open, setOpen] = useState<ReviewItem | null>(null);
  if (q.isLoading) return <CenterLoading />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  return (
    <>
      {!d.metadataSource && (
        <Banner kind="warn" title="Matching is paused">
          Titles without IDs are matched through TMDb or Seerr. An administrator needs to connect one of them in Integrations.
        </Banner>
      )}
      {d.pending > 0 && (
        <div className="inline secondary subhead" style={{ marginBottom: 14 }}>
          <Spinner /> Matching {plural(d.pending, 'entry', 'entries')} in the background…
        </div>
      )}
      {d.items.length === 0 ? (
        <EmptyState icon={<Wand2 size={26} />} title="Nothing to Review">
          Every imported entry is matched. Entries that can’t be matched with certainty appear here.
        </EmptyState>
      ) : (
        <>
          <p className="secondary subhead" style={{ marginBottom: 14 }}>
            These entries had no shared ID and no unambiguous title match. Choose the right title once, and the choice is remembered for future imports.
          </p>
          <div className="group">
            {d.items.map((i) => (
              <button key={i.id} className="row row-link" style={{ width: '100%', border: 0, background: 'none', textAlign: 'left', cursor: 'pointer' }} onClick={() => setOpen(i)}>
                <div className="thumb" style={{ width: 40 }}>
                  <PosterImage src={i.candidates[0]?.posterUrl ?? null} alt="" fallback="" />
                </div>
                <div className="row-main">
                  <div className="row-title">
                    {i.title} {i.year && <span className="secondary">({i.year})</span>}
                  </div>
                  <div className="row-sub">
                    {PROVIDER_NAME[i.provider]} · {i.listName}
                  </div>
                </div>
                {i.status === 'review' ? (
                  <span className="pill pill-orange">{plural(i.candidates.length, 'suggestion')}</span>
                ) : (
                  <span className="pill">
                    <AlertTriangle size={12} aria-hidden /> No match
                  </span>
                )}
              </button>
            ))}
          </div>
        </>
      )}
      {open && <ResolveSheet item={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function ResolveSheet({ item, onClose }: { item: ReviewItem; onClose: () => void }) {
  const [query, setQuery] = useState(item.title);
  const [results, setResults] = useState(item.candidates);
  const [selected, setSelected] = useState<ReviewItem['candidates'][number] | null>(item.status === 'review' ? (item.candidates[0] ?? null) : null);
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const invalidate = useInvalidateLists();

  const search = async () => {
    setSearching(true);
    setError(null);
    try {
      const r = await get<{ results: ReviewItem['candidates'] }>(`/review/search${qs({ q: query, type: item.mediaType ?? undefined })}`);
      setResults(r.results.map((x) => ({ ...x, score: 0 })));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSearching(false);
    }
  };
  const resolve = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const r = await post<{ updated: number }>(`/review/${item.id}`, body);
      toast('success', body.ignore ? 'Entry ignored.' : `Matched ${plural(r.updated, 'entry', 'entries')}.`);
      invalidate();
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
      wide
      title={`Match “${item.title}”`}
      footer={
        <>
          <button className="btn btn-plain" onClick={() => resolve({ ignore: true })} disabled={busy}>
            Ignore Entry
          </button>
          <span className="spacer" />
          <button className="btn btn-gray" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!selected || busy} onClick={() => selected && resolve({ tmdbId: selected.tmdbId, mediaType: selected.mediaType, title: selected.title, year: selected.year })}>
            {busy && <Spinner />}
            Use This Match
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="secondary subhead">
          From {PROVIDER_NAME[item.provider]} “{item.listName}”: <strong>{item.title}</strong>
          {item.year ? ` (${item.year})` : ''}.{' '}
          {item.sourceUrl && (
            <a href={item.sourceUrl} target="_blank" rel="noreferrer noopener">
              View source <ExternalLink size={12} aria-hidden />
            </a>
          )}
        </div>
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <div className="search-field" style={{ maxWidth: 'none' }}>
            <Search size={16} aria-hidden />
            <input className="input" type="search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search for the correct title" />
          </div>
          <button className="btn" type="submit" disabled={searching || !query.trim()}>
            {searching && <Spinner />}
            Search
          </button>
        </form>
        {error && <Banner kind="error">{error}</Banner>}
        {results.length === 0 ? (
          <div className="secondary">No candidates. Try another spelling or the original title.</div>
        ) : (
          <div className="candidate-grid" role="group" aria-label="Candidates">
            {results.map((c) => (
              <button key={`${c.mediaType}-${c.tmdbId}`} className="candidate" aria-pressed={selected?.tmdbId === c.tmdbId && selected.mediaType === c.mediaType} onClick={() => setSelected(c)}>
                <div className="poster-frame" style={{ boxShadow: 'none' }}>
                  <PosterImage src={c.posterUrl} alt="" fallback={c.title} />
                </div>
                <div className="poster-meta">
                  <div className="poster-title">{c.title}</div>
                  <div className="poster-sub">
                    {c.year ?? '—'} · {c.mediaType === 'tv' ? 'Show' : 'Movie'}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </Sheet>
  );
}
