import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Check, Circle, ListVideo, Play, Plus, SkipForward, Sparkles } from 'lucide-react';
import { get } from '../lib/api';
import { useUser } from '../lib/session';
import type { TitleCard, UpNextItem } from '../lib/types';
import { duration, greeting } from '../lib/format';
import { Banner, CenterLoading, ErrorState, PageHeader, Time } from '../components/ui';
import { PosterImage, Shelf } from '../components/Poster';
import { StagePill } from '../components/status';
import { entryFacts, entryHeading, scopeOf } from '../components/Timeline';
import { QuickWatchSheet, useSkipToggle } from '../components/Watched';

interface HomeData {
  counts: { watchlist: number; review: number; lists: number };
  recentlyAvailable: TitleCard[];
  activeRequests: TitleCard[];
  upNext: UpNextItem[];
  activity: { id: number; kind: string; message: string; createdAt: string; titleId: number | null }[];
  attention: { kind: string; message: string; href: string }[];
}

export function HomePage() {
  const { user, services, isAdmin } = useUser();
  const q = useQuery({ queryKey: ['home'], queryFn: () => get<HomeData>('/home'), refetchInterval: 60_000 });
  const firstName = user.displayName.split(' ')[0];

  const steps = [
    { done: services.jellyfin, label: 'Connect Jellyfin', detail: 'See what is already in your library.', href: '/integrations/jellyfin', admin: true },
    { done: services.seerr, label: 'Connect Seerr', detail: 'Request missing movies and shows.', href: '/integrations/seerr', admin: true },
    { done: Boolean(services.metadata), label: 'Add a metadata source', detail: 'TMDb, or Seerr’s built-in TMDb access.', href: '/integrations/tmdb', admin: true },
    { done: (q.data?.counts.lists ?? 0) > 0, label: 'Add your first watchlist', detail: 'Paste a list link, or import from Trakt, Letterboxd, IMDb, anime lists and more.', href: '/watchlists/lists?add=1', admin: false },
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

          {q.data.upNext.length > 0 && (
            <section className="section" aria-labelledby="up-next">
              <div className="section-head">
                <h2 className="title-2" id="up-next">
                  Up Next
                </h2>
                <Link to="/watchlists/lists">All Lists</Link>
              </div>
              <p className="footnote secondary" style={{ marginTop: -8 }}>
                The next unwatched entry on each of your lists, in list order. Skip what you don’t want to watch.
              </p>
              <div className="shelf up-next">
                {q.data.upNext.map((u) => (
                  <UpNextCard key={`${u.list.id}-${u.entry.itemId}`} item={u} />
                ))}
              </div>
            </section>
          )}

          {q.data.recentlyAvailable.length > 0 && (
            <section className="section" aria-labelledby="ra">
              <div className="section-head">
                <h2 className="title-2" id="ra">
                  Ready to Watch
                </h2>
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
                  Paste a list link from Trakt, Letterboxd, IMDb, TMDb, MyAnimeList, AniList or MDBList, or import an export. JellyWatcher shows what’s already in Jellyfin and lets you request the rest.
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

function UpNextCard({ item }: { item: UpNextItem }) {
  const e = item.entry;
  const t = e.title!;
  const { title, part } = entryHeading(e);
  const facts = entryFacts(e);
  const seasonParam = e.season !== null && e.season > 0 ? `&season=${e.season}` : '';
  const others = item.lists.length - 1;
  const [marking, setMarking] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const skip = useSkipToggle();
  const heading = [title, part].filter(Boolean).join(' · ');
  return (
    <article className="up-card" aria-label={`${title}${part ? `, ${part}` : ''}, next on ${item.list.name}`}>
      <Link to={`/titles/${t.id}`} className="poster-frame" tabIndex={-1} aria-hidden>
        <PosterImage src={t.posterUrl} alt="" fallback={title} />
        {e.state === 'in_progress' && (
          <span className="poster-progress">
            <i style={{ width: `${e.percent}%` }} />
          </span>
        )}
      </Link>
      <div className="up-meta">
        <div className="up-list">
          <Link to={`/watchlists/lists/${item.list.id}`} style={{ color: 'inherit' }}>
            {item.list.name}
          </Link>
          {others > 0 && ` +${others}`} · {item.position} of {item.of}
        </div>
        <Link to={`/titles/${t.id}`} className="tl-title" style={{ color: 'inherit' }}>
          {title}
        </Link>
        {part && <div className="footnote">{part}</div>}
        <div className="caption secondary">{facts.join(' · ')}</div>
        {item.timeline && item.remainingMinutes > 0 && <div className="caption secondary">{duration(item.remainingMinutes)} left on this list</div>}
        <div className="up-actions">
          {item.action === 'request' ? (
            <Link className="btn btn-small btn-primary" to={`/titles/${t.id}?request=1${seasonParam}`}>
              <Plus size={13} aria-hidden /> Request
            </Link>
          ) : item.action === 'watch' ? (
            <Link className="btn btn-small" to={`/titles/${t.id}`}>
              <Play size={12} fill="currentColor" aria-hidden /> Watch
            </Link>
          ) : (
            <StagePill stage={e.stage} />
          )}
          <button className="btn btn-small btn-gray" onClick={() => setMarking(true)} aria-label={`Mark ${title}${part ? ` ${part}` : ''} as watched`} aria-haspopup="dialog">
            <Check size={13} aria-hidden /> Watched
          </button>
          <button
            className="btn btn-small btn-gray"
            disabled={skipping}
            onClick={async () => {
              setSkipping(true);
              await skip(t.id, true, scopeOf(e), heading);
              setSkipping(false);
            }}
            aria-label={`Not watching ${heading}: skip it`}
            title="Not watching: skip to the next entry"
          >
            <SkipForward size={13} aria-hidden /> Skip
          </button>
        </div>
      </div>
      {marking && (
        <QuickWatchSheet
          titleId={t.id}
          heading={heading}
          scope={scopeOf(e)}
          manualAt={e.manualAt}
          watched={e.state === 'watched'}
          onClose={() => setMarking(false)}
        />
      )}
    </article>
  );
}
