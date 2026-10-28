import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Compass, Search } from 'lucide-react';
import { get, qs } from '../lib/api';
import { useUser } from '../lib/session';
import type { TitleCard } from '../lib/types';
import { Banner, EmptyState, ErrorState, PageHeader, PosterSkeletons, SearchField, Spinner } from '../components/ui';
import { PosterGrid } from '../components/Poster';

export function DiscoverPage() {
  const { services, user } = useUser();
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');
  const [page, setPage] = useState(1);
  const q = params.get('q') ?? '';

  useEffect(() => {
    const t = setTimeout(() => {
      if (text.trim() !== q) {
        setParams(text.trim() ? { q: text.trim() } : {}, { replace: true });
        setPage(1);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [text, q, setParams]);

  const trending = useQuery({ queryKey: ['trending'], queryFn: () => get<{ source: string | null; items: TitleCard[] }>('/discover/trending'), enabled: !q && Boolean(services.metadata), staleTime: 10 * 60_000 });
  const search = useQuery({
    queryKey: ['discover', q, page],
    queryFn: ({ signal }) => get<{ items: TitleCard[]; totalPages: number }>(`/discover/search${qs({ q, page })}`, signal),
    enabled: Boolean(q) && Boolean(services.metadata),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader title="Discover" subtitle="Search every movie and show, see where it stands, and request it." />
      {!services.metadata ? (
        <Banner kind="warn" title="Search isn’t available yet">
          Discover uses TMDb, or Seerr’s TMDb access. {user.role === 'admin' ? 'Connect one of them in Integrations.' : 'Ask an administrator to connect one.'}
        </Banner>
      ) : (
        <>
          <div className="toolbar" style={{ marginBottom: 22 }}>
            <SearchField value={text} onChange={setText} placeholder="Movies and shows" label="Search movies and shows" />
            {search.isFetching && <Spinner label="Searching" />}
          </div>
          {q ? (
            search.isLoading ? (
              <PosterSkeletons />
            ) : search.isError ? (
              <ErrorState error={search.error} onRetry={() => search.refetch()} />
            ) : search.data!.items.length === 0 ? (
              <EmptyState icon={<Search size={26} />} title="No Results">
                Nothing matches “{q}”. Check the spelling or try the original title.
              </EmptyState>
            ) : (
              <>
                <PosterGrid items={search.data!.items} />
                {search.data!.totalPages > 1 && (
                  <div className="toolbar" style={{ justifyContent: 'center', marginTop: 28 }}>
                    <button className="btn btn-gray" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                      Previous
                    </button>
                    <span className="footnote secondary tabular">
                      Page {page} of {search.data!.totalPages}
                    </span>
                    <button className="btn btn-gray" disabled={page >= search.data!.totalPages} onClick={() => setPage(page + 1)}>
                      Next
                    </button>
                  </div>
                )}
              </>
            )
          ) : (
            <section aria-labelledby="trend">
              <div className="section-head">
                <h2 className="title-2" id="trend">
                  Trending This Week
                </h2>
              </div>
              {trending.isLoading ? (
                <PosterSkeletons />
              ) : trending.isError ? (
                <Banner kind="info">Trending titles aren’t available from the configured metadata source. Search still works.</Banner>
              ) : trending.data!.items.length === 0 ? (
                <EmptyState icon={<Compass size={26} />} title="Nothing Trending">
                  Try searching instead.
                </EmptyState>
              ) : (
                <PosterGrid items={trending.data!.items} />
              )}
            </section>
          )}
          <p className="caption secondary" style={{ marginTop: 32 }}>
            This product uses the TMDB API but is not endorsed or certified by TMDB.
          </p>
        </>
      )}
    </>
  );
}
