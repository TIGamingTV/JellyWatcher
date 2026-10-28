import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Library } from 'lucide-react';
import { get, qs } from '../lib/api';
import { useUser } from '../lib/session';
import type { TitleCard } from '../lib/types';
import { plural } from '../lib/format';
import { Banner, EmptyState, ErrorState, PageHeader, PosterSkeletons, SearchField, Segmented, Spinner, Time } from '../components/ui';
import { PosterGrid } from '../components/Poster';

export function LibraryPage() {
  const { user, isAdmin } = useUser();
  const [type, setType] = useState<'all' | 'movie' | 'tv'>('all');
  const [filter, setFilter] = useState<'all' | 'in_progress' | 'unwatched' | 'watched' | 'favorites'>('all');
  const [sort, setSort] = useState('added');
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(120);
  useEffect(() => {
    const t = setTimeout(() => setSearch(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);

  const q = useQuery({
    queryKey: ['library', type, filter, sort, search, limit],
    queryFn: ({ signal }) =>
      get<{ configured: boolean; linked?: boolean; total: number; items: TitleCard[]; jellyfin: { lastOkAt: string | null; status: string; lastError: string | null } }>(
        `/library${qs({ type: type === 'all' ? undefined : type, filter, sort, q: search, limit })}`,
        signal,
      ),
    placeholderData: keepPreviousData,
  });
  const d = q.data;

  return (
    <>
      <PageHeader
        title="Library"
        subtitle={
          d?.configured ? (
            <>
              What’s on your Jellyfin server, synced <Time iso={d.jellyfin.lastOkAt} />
            </>
          ) : undefined
        }
      />
      {d && !d.configured ? (
        <EmptyState icon={<Library size={26} />} title="Jellyfin Isn’t Connected" actions={isAdmin && <Link className="btn btn-primary" to="/integrations/jellyfin">Connect Jellyfin</Link>}>
          {isAdmin ? 'Connect your Jellyfin server to see your library and viewing progress.' : 'Ask an administrator to connect Jellyfin.'}
        </EmptyState>
      ) : (
        <>
          {d?.jellyfin.status === 'error' && (
            <div style={{ marginBottom: 16 }}>
              <Banner kind="warn" title="The last Jellyfin sync failed">
                {d.jellyfin.lastError} Showing the library from the last successful sync.
              </Banner>
            </div>
          )}
          {d && !user.jellyfin && (
            <div style={{ marginBottom: 16 }}>
              <Banner kind="info" action={<Link className="btn btn-small" to="/integrations/jellyfin">Link</Link>}>
                Link your Jellyfin account to see what you’ve watched and filter by progress.
              </Banner>
            </div>
          )}
          <div className="toolbar-sticky">
            <div className="toolbar">
              <SearchField value={text} onChange={setText} placeholder="Search library" label="Search the library" />
              <Segmented
                label="Type"
                value={type}
                onChange={(v) => {
                  setType(v);
                  setLimit(120);
                }}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'movie', label: 'Movies' },
                  { value: 'tv', label: 'Shows' },
                ]}
              />
              {user.jellyfin && (
                <select className="select select-compact" aria-label="Viewing filter" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
                  <option value="all">Everything</option>
                  <option value="in_progress">In Progress</option>
                  <option value="unwatched">Unwatched</option>
                  <option value="watched">Watched</option>
                  <option value="favorites">Favorites</option>
                </select>
              )}
              <span className="spacer" />
              <select className="select select-compact" aria-label="Sort by" value={sort} onChange={(e) => setSort(e.target.value)}>
                <option value="added">Recently Added</option>
                <option value="title">Title</option>
                <option value="year">Release Year</option>
                {user.jellyfin && <option value="played">Recently Played</option>}
              </select>
            </div>
          </div>
          {q.isLoading ? (
            <PosterSkeletons />
          ) : q.isError ? (
            <ErrorState error={q.error} onRetry={() => q.refetch()} />
          ) : d!.total === 0 ? (
            <EmptyState icon={<Library size={26} />} title={d!.jellyfin.lastOkAt ? 'Nothing Here' : 'Library Not Synced Yet'}>
              {d!.jellyfin.lastOkAt ? 'No movies or shows match these filters.' : 'The first Jellyfin sync runs shortly after connecting. Large libraries take a minute.'}
            </EmptyState>
          ) : (
            <>
              <p className="footnote secondary" style={{ marginBottom: 14 }}>
                {plural(d!.total, 'title')} {q.isFetching && <Spinner />}
              </p>
              <PosterGrid items={d!.items} size={user.preferences.posterSize} />
              {d!.items.length < d!.total && (
                <div style={{ textAlign: 'center', marginTop: 28 }}>
                  <button className="btn btn-gray" onClick={() => setLimit(limit + 120)}>
                    Show More
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}
