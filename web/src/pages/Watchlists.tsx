import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowDownUp, CalendarClock, Copy, ExternalLink, ListPlus, ListVideo, Pencil, Plus, RotateCcw, Search, Trash2, Upload, Wand2, X } from 'lucide-react';
import { del, errorText, get, patch, post, put, qs } from '../lib/api';
import { useToast, useUser } from '../lib/session';
import type { JellyfinMirrorMode, ListView, Timeline, TimelineEntry, TitleCard, UploadSource } from '../lib/types';
import { MIRROR_HINT, MIRROR_INTRO, MIRROR_OPTIONS, mirrorStatus } from '../lib/mirror';
import { LIST_KIND_LABEL, PROVIDER_NAME, duration, plural } from '../lib/format';
import { Banner, CenterLoading, ConfirmSheet, EmptyState, ErrorState, PageHeader, PosterSkeletons, ProviderMark, SearchField, Segmented, Sheet, Spinner, SyncButton, Time, Toggle } from '../components/ui';
import { PosterGrid, PosterImage } from '../components/Poster';
import { AddListSheet, UploadBox, useInvalidateLists } from '../components/AddList';
import { entryHeading, TimelineSummaryPanel, TimelineView } from '../components/Timeline';
import { DiscoverSheet, DuplicateSheet, NewListSheet } from '../components/LocalLists';
import { useQueryClient } from '@tanstack/react-query';

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
          { to: '/watchlists/lists', label: 'Lists' },
          { to: '/watchlists/review', label: n ? `Needs Review (${n})` : 'Needs Review' },
        ].map((t) => (
          <NavLink key={t.to} to={t.to} style={({ isActive }) => segStyle(isActive)}>
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Routes>
        <Route index element={<Navigate to="/watchlists/lists" replace />} />
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

/** Filterable, searchable grid of one list. Filter state lives in the URL so views can be shared and restored. */
function Catalog({ listId }: { listId: number }) {
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

  const filters = { listId, q: get_('q'), type: get_('type'), genre: get_('genre'), availability: get_('availability'), request: get_('request'), viewing: get_('viewing'), sort: get_('sort') };
  const query = useQuery({
    queryKey: ['catalog', filters, limit],
    queryFn: ({ signal }) => get<CatalogResponse>(`/catalog${qs({ ...filters, limit })}`, signal),
    placeholderData: keepPreviousData,
  });
  const active = ['type', 'genre', 'availability', 'request', 'viewing'].filter((k) => params.get(k)).length;
  const clear = () => {
    setText('');
    setParams(new URLSearchParams(), { replace: true });
  };

  return (
    <>
      <div className="toolbar-sticky">
        <div className="toolbar">
          <SearchField value={text} onChange={setText} placeholder="Search this list" label="Search titles in this list" />
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
          <FilterSelect label="Library" value={get_('availability')} onChange={(v) => setParam('availability', v)} options={[['in_library', 'In Library'], ['not_in_library', 'Not in Library'], ['unknown', 'Unknown']]} />
          <FilterSelect label="Request" value={get_('request')} onChange={(v) => setParam('request', v)} options={[['not_requested', 'Not Requested'], ['active', 'Requested'], ['available', 'Available in Seerr'], ['declined', 'Declined'], ['failed', 'Failed']]} />
          <FilterSelect label="Watched" value={get_('viewing')} onChange={(v) => setParam('viewing', v)} options={[['unwatched', 'Unwatched'], ['in_progress', 'In Progress'], ['watched', 'Watched']]} />
          {query.data && query.data.facets.genres.length > 0 && (
            <FilterSelect label="Genre" value={get_('genre')} onChange={(v) => setParam('genre', v)} options={query.data.facets.genres.map((g) => [g.name, `${g.name} (${g.count})`])} />
          )}
          <span className="spacer" />
          <label className="inline footnote secondary">
            Sort
            <select className="select select-compact" value={get_('sort') || 'position'} onChange={(e) => setParam('sort', e.target.value)} aria-label="Sort by">
              <option value="position">List Order</option>
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
            Nothing in this list matches these filters.
          </EmptyState>
        ) : (
          <EmptyState icon={<ListVideo size={26} />} title="This List Is Empty">
            Titles appear here after the list syncs and its entries are matched.
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

function summaryLine(l: ListView) {
  const s = l.summary;
  if (!s) return plural(l.itemCount, 'entry', 'entries');
  const parts = [s.films > 0 && plural(s.films, 'film'), s.shows > 0 && plural(s.shows, 'show'), s.episodes > 0 && plural(s.episodes, 'episode')].filter(Boolean) as string[];
  if (parts.length === 0) parts.push(plural(l.itemCount, 'entry', 'entries'));
  if (l.timeline && s.totalMinutes > 0) parts.push(s.remainingMinutes > 0 ? `${duration(s.remainingMinutes)} left` : 'all watched');
  return parts.join(' · ');
}

function syncLine(l: ListView) {
  if (l.lastStatus === 'running') return 'Syncing…';
  if (l.editable) return 'Kept in JellyWatcher';
  if (!l.canSync) return l.lastSyncedAt ? 'Imported' : 'Not imported yet';
  return l.lastSyncedAt ? 'Synced' : 'Never synced';
}

function ListsOverview() {
  const [params, setParams] = useSearchParams();
  const lists = useQuery({ queryKey: ['lists'], queryFn: () => get<{ lists: ListView[] }>('/lists'), refetchInterval: (q) => (q.state.data?.lists.some((l) => l.lastStatus === 'running' || l.pending > 0) ? 4000 : false) });
  const adding = params.get('add') === '1';
  const setAdding = (v: boolean) => setParams(v ? { add: '1' } : {}, { replace: true });
  const [creating, setCreating] = useState(false);
  const grouped = useMemo(() => {
    const g = new Map<string, ListView[]>();
    for (const l of lists.data?.lists ?? []) g.set(l.provider, [...(g.get(l.provider) ?? []), l]);
    return g;
  }, [lists.data]);

  return (
    <>
      <div className="toolbar" style={{ marginBottom: 18 }}>
        <span className="secondary subhead">Each list keeps its own order and syncs on its own. Drag entries into any order you like.</span>
        <span className="spacer" />
        <button className="btn" onClick={() => setCreating(true)}>
          <ListPlus size={16} aria-hidden /> New List
        </button>
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
              {provider === 'local' ? 'Your Lists' : PROVIDER_NAME[provider]}
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
                      {LIST_KIND_LABEL[l.kind]} · {summaryLine(l)}
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
                          <span className={`dot ${l.editable ? 'dot-gray' : l.lastSyncedAt ? 'dot-green' : 'dot-gray'}`} aria-hidden />
                          {syncLine(l)} {l.lastSyncedAt && !l.editable && <Time iso={l.lastSyncedAt} />}
                          {l.customOrder && ' · Your order'}
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
      <NewListSheet open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function ListDetail() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const toast = useToast();
  const invalidate = useInvalidateLists();
  const [params, setParams] = useSearchParams();
  const { user, services } = useUser();
  const q = useQuery({
    queryKey: ['lists', id],
    queryFn: () => get<{ list: ListView }>(`/lists/${id}`),
    refetchInterval: (s) => (s.state.data?.list.pending ? 4000 : s.state.data?.list.jellyfin && !s.state.data.list.jellyfin.synced ? 15000 : false),
  });
  const [syncing, setSyncing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const discovering = params.get('discover') === '1';
  const setDiscovering = (v: boolean) => setParams(v ? { discover: '1' } : {}, { replace: true });
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  if (q.isLoading) return <CenterLoading />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const l = q.data!.list;
  const upload = !l.canSync && !l.editable;

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
  const setMirror = async (mode: JellyfinMirrorMode | null) => {
    try {
      await put(`/lists/${id}/mirror`, { mode });
      invalidate();
      toast('success', mode ? `“${l.name}” will appear in Jellyfin as a ${mode === 'collection' ? 'collection' : 'private playlist'} within a few minutes.` : `The Jellyfin ${l.jellyfin?.mode === 'playlist' ? 'playlist' : 'collection'} will be removed within a few minutes.`);
    } catch (err) {
      toast('error', errorText(err));
    }
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
        <div className="inline" style={{ alignItems: 'flex-start', gap: 16, flexWrap: 'nowrap' }}>
          <ProviderMark provider={l.provider} size={48} />
          <div className="row-main">
            <h2 className="title-2" style={{ overflowWrap: 'anywhere' }}>{l.name}</h2>
            <div className="secondary subhead" style={{ marginTop: 4 }}>
              {l.editable ? 'Your list' : `${PROVIDER_NAME[l.provider]} ${LIST_KIND_LABEL[l.kind]?.toLowerCase()}`}
              {l.ownerName && ` by ${l.ownerName}`} · {plural(l.itemCount, 'entry', 'entries')}
              {!l.editable && ` · ${plural(l.matched, 'matched title')}`}
              {l.customOrder && ' · your order'}
            </div>
            {l.description && (
              <p className="subhead" style={{ marginTop: 8, maxWidth: '70ch', whiteSpace: 'pre-line' }}>
                {l.description}
              </p>
            )}
            {!l.editable && (
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
            )}
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
          {l.editable ? (
            <button className="btn btn-primary" onClick={() => setDiscovering(true)}>
              <Plus size={15} aria-hidden /> Add Titles
            </button>
          ) : l.canSync ? (
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
          <button className="btn btn-plain" onClick={() => setDuplicating(true)} title="Make an editable copy">
            <Copy size={14} aria-hidden /> Duplicate
          </button>
          <button
            className="btn btn-plain"
            onClick={() => {
              setName(l.name);
              setDescription(l.description ?? '');
              setRenaming(true);
            }}
          >
            <Pencil size={14} aria-hidden /> {l.editable ? 'Edit Details' : 'Rename'}
          </button>
          <button className="btn btn-plain" style={{ color: 'var(--red)' }} onClick={() => setConfirmDelete(true)}>
            <Trash2 size={14} aria-hidden /> {l.editable ? 'Delete' : 'Remove'}
          </button>
        </div>
        {services.jellyfinPlugin && <JellyfinSetting list={l} linked={Boolean(user.jellyfin)} onChange={(mode) => setMirror(mode)} />}
        {upload && (
          <p className="footnote secondary" style={{ marginTop: 10, marginBottom: 0 }}>
            This list was imported from a file, so it updates when you upload a newer export (or add the list by its link, where {PROVIDER_NAME[l.provider]} allows it). Duplicate it to add titles yourself.
          </p>
        )}
        {l.canSync && (
          <p className="footnote secondary" style={{ marginTop: 10, marginBottom: 0 }}>
            Entries come from {PROVIDER_NAME[l.provider]}. Your order is kept across syncs; duplicate the list to add or remove titles here.
          </p>
        )}
      </div>
      <ListContent list={l} onDisplay={(display) => update({ display })} onDiscover={() => setDiscovering(true)} />
      <ConfirmSheet
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={remove}
        destructive
        title={`${l.editable ? 'Delete' : 'Remove'} “${l.name}”?`}
        confirmLabel={l.editable ? 'Delete List' : 'Remove List'}
        message={
          l.editable
            ? 'The list and its entries are deleted. Watched marks and requests are kept.'
            : 'The list and its entries are removed from JellyWatcher. Nothing changes on the source service, and requests you made stay in Seerr.'
        }
      />
      <Sheet
        open={renaming}
        onClose={() => setRenaming(false)}
        title={l.editable ? 'Edit List' : 'Rename List'}
        footer={
          <>
            <button className="btn btn-gray" onClick={() => setRenaming(false)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={!name.trim()}
              onClick={async () => {
                await update(l.editable ? { name: name.trim(), description: description.trim() || null } : { name: name.trim() });
                setRenaming(false);
              }}
            >
              Save
            </button>
          </>
        }
      >
        <div className="stack">
          <label className="field">
            <span className="field-label">Name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus />
            {l.canSync && <span className="field-hint">The next sync may restore the name used on {PROVIDER_NAME[l.provider]}.</span>}
          </label>
          {l.editable && (
            <label className="field">
              <span className="field-label">Description</span>
              <textarea className="textarea" rows={4} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
            </label>
          )}
        </div>
      </Sheet>
      {upload && l.provider !== 'trakt' && l.provider !== 'local' && (
        <Sheet open={replacing} onClose={() => setReplacing(false)} title="Upload New Export">
          <p className="secondary subhead">Upload the latest export for this list. Titles no longer in the file are removed; your match decisions are kept.</p>
          <UploadBox provider={l.provider as UploadSource} replaceListId={l.id} onDone={() => setReplacing(false)} />
        </Sheet>
      )}
      {duplicating && <DuplicateSheet list={l} open onClose={() => setDuplicating(false)} />}
      {l.editable && <DiscoverSheet list={l} open={discovering} onClose={() => setDiscovering(false)} />}
    </>
  );
}

/** A list's titles: the timeline (standard; list order with seasons and episodes) or a poster grid. */
function JellyfinSetting({ list, linked, onChange }: { list: ListView; linked: boolean; onChange: (mode: JellyfinMirrorMode | null) => void }) {
  const value = list.jellyfin?.mode ?? 'off';
  const status = list.jellyfin ? mirrorStatus(list.jellyfin) : null;
  return (
    <div style={{ marginTop: 16 }}>
      <div className="inline" style={{ gap: 12 }}>
        <span className="subhead" style={{ fontWeight: 600 }}>
          <ListVideo size={15} aria-hidden style={{ verticalAlign: '-2px', marginRight: 6 }} />
          Show in Jellyfin
        </span>
        {linked || list.jellyfin ? (
          <Segmented label="Show in Jellyfin" value={value} onChange={(v) => v !== value && onChange(v === 'off' ? null : v)} options={MIRROR_OPTIONS} />
        ) : (
          <span className="footnote secondary">Link your account to a Jellyfin account first (an administrator can do this in Settings › People).</span>
        )}
      </div>
      <p className="footnote secondary" style={{ marginTop: 6, marginBottom: 0 }}>
        {value === 'off' ? MIRROR_INTRO : MIRROR_HINT[value]}
      </p>
      {status && (
        <p className="footnote" style={{ marginTop: 4, marginBottom: 0, color: status.kind === 'error' ? 'var(--red)' : undefined }}>
          {status.kind === 'busy' && <Spinner />} {status.text}
        </p>
      )}
    </div>
  );
}

function ListContent({ list, onDisplay, onDiscover }: { list: ListView; onDisplay: (d: 'grid' | 'timeline') => void; onDiscover: () => void }) {
  const view = list.timeline ? 'timeline' : 'grid';
  const qc = useQueryClient();
  const toast = useToast();
  const invalidate = useInvalidateLists();
  const [editing, setEditing] = useState(false);
  const [sorting, setSorting] = useState(false);
  const [removing, setRemoving] = useState<TimelineEntry | null>(null);
  const timeline = useQuery({
    queryKey: ['lists', list.id, 'timeline'],
    queryFn: () => get<Timeline>(`/lists/${list.id}/timeline`),
    enabled: view === 'timeline',
    refetchInterval: list.pending && !editing ? 4000 : false,
  });

  const saveOrder = async (itemIds: number[]) => {
    try {
      await put(`/lists/${list.id}/order`, { itemIds });
      void qc.invalidateQueries({ queryKey: ['lists'] });
      void qc.invalidateQueries({ queryKey: ['home'] });
    } catch (err) {
      toast('error', `The new order was not saved: ${errorText(err)}`);
      void timeline.refetch();
    }
  };
  const resetOrder = async () => {
    try {
      await del(`/lists/${list.id}/order`);
      invalidate();
      toast('success', list.editable ? 'Back to the order titles were added in.' : `Back to the order on ${PROVIDER_NAME[list.provider]}.`);
    } catch (err) {
      toast('error', errorText(err));
    }
  };
  const removeEntry = async (e: TimelineEntry) => {
    try {
      await del(`/lists/${list.id}/items/${e.itemId}`);
      invalidate();
      toast('success', `Removed ${entryHeading(e).title}.`);
    } catch (err) {
      toast('error', errorText(err));
    } finally {
      setRemoving(null);
    }
  };

  const count = timeline.data?.entries.length ?? 0;
  return (
    <>
      <div className="toolbar" style={{ marginBottom: 16 }}>
        <Segmented
          label="View"
          value={view}
          onChange={(v) => {
            setEditing(false);
            onDisplay(v);
          }}
          options={[
            { value: 'timeline', label: 'Timeline' },
            { value: 'grid', label: 'Grid' },
          ]}
        />
        {view === 'timeline' && count > 0 && (
          <button className={`btn ${editing ? 'btn-primary' : 'btn-gray'}`} onClick={() => setEditing(!editing)} aria-pressed={editing}>
            {editing ? 'Done' : (
              <>
                <ArrowDownUp size={15} aria-hidden /> {list.editable ? 'Edit' : 'Reorder'}
              </>
            )}
          </button>
        )}
        {view === 'timeline' && count > 1 && !editing && (
          <button className="btn btn-gray" onClick={() => setSorting(true)} aria-haspopup="dialog">
            <CalendarClock size={15} aria-hidden /> Auto Sort
          </button>
        )}
        {view === 'timeline' && list.customOrder && (
          <button className="btn btn-plain" onClick={resetOrder}>
            <RotateCcw size={14} aria-hidden /> {list.editable ? 'Reset Order' : `Use ${PROVIDER_NAME[list.provider]} Order`}
          </button>
        )}
        <span className="footnote secondary tl-hint">
          {editing ? 'Drag the handles, or focus one and use the arrow keys.' : view === 'timeline' ? 'Every entry in your order, including single seasons and episodes.' : 'One poster per title.'}
        </span>
      </div>
      {list.summary && list.summary.entries > 0 && !editing && (
        <div style={{ marginBottom: 20 }}>
          <TimelineSummaryPanel summary={list.summary} />
        </div>
      )}
      {view === 'grid' ? (
        <Catalog listId={list.id} />
      ) : timeline.isLoading ? (
        <CenterLoading />
      ) : timeline.isError ? (
        <ErrorState error={timeline.error} onRetry={() => timeline.refetch()} />
      ) : timeline.data!.entries.length === 0 ? (
        list.editable ? (
          <EmptyState icon={<ListPlus size={26} />} title="Nothing Here Yet" actions={<button className="btn btn-primary" onClick={onDiscover}><Plus size={15} aria-hidden /> Add Titles</button>}>
            Search for movies and shows or browse what’s trending, then put them in the order you want to watch them.
          </EmptyState>
        ) : (
          <EmptyState icon={<ListVideo size={26} />} title="This List Is Empty">
            Entries appear here after the list syncs.
          </EmptyState>
        )
      ) : (
        <div className="panel tl-panel">
          <TimelineView timeline={timeline.data!} listId={list.id} editing={editing} removable={list.editable} onOrder={saveOrder} onRemove={setRemoving} />
        </div>
      )}
      {sorting && <AutoSortSheet list={list} onClose={() => setSorting(false)} />}
      <ConfirmSheet
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && removeEntry(removing)}
        destructive
        title={`Remove ${removing ? [entryHeading(removing).title, entryHeading(removing).part].filter(Boolean).join(' · ') : ''}?`}
        confirmLabel="Remove"
        message="It is removed from this list only. Watched marks stay."
      />
    </>
  );
}

const SORTS = [
  { value: 'release', label: 'Release Date', detail: 'A timeline in the order things came out: movies by release, seasons and episodes by air date.' },
  { value: 'release_desc', label: 'Newest First', detail: 'The most recent releases first.' },
  { value: 'title', label: 'Title', detail: 'A to Z, with the seasons of a show in order.' },
  { value: 'runtime', label: 'Shortest First', detail: 'Quick watches first, by total runtime.' },
] as const;

/** Sorts a list automatically (saved as your order), e.g. into release order for lists without one. */
function AutoSortSheet({ list, onClose }: { list: ListView; onClose: () => void }) {
  const [by, setBy] = useState<(typeof SORTS)[number]['value']>('release');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const invalidate = useInvalidateLists();
  const run = async () => {
    setBusy(true);
    try {
      const r = await post<{ ordered: number; withoutDate: number }>(`/lists/${list.id}/order/auto`, { by });
      invalidate();
      toast('success', `Sorted ${plural(r.ordered, 'entry', 'entries')}${r.withoutDate ? `; ${r.withoutDate} without a known date are at the end` : ''}.`);
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
      title="Auto Sort"
      footer={
        <>
          <button className="btn btn-gray" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={run} disabled={busy}>
            {busy && <Spinner />}
            Sort List
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="group" role="radiogroup" aria-label="Sort by" style={{ background: 'var(--surface-2)' }}>
          {SORTS.map((o) => (
            <label key={o.value} className="row" style={{ cursor: 'pointer' }}>
              <input type="radio" name="auto-sort" value={o.value} checked={by === o.value} onChange={() => setBy(o.value)} style={{ width: 18, height: 18, accentColor: 'var(--accent-fill)' }} />
              <div className="row-main">
                <div className="row-title">{o.label}</div>
                <div className="row-sub">{o.detail}</div>
              </div>
            </label>
          ))}
        </div>
        <p className="footnote secondary" style={{ margin: 0 }}>
          The result is saved as your order, so you can still drag entries around afterwards.{' '}
          {list.editable ? 'Reset Order brings back the order you added them in.' : `“Use ${PROVIDER_NAME[list.provider]} Order” brings back the original order.`}
        </p>
      </div>
    </Sheet>
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
