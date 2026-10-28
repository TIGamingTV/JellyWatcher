import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Check, Circle, ListVideo, Sparkles } from 'lucide-react';
import { get } from '../lib/api';
import { useUser } from '../lib/session';
import type { TitleCard } from '../lib/types';
import { Banner, CenterLoading, ErrorState, PageHeader, Time } from '../components/ui';
import { PosterImage, Shelf } from '../components/Poster';

interface HomeData {
  counts: { watchlist: number; review: number; lists: number };
  recentlyAvailable: TitleCard[];
  activeRequests: TitleCard[];
  continueWatching: { titleId: number | null; jellyfinItemId?: string; name: string; episode: string | null; percent: number | null; imageUrl: string | null }[];
  continueSource: 'live' | 'synced' | 'unavailable';
  activity: { id: number; kind: string; message: string; createdAt: string; titleId: number | null }[];
  attention: { kind: string; message: string; href: string }[];
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Good Evening' : h < 12 ? 'Good Morning' : h < 18 ? 'Good Afternoon' : 'Good Evening';
}

export function HomePage() {
  const { user, services, isAdmin } = useUser();
  const q = useQuery({ queryKey: ['home'], queryFn: () => get<HomeData>('/home'), refetchInterval: 60_000 });
  const firstName = user.displayName.split(' ')[0];

  const steps = [
    { done: services.jellyfin, label: 'Connect Jellyfin', detail: 'See what is already in your library.', href: '/integrations/jellyfin', admin: true },
    { done: services.seerr, label: 'Connect Seerr', detail: 'Request missing movies and shows.', href: '/integrations/seerr', admin: true },
    { done: Boolean(services.metadata), label: 'Add a metadata source', detail: 'TMDb, or Seerr’s built-in TMDb access.', href: '/integrations/tmdb', admin: true },
    { done: (q.data?.counts.lists ?? 0) > 0, label: 'Add your first watchlist', detail: 'From Trakt, Letterboxd or IMDb.', href: '/watchlists/lists?add=1', admin: false },
  ].filter((s) => isAdmin || !s.admin);
  const setupDone = steps.every((s) => s.done);

  return (
    <>
      <PageHeader title={`${greeting()}, ${firstName}`} subtitle={q.data ? `${q.data.counts.watchlist.toLocaleString()} titles across ${q.data.counts.lists} ${q.data.counts.lists === 1 ? 'list' : 'lists'}` : undefined} />

      {!setupDone && q.data && (
        <section className="panel" aria-labelledby="setup-title" style={{ marginBottom: 28 }}>
          <div className="inline" style={{ marginBottom: 14 }}>
            <Sparkles size={18} color="var(--accent)" aria-hidden />
            <h2 className="headline" id="setup-title">
              Finish Setting Up
            </h2>
          </div>
          <div className="group" style={{ background: 'var(--surface-2)' }}>
            {steps.map((s) => (
              <Link key={s.label} to={s.href} className="row row-link">
                {s.done ? <Check size={20} color="var(--green)" aria-label="Done" /> : <Circle size={20} color="var(--label-3)" aria-label="Not done" />}
                <div className="row-main">
                  <div className="row-title" style={s.done ? { color: 'var(--label-2)' } : undefined}>
                    {s.label}
                  </div>
                  <div className="row-sub">{s.detail}</div>
                </div>
                {!s.done && <ArrowRight size={16} className="row-chevron" aria-hidden />}
              </Link>
            ))}
          </div>
        </section>
      )}

      {q.isLoading && <CenterLoading />}
      {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.data && (
        <>
          {q.data.attention.length > 0 && (
            <div className="stack" style={{ marginBottom: 8 }}>
              {q.data.attention.slice(0, 5).map((a, i) => (
                <Banner
                  key={i}
                  kind={a.kind === 'list_error' || a.kind === 'integration' || a.kind === 'reauth' ? 'warn' : 'info'}
                  action={
                    <Link className="btn btn-small" to={a.href}>
                      {a.kind === 'review' ? 'Review' : a.kind === 'link' ? 'Link' : 'Open'}
                    </Link>
                  }
                >
                  {a.message}
                </Banner>
              ))}
            </div>
          )}

          {q.data.continueWatching.length > 0 && (
            <section className="section" aria-labelledby="cw">
              <div className="section-head">
                <h2 className="title-2" id="cw">
                  Continue Watching
                </h2>
                <span className="footnote secondary">{q.data.continueSource === 'live' ? 'From Jellyfin, live' : 'From the last Jellyfin sync'}</span>
              </div>
              <div className="shelf" style={{ gridAutoColumns: 'minmax(220px, 260px)' }}>
                {q.data.continueWatching.map((c, i) => {
                  const body = (
                    <>
                      <div className="poster-frame" style={{ aspectRatio: '16 / 10' }}>
                        <PosterImage src={c.imageUrl ? `${c.imageUrl}?w=500` : null} alt="" fallback={c.name} />
                        {c.percent !== null && (
                          <span className="poster-progress" aria-hidden>
                            <i style={{ width: `${c.percent}%` }} />
                          </span>
                        )}
                      </div>
                      <div className="poster-meta">
                        <div className="poster-title">{c.name}</div>
                        <div className="poster-sub">{c.episode ?? (c.percent !== null ? `${c.percent}% watched` : 'In progress')}</div>
                      </div>
                    </>
                  );
                  return c.titleId ? (
                    <Link key={i} to={`/titles/${c.titleId}`} className="poster-card" aria-label={`${c.name}${c.episode ? `, ${c.episode}` : ''}${c.percent !== null ? `, ${c.percent}% watched` : ''}`}>
                      {body}
                    </Link>
                  ) : (
                    <div key={i} className="poster-card">
                      {body}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {q.data.recentlyAvailable.length > 0 && (
            <section className="section" aria-labelledby="ra">
              <div className="section-head">
                <h2 className="title-2" id="ra">
                  Ready to Watch
                </h2>
                <Link to="/watchlists?availability=in_library">See All</Link>
              </div>
              <p className="footnote secondary" style={{ marginTop: -8 }}>
                From your watchlists, newest in Jellyfin first.
              </p>
              <Shelf items={q.data.recentlyAvailable} />
            </section>
          )}

          {q.data.activeRequests.length > 0 && (
            <section className="section" aria-labelledby="ar">
              <div className="section-head">
                <h2 className="title-2" id="ar">
                  Your Open Requests
                </h2>
                <Link to="/requests">See All</Link>
              </div>
              <Shelf items={q.data.activeRequests} />
            </section>
          )}

          {q.data.counts.lists === 0 && (
            <section className="section">
              <div className="panel" style={{ textAlign: 'center', padding: '40px 20px' }}>
                <ListVideo size={32} color="var(--accent)" aria-hidden style={{ margin: '0 auto 10px' }} />
                <h2 className="title-3">Bring Your Watchlists Together</h2>
                <p className="secondary" style={{ maxWidth: 460, margin: '8px auto 18px' }}>
                  Connect Trakt, or import exports from Letterboxd and IMDb. JellyWatcher shows what’s already in Jellyfin and lets you request the rest.
                </p>
                <Link className="btn btn-primary btn-large" to="/watchlists/lists?add=1">
                  Add a Watchlist
                </Link>
              </div>
            </section>
          )}

          {q.data.activity.length > 0 && (
            <section className="section" aria-labelledby="act">
              <div className="section-head">
                <h2 className="title-2" id="act">
                  Recent Activity
                </h2>
              </div>
              <div className="group">
                {q.data.activity.slice(0, 10).map((a) => {
                  const inner = (
                    <>
                      <div className="row-main">
                        <div>{a.message}</div>
                      </div>
                      <span className="footnote secondary">
                        <Time iso={a.createdAt} />
                      </span>
                    </>
                  );
                  return a.titleId ? (
                    <Link key={a.id} to={`/titles/${a.titleId}`} className="row row-link">
                      {inner}
                    </Link>
                  ) : (
                    <div key={a.id} className="row">
                      {inner}
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </>
      )}
    </>
  );
}
