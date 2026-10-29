import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Check, ChevronLeft, Copy, Library, Plus, Search } from 'lucide-react';
import { errorText, get, post, qs } from '../lib/api';
import { useToast } from '../lib/session';
import type { DiscoverResult, ListView, MediaType } from '../lib/types';
import { plural } from '../lib/format';
import { Banner, Field, Segmented, Sheet, Spinner } from './ui';
import { PosterImage } from './Poster';
import { useInvalidateLists } from './AddList';

function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Creates an empty local list and opens it. */
export function NewListSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const invalidate = useInvalidateLists();
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ list: ListView }>('/lists/local', { name: name.trim(), description: description.trim() || undefined });
      invalidate();
      onClose();
      setName('');
      setDescription('');
      navigate(`/watchlists/lists/${r.list.id}?discover=1`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="New List"
      footer={
        <>
          <button className="btn btn-gray" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={create} disabled={busy || !name.trim()}>
            {busy && <Spinner />}
            Create
          </button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void create();
        }}
      >
        <p className="secondary subhead" style={{ margin: 0 }}>
          Your own list, kept in JellyWatcher. Add movies, shows, single seasons or episodes, and put them in any order — great for watch-order timelines.
        </p>
        {error && <Banner kind="error">{error}</Banner>}
        <Field label="Name">{(id) => <input id={id} className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus />}</Field>
        <Field label="Description" hint="Optional.">
          {(id, d) => <textarea id={id} aria-describedby={d} className="textarea" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />}
        </Field>
      </form>
    </Sheet>
  );
}

/** Copies any list into a local list that can be edited freely. */
export function DuplicateSheet({ list, open, onClose }: { list: ListView; open: boolean; onClose: () => void }) {
  const [name, setName] = useState(`${list.name} (Copy)`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const toast = useToast();
  const invalidate = useInvalidateLists();
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ list: ListView }>(`/lists/${list.id}/duplicate`, { name: name.trim() });
      invalidate();
      toast('success', `Created “${r.list.name}” with ${plural(r.list.itemCount, 'entry', 'entries')}.`);
      onClose();
      navigate(`/watchlists/lists/${r.list.id}`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Duplicate List"
      footer={
        <>
          <button className="btn btn-gray" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={run} disabled={busy || !name.trim()}>
            {busy ? <Spinner /> : <Copy size={15} aria-hidden />}
            Duplicate
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="secondary subhead" style={{ margin: 0 }}>
          The copy lives only in JellyWatcher: add and remove titles, reorder it, and it never changes when “{list.name}” syncs. Matches and your order are copied too.
        </p>
        {error && <Banner kind="error">{error}</Banner>}
        <Field label="Name">{(id) => <input id={id} className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus />}</Field>
      </div>
    </Sheet>
  );
}

interface TvSeasons {
  tmdbId: number;
  title: string;
  year: number | null;
  seasons: { season: number; name: string | null; episodes: number | null }[];
}

/** Season / episode picker for adding part of a show. */
function ShowPicker({ show, onAdd, onBack, busy }: { show: DiscoverResult; onAdd: (part: { season?: number; episode?: number }) => void; onBack: () => void; busy: boolean }) {
  const q = useQuery({ queryKey: ['discover-tv', show.tmdbId], queryFn: () => get<TvSeasons>(`/discover/tv/${show.tmdbId}`) });
  const [episode, setEpisode] = useState<Record<number, number>>({});
  return (
    <div className="stack">
      <button className="back-link btn-plain" style={{ border: 0, background: 'none', cursor: 'pointer', padding: 0 }} onClick={onBack}>
        <ChevronLeft size={16} aria-hidden /> Results
      </button>
      <div className="inline" style={{ flexWrap: 'nowrap', gap: 14 }}>
        <div className="thumb" style={{ width: 56, flex: 'none' }}>
          <PosterImage src={show.posterUrl} alt="" fallback={show.title} />
        </div>
        <div className="row-main">
          <div className="headline">{show.title}</div>
          <div className="secondary footnote">{show.year ?? '—'} · Show</div>
        </div>
        <button className="btn btn-primary btn-small" onClick={() => onAdd({})} disabled={busy || show.inList}>
          {show.inList ? <Check size={14} aria-hidden /> : <Plus size={14} aria-hidden />} {show.inList ? 'On List' : 'Whole Show'}
        </button>
      </div>
      {q.isLoading && <Spinner />}
      {q.isError && <Banner kind="error">{errorText(q.error)}</Banner>}
      {q.data && (
        <div className="group" style={{ background: 'var(--surface-2)' }}>
          {q.data.seasons.map((s) => (
            <div key={s.season} className="row" style={{ flexWrap: 'wrap' }}>
              <div className="row-main" style={{ minWidth: 140 }}>
                <div className="row-title">{s.name ?? (s.season === 0 ? 'Specials' : `Season ${s.season}`)}</div>
                {s.episodes !== null && <div className="row-sub">{plural(s.episodes, 'episode')}</div>}
              </div>
              <button className="btn btn-small" onClick={() => onAdd({ season: s.season })} disabled={busy}>
                <Plus size={14} aria-hidden /> Season
              </button>
              {s.episodes ? (
                <span className="inline" style={{ gap: 6, flexWrap: 'nowrap' }}>
                  <select className="select select-compact" aria-label={`Episode of ${s.name ?? `season ${s.season}`}`} value={episode[s.season] ?? 1} onChange={(e) => setEpisode({ ...episode, [s.season]: Number(e.target.value) })}>
                    {Array.from({ length: s.episodes }, (_, i) => (
                      <option key={i} value={i + 1}>
                        Episode {i + 1}
                      </option>
                    ))}
                  </select>
                  <button className="btn btn-small" onClick={() => onAdd({ season: s.season, episode: episode[s.season] ?? 1 })} disabled={busy}>
                    <Plus size={14} aria-hidden /> Episode
                  </button>
                </span>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Find movies and shows (search, trending, popular) and add them to a local list. */
export function DiscoverSheet({ list, open, onClose }: { list: ListView; open: boolean; onClose: () => void }) {
  const [text, setText] = useState('');
  const q = useDebounced(text.trim());
  const [kind, setKind] = useState<'trending' | 'movies' | 'tv'>('trending');
  const [type, setType] = useState<'all' | MediaType>('all');
  const [page, setPage] = useState(1);
  const [extra, setExtra] = useState<DiscoverResult[]>([]);
  const [picking, setPicking] = useState<DiscoverResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const toast = useToast();
  const invalidate = useInvalidateLists();
  useEffect(() => {
    setPage(1);
    setExtra([]);
  }, [q, kind, type]);

  const params = { q: q || undefined, kind, type: type === 'all' ? undefined : type, listId: list.id };
  const res = useQuery({
    queryKey: ['discover', params],
    queryFn: ({ signal }) => get<{ results: DiscoverResult[]; totalPages: number; page: number; source: string }>(`/discover${qs({ ...params, page: 1 })}`, signal),
    enabled: open,
    placeholderData: keepPreviousData,
  });
  const loadMore = async () => {
    const next = page + 1;
    setBusy('more');
    try {
      const r = await get<{ results: DiscoverResult[] }>(`/discover${qs({ ...params, page: next })}`);
      setExtra((x) => [...x, ...r.results]);
      setPage(next);
    } catch (err) {
      toast('error', errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const add = async (r: DiscoverResult, part: { season?: number; episode?: number } = {}) => {
    const key = `${r.mediaType}:${r.tmdbId}${part.season !== undefined ? `:s${part.season}${part.episode !== undefined ? `e${part.episode}` : ''}` : ''}`;
    setBusy(key);
    try {
      await post(`/lists/${list.id}/items`, { tmdbId: r.tmdbId, mediaType: r.mediaType, title: r.title, year: r.year, posterPath: r.posterPath, overview: r.overview, season: part.season ?? null, episode: part.episode ?? null });
      setAdded((s) => new Set(s).add(key));
      const what = part.season !== undefined ? `${r.title} ${part.episode !== undefined ? `S${part.season}E${part.episode}` : `season ${part.season}`}` : r.title;
      toast('success', `Added ${what}.`);
      invalidate();
    } catch (err) {
      toast('error', errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const results = [...(res.data?.results ?? []), ...extra];
  const isAdded = (r: DiscoverResult) => r.inList || added.has(`${r.mediaType}:${r.tmdbId}`);

  return (
    <Sheet open={open} onClose={onClose} wide title={`Add to “${list.name}”`} footer={<button className="btn btn-primary" onClick={onClose}>Done</button>}>
      {picking ? (
        <ShowPicker show={{ ...picking, inList: isAdded(picking) }} busy={busy !== null} onBack={() => setPicking(null)} onAdd={(part) => void add(picking, part)} />
      ) : (
        <div className="stack">
          <div className="search-field" style={{ maxWidth: 'none' }} role="search">
            <Search size={16} aria-hidden />
            <input className="input" type="search" placeholder="Search movies and shows" aria-label="Search movies and shows" value={text} onChange={(e) => setText(e.target.value)} data-autofocus />
          </div>
          <div className="toolbar">
            {q ? (
              <Segmented
                label="Type"
                value={type}
                onChange={setType}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'movie', label: 'Movies' },
                  { value: 'tv', label: 'Shows' },
                ]}
              />
            ) : (
              <Segmented
                label="Discover"
                value={kind}
                onChange={setKind}
                options={[
                  { value: 'trending', label: 'Trending' },
                  { value: 'movies', label: 'Popular Movies' },
                  { value: 'tv', label: 'Popular Shows' },
                ]}
              />
            )}
            {res.isFetching && <Spinner />}
          </div>
          {res.isError ? (
            <Banner kind="error">{errorText(res.error)}</Banner>
          ) : res.isLoading ? (
            <div className="center-load" style={{ padding: 40 }}>
              <Spinner large />
            </div>
          ) : results.length === 0 ? (
            <div className="secondary">Nothing found. Try another spelling or the original title.</div>
          ) : (
            <div className="discover-grid">
              {results.map((r) => {
                const on = isAdded(r);
                const key = `${r.mediaType}:${r.tmdbId}`;
                return (
                  <div key={key} className="discover-card">
                    <div className="poster-frame" style={{ boxShadow: 'none' }}>
                      <PosterImage src={r.posterUrl} alt="" fallback={r.title} />
                      {r.inLibrary && (
                        <span className="poster-badge" style={{ background: '#248a3d' }} title="In your library" aria-hidden>
                          <Library size={13} />
                        </span>
                      )}
                    </div>
                    <div className="poster-meta">
                      <div className="poster-title">{r.title}</div>
                      <div className="poster-sub">
                        {r.year ?? '—'} · {r.mediaType === 'tv' ? 'Show' : 'Movie'}
                        {r.inLibrary && <span className="visually-hidden">, in your library</span>}
                      </div>
                    </div>
                    <div className="discover-actions">
                      <button className={`btn btn-small ${on ? 'btn-gray' : 'btn-primary'}`} disabled={on || busy !== null} onClick={() => void add(r)} aria-label={on ? `${r.title} is on the list` : `Add ${r.title}`}>
                        {busy === key ? <Spinner /> : on ? <Check size={14} aria-hidden /> : <Plus size={14} aria-hidden />}
                        {on ? 'Added' : 'Add'}
                      </button>
                      {r.mediaType === 'tv' && (
                        <button className="btn btn-small btn-plain" onClick={() => setPicking(r)} aria-label={`Add a season or episode of ${r.title}`}>
                          Seasons…
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {res.data && page < res.data.totalPages && results.length > 0 && (
            <div style={{ textAlign: 'center' }}>
              <button className="btn btn-gray" onClick={loadMore} disabled={busy === 'more'}>
                {busy === 'more' && <Spinner />}
                Show More
              </button>
            </div>
          )}
          {res.data && <p className="caption secondary" style={{ margin: 0 }}>Results from {res.data.source === 'tmdb' ? 'TMDb' : 'Seerr (TMDb)'}.</p>}
        </div>
      )}
    </Sheet>
  );
}

/** Adds the title on the page to one of the person's local lists (or a new one). */
export function AddToListSheet({ title, onClose }: { title: { id: number; tmdbId: number | null; mediaType: MediaType; title: string; year: number | null }; onClose: () => void }) {
  const q = useQuery({ queryKey: ['local-lists', title.id], queryFn: () => get<{ lists: { id: number; name: string; contains: boolean }[] }>(`/titles/${title.id}/local-lists`) });
  const [busy, setBusy] = useState<number | 'new' | null>(null);
  const [name, setName] = useState('');
  const toast = useToast();
  const invalidate = useInvalidateLists();
  const addTo = async (listId: number, listName: string) => {
    await post(`/lists/${listId}/items`, { tmdbId: title.tmdbId, mediaType: title.mediaType, title: title.title, year: title.year });
    toast('success', `Added to “${listName}”.`);
    invalidate();
    void q.refetch();
  };
  const run = async (key: number | 'new', fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      toast('error', errorText(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Sheet open onClose={onClose} title="Add to List" footer={<button className="btn btn-primary" onClick={onClose}>Done</button>}>
      {!title.tmdbId ? (
        <Banner kind="warn">This title has no TMDb id yet, so it can’t be added to a list. Try again after its metadata loads.</Banner>
      ) : (
        <div className="stack">
          {q.isLoading && <Spinner />}
          {q.isError && <Banner kind="error">{errorText(q.error)}</Banner>}
          {q.data && q.data.lists.length > 0 && (
            <div className="group" style={{ background: 'var(--surface-2)' }}>
              {q.data.lists.map((l) => (
                <div key={l.id} className="row">
                  <div className="row-main row-title">{l.name}</div>
                  {l.contains ? (
                    <span className="pill pill-green">
                      <Check size={12} aria-hidden /> On List
                    </span>
                  ) : (
                    <button className="btn btn-small" disabled={busy !== null} onClick={() => run(l.id, () => addTo(l.id, l.name))}>
                      {busy === l.id ? <Spinner /> : <Plus size={14} aria-hidden />} Add
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {q.data && q.data.lists.length === 0 && <p className="secondary subhead" style={{ margin: 0 }}>You have no lists of your own yet. Create one, or duplicate a synced list to edit it.</p>}
          <form
            className="inline"
            style={{ flexWrap: 'nowrap' }}
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) return;
              void run('new', async () => {
                const r = await post<{ list: ListView }>('/lists/local', { name: name.trim() });
                await addTo(r.list.id, r.list.name);
                setName('');
              });
            }}
          >
            <input className="input" placeholder="New list name" aria-label="New list name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
            <button className="btn btn-primary" type="submit" disabled={!name.trim() || busy !== null}>
              {busy === 'new' ? <Spinner /> : <Plus size={15} aria-hidden />} Create
            </button>
          </form>
        </div>
      )}
    </Sheet>
  );
}
