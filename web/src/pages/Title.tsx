import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCheck, ChevronLeft, Eye, ExternalLink, ListPlus, Play, Plus, RefreshCw, Star } from 'lucide-react';
import { REQUEST_STATE_LABEL, type LifecycleStage } from '../../../shared/status';
import { errorText, get, post } from '../lib/api';
import { useToast, useUser } from '../lib/session';
import type { Eligibility, TitleDetail } from '../lib/types';
import { date, LIST_KIND_LABEL, PROVIDER_NAME, runtime } from '../lib/format';
import { Banner, CenterLoading, ErrorState, Sheet, Spinner, Time } from '../components/ui';
import { PosterImage } from '../components/Poster';
import { RequestPill, StagePill, availabilityLabel, viewingLabel } from '../components/status';
import { mapSeerrRequest } from '../../../shared/status';
import { WatchedSheet } from '../components/Watched';
import { AddToListSheet } from '../components/LocalLists';

const TRACK = ['On Watchlist', 'Requested', 'Processing', 'In Library', 'Watched'] as const;

function trackPosition(stage: LifecycleStage): { index: number; problem: boolean } {
  switch (stage) {
    case 'watched':
      return { index: 4, problem: false };
    case 'in_progress':
    case 'in_library':
      return { index: 3, problem: false };
    case 'reported_available':
    case 'partially_available':
    case 'processing':
      return { index: 2, problem: false };
    case 'pending_approval':
    case 'requested':
      return { index: 1, problem: false };
    case 'declined':
    case 'failed':
      return { index: 1, problem: true };
    default:
      return { index: 0, problem: false };
  }
}

function LifecycleTrack({ stage }: { stage: LifecycleStage }) {
  const { index, problem } = trackPosition(stage);
  return (
    <ol className="track" aria-label={`Progress: ${TRACK[index]}${problem ? ' (problem)' : ''}`}>
      {TRACK.map((label, i) => (
        <li key={label} className={i < index ? 'done' : i === index ? (problem ? 'problem' : 'current') : ''} aria-current={i === index ? 'step' : undefined}>
          <span className="node" aria-hidden />
          {i === 1 && problem ? (stage === 'declined' ? 'Declined' : 'Failed') : label}
        </li>
      ))}
    </ol>
  );
}

function Freshness({ syncedAt, stale, source }: { syncedAt: string | null; stale: boolean; source: string | null }) {
  if (!source) return null;
  if (!syncedAt) return <div className="meta">Not synced yet</div>;
  return (
    <div className="meta" style={stale ? { color: 'var(--orange)' } : undefined}>
      {stale ? 'Possibly outdated · ' : ''}
      {source} <Time iso={syncedAt} />
    </div>
  );
}

export function TitlePage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const { user } = useUser();
  const [params, setParams] = useSearchParams();
  // Deep link from Up Next: /titles/:id?request=1&season=2 opens the request sheet with that season.
  const [requesting, setRequesting] = useState(params.get('request') === '1');
  const presetSeason = params.get('season') ? Number(params.get('season')) : null;
  const closeRequest = () => {
    setRequesting(false);
    if (params.has('request')) setParams({}, { replace: true });
  };
  const [marking, setMarking] = useState(false);
  const [adding, setAdding] = useState(false);
  const q = useQuery({ queryKey: ['title', id], queryFn: () => get<TitleDetail>(`/titles/${id}`) });
  const d = q.data;
  useEffect(() => {
    if (d) document.title = `${d.title.title} · JellyWatcher`;
  }, [d]);

  if (q.isLoading) return <CenterLoading />;
  if (q.isError || !d) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (d.title.id !== id) {
    navigate(`/titles/${d.title.id}`, { replace: true });
    return null;
  }
  const t = d.title;
  const s = d.status;
  const facts = [t.year, t.mediaType === 'tv' ? 'TV Show' : 'Movie', runtime(t.runtime), t.genres.slice(0, 3).join(', ')].filter(Boolean);
  const req = s.request.state;
  const requestable = ['not_requested', 'declined', 'failed', 'unknown', 'partially_available'].includes(req) && s.availability.state !== 'in_library';
  const tvMore = t.mediaType === 'tv' && (s.availability.state === 'in_library' || s.availability.state === 'partially_in_library' || req === 'partially_available');

  return (
    <>
      <button className="back-link btn-plain" style={{ border: 0, background: 'none', cursor: 'pointer', padding: 0 }} onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/watchlists'))}>
        <ChevronLeft size={18} aria-hidden /> Back
      </button>

      <section className={`hero${t.backdropUrl ? ' has-backdrop' : ''}`} aria-labelledby="title-h">
        {t.backdropUrl && <div className="hero-backdrop" style={{ backgroundImage: `url(${t.backdropUrl})` }} aria-hidden />}
        <div className="hero-inner">
          <div className="poster-frame">
            <PosterImage src={t.posterUrl} alt={`${t.title} poster`} fallback={t.title} />
          </div>
          <div>
            <div style={{ marginBottom: 10 }}>
              <StagePill stage={s.stage} />
            </div>
            <h1 className="hero-title" id="title-h">
              {t.title}
            </h1>
            {t.originalTitle && t.originalTitle !== t.title && <div className="secondary subhead">{t.originalTitle}</div>}
            <div className="hero-facts secondary">{facts.map((f, i) => <span key={i}>{f}</span>)}</div>
            {t.overview ? <p className="hero-overview">{t.overview}</p> : <p className="hero-overview secondary">No synopsis available.</p>}
            <div className="hero-actions">
              {d.links.jellyfin && (
                <a className="btn btn-primary btn-large" href={d.links.jellyfin} target="_blank" rel="noreferrer noopener">
                  <Play size={16} fill="currentColor" aria-hidden /> Play in Jellyfin
                </a>
              )}
              {(requestable || tvMore) && (
                <button className={`btn btn-large${d.links.jellyfin ? '' : ' btn-primary'}`} onClick={() => setRequesting(true)}>
                  <Plus size={16} aria-hidden /> {tvMore ? 'Request More Seasons' : req === 'declined' || req === 'failed' ? 'Request Again' : 'Request'}
                </button>
              )}
              <button className="btn btn-large" onClick={() => setMarking(true)} aria-haspopup="dialog">
                {s.viewing.state === 'watched' ? <CheckCheck size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
                {s.viewing.state === 'watched' ? 'Watched' : t.mediaType === 'tv' ? 'Mark Watched…' : 'Mark as Watched'}
              </button>
              <button className="btn btn-large" onClick={() => setAdding(true)} aria-haspopup="dialog">
                <ListPlus size={16} aria-hidden /> Add to List
              </button>
              {d.links.seerr && (
                <a className="btn btn-large" href={d.links.seerr} target="_blank" rel="noreferrer noopener">
                  Seerr <ExternalLink size={14} aria-hidden />
                </a>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="panel" aria-label="Status" style={{ padding: '18px 8px 6px' }}>
        <LifecycleTrack stage={s.stage} />
        <div className="status-grid" style={{ marginTop: 10, borderTop: '1px solid var(--separator)' }}>
          <div className="status-cell">
            <div className="label">Library</div>
            <div className="value">{availabilityLabel(s.availability.state)}</div>
            {s.availability.detail && <div className="meta">{s.availability.detail}</div>}
            {d.jellyfin?.addedAt && <div className="meta">Added {date(d.jellyfin.addedAt)}</div>}
            <Freshness syncedAt={s.availability.syncedAt} stale={s.availability.stale} source={s.availability.source} />
          </div>
          <div className="status-cell">
            <div className="label">Request</div>
            <div className="value">
              <RequestPill state={req} />
            </div>
            {s.request.requestedBy && (
              <div className="meta">
                Requested by {s.request.mine ? 'you' : s.request.requestedBy}
              </div>
            )}
            {s.request.detail && <div className="meta">{s.request.detail}</div>}
            <Freshness syncedAt={s.request.syncedAt} stale={s.request.stale} source={s.request.source} />
          </div>
          <div className="status-cell">
            <div className="label">Viewing</div>
            <div className="value">{viewingLabel(s.viewing.state)}</div>
            {s.viewing.progress && s.viewing.state !== 'unavailable' && (
              <>
                {s.viewing.progress.totalEpisodes !== null && s.viewing.progress.playedEpisodes !== null && (
                  <div className="meta">
                    {s.viewing.progress.playedEpisodes} of {s.viewing.progress.totalEpisodes} episodes
                  </div>
                )}
                {s.viewing.progress.percent !== null && s.viewing.state === 'in_progress' && (
                  <div className="progress" role="progressbar" aria-valuenow={s.viewing.progress.percent} aria-valuemin={0} aria-valuemax={100} aria-label="Watched">
                    <i style={{ width: `${s.viewing.progress.percent}%` }} />
                  </div>
                )}
                {s.viewing.progress.lastPlayedAt && (
                  <div className="meta">
                    {s.viewing.state === 'watched' && d.watch.manualAt ? `Watched on ${date(d.watch.manualAt)}` : <>Last played <Time iso={s.viewing.progress.lastPlayedAt} /></>}
                  </div>
                )}
              </>
            )}
            {s.viewing.detail && (
              <div className="meta">
                {s.viewing.detail}{' '}
                {!user.jellyfin && s.viewing.state === 'unavailable' && <Link to="/integrations/jellyfin">Link account</Link>}{' '}
                {s.viewing.state !== 'watched' && (
                  <button className="btn-link" onClick={() => setMarking(true)}>
                    Mark as watched
                  </button>
                )}
              </div>
            )}
            <Freshness syncedAt={s.viewing.syncedAt} stale={s.viewing.stale} source={s.viewing.source} />
          </div>
        </div>
      </section>

      <div className="cols-2 section" style={{ marginTop: 28 }}>
        <section aria-labelledby="in-lists">
          <h2 className="group-title" id="in-lists">
            In Your Lists
          </h2>
          {d.lists.length === 0 ? (
            <div className="group">
              <div className="row secondary">Not on any of your lists.</div>
            </div>
          ) : (
            <div className="group">
              {d.lists.filter((l, i, all) => all.findIndex((x) => x.id === l.id) === i).map((l) => (
                <Link key={l.itemId} to={`/watchlists/lists/${l.id}`} className="row row-link">
                  <div className="row-main">
                    <div className="row-title">{l.name}</div>
                    <div className="row-sub">
                      {PROVIDER_NAME[l.provider]} · {LIST_KIND_LABEL[l.kind]}
                      {l.listedAt && ` · added ${date(l.listedAt)}`}
                      {l.watchedAt && ` · logged ${date(l.watchedAt)}`}
                      {l.matchMethod === 'title_year' && ' · matched by title'}
                    </div>
                    {l.notes && <div className="row-sub">“{l.notes}”</div>}
                  </div>
                  {l.rating !== null && (
                    <span className="inline footnote secondary" aria-label={`Rated ${l.rating}`}>
                      <Star size={13} aria-hidden /> {l.rating}
                    </span>
                  )}
                </Link>
              ))}
            </div>
          )}
        </section>
        <section aria-labelledby="links-h">
          <h2 className="group-title" id="links-h">
            Details
          </h2>
          <div className="group">
            {t.releaseDate && (
              <div className="row">
                <div className="row-main">Release</div>
                <div className="row-value">{date(t.releaseDate)}</div>
              </div>
            )}
            {(['tmdb', 'imdb', 'jellyfin', 'seerr'] as const)
              .filter((k) => d.links[k])
              .map((k) => (
                <a key={k} className="row row-link" href={d.links[k]!} target="_blank" rel="noreferrer noopener">
                  <div className="row-main">{k === 'jellyfin' ? 'Open in Jellyfin' : k === 'seerr' ? 'Open in Seerr' : `View on ${PROVIDER_NAME[k]}`}</div>
                  <ExternalLink size={15} className="row-chevron" aria-hidden />
                </a>
              ))}
            {d.requests.length > 0 &&
              d.requests.map((r) => (
                <div key={r.id} className="row">
                  <div className="row-main">
                    <div className="row-title">{REQUEST_STATE_LABEL[mapSeerrRequest(r.requestStatus, r.mediaStatus)]}</div>
                    <div className="row-sub">
                      {r.mine ? 'Your request' : `Requested by ${r.requestedBy ?? 'someone'}`} · {date(r.createdAt)}
                      {r.seasons.length > 0 && ` · seasons ${r.seasons.join(', ')}`}
                      {r.lastError && ` · ${r.lastError}`}
                    </div>
                  </div>
                </div>
              ))}
          </div>
          {t.metadataSource && <p className="group-footer">Metadata from {t.metadataSource === 'tmdb' || t.metadataSource === 'seerr' ? 'TMDb' : PROVIDER_NAME[t.metadataSource] ?? t.metadataSource}.</p>}
        </section>
      </div>

      {marking && <WatchedSheet titleId={t.id} title={t.title} mediaType={t.mediaType} watch={d.watch} onClose={() => setMarking(false)} />}
      {adding && <AddToListSheet title={{ id: t.id, tmdbId: t.tmdbId, mediaType: t.mediaType, title: t.title, year: t.year }} onClose={() => setAdding(false)} />}
      {requesting && <RequestSheet titleId={id} title={t.title} mediaType={t.mediaType} preset={presetSeason !== null && presetSeason > 0 ? [presetSeason] : null} onClose={closeRequest} />}
    </>
  );
}

function RequestSheet({ titleId, title, mediaType, preset, onClose }: { titleId: number; title: string; mediaType: 'movie' | 'tv'; preset: number[] | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const e = useQuery({ queryKey: ['eligibility', titleId], queryFn: () => get<Eligibility>(`/titles/${titleId}/eligibility`), staleTime: 0, gcTime: 0 });
  const [seasons, setSeasons] = useState<number[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const requestable = e.data?.seasons.filter((s) => s.requestable).map((s) => s.seasonNumber) ?? [];
  const presetRequestable = preset?.filter((n) => requestable.includes(n)) ?? [];
  const chosen = seasons ?? (presetRequestable.length > 0 ? presetRequestable : requestable);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ message: string }>(`/titles/${titleId}/request`, mediaType === 'tv' ? { seasons: chosen } : {});
      setDone(r.message);
      toast('success', `Requested ${title}.`);
      for (const k of ['title', 'catalog', 'home', 'requests']) void qc.invalidateQueries({ queryKey: [k] });
    } catch (err) {
      setError(errorText(err));
      void e.refetch();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={`Request ${title}`}
      footer={
        done ? (
          <button className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button className="btn btn-gray" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={submit} disabled={!e.data?.canRequest || busy || (mediaType === 'tv' && requestable.length > 0 && chosen.length === 0)}>
              {busy && <Spinner />}
              {mediaType === 'tv' && requestable.length > 0 ? `Request ${chosen.length === requestable.length ? 'All Missing' : chosen.length} Season${chosen.length === 1 ? '' : 's'}` : 'Request'}
            </button>
          </>
        )
      }
    >
      {e.isLoading ? (
        <div className="inline secondary">
          <Spinner /> Checking Seerr…
        </div>
      ) : e.isError ? (
        <Banner kind="error" action={<button className="btn btn-small" onClick={() => e.refetch()}><RefreshCw size={13} aria-hidden /> Retry</button>}>
          {errorText(e.error)}
        </Banner>
      ) : done ? (
        <Banner kind="success" title="Request sent">
          {done} JellyWatcher checks Seerr for updates and shows here when it’s in your library.
        </Banner>
      ) : (
        <div className="stack">
          {error && <Banner kind="error">{error}</Banner>}
          {!e.data!.canRequest ? (
            <Banner kind={e.data!.reason === 'already_available' || e.data!.reason === 'already_requested' ? 'info' : 'warn'} title="This can’t be requested right now">
              {e.data!.message}
            </Banner>
          ) : (
            <p className="secondary subhead" style={{ margin: 0 }}>
              {e.data!.autoApprove ? 'Your Seerr account is allowed to auto-approve, so this is sent for download right away.' : 'An administrator needs to approve this request in Seerr before it is downloaded.'}
            </p>
          )}
          {mediaType === 'tv' && e.data!.seasons.length > 0 && (
            <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="group-title">Seasons</legend>
              <div className="group" style={{ background: 'var(--surface-2)' }}>
                {e.data!.seasons.map((s) => (
                  <label key={s.seasonNumber} className="row" style={{ cursor: s.requestable ? 'pointer' : 'default' }}>
                    <input
                      type="checkbox"
                      disabled={!s.requestable}
                      checked={s.requestable && chosen.includes(s.seasonNumber)}
                      onChange={(ev) => setSeasons(ev.target.checked ? [...chosen, s.seasonNumber].sort((a, b) => a - b) : chosen.filter((x) => x !== s.seasonNumber))}
                      style={{ width: 18, height: 18, accentColor: 'var(--accent-fill)' }}
                    />
                    <div className="row-main">
                      <div className="row-title">{s.name ?? `Season ${s.seasonNumber}`}</div>
                      {s.episodeCount !== null && <div className="row-sub">{s.episodeCount} episodes</div>}
                    </div>
                    {s.state !== 'not_requested' && <RequestPill state={s.state} />}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <p className="caption secondary" style={{ margin: 0 }}>
            Checked live with Seerr <Time iso={e.data!.checkedAt} />.
          </p>
        </div>
      )}
    </Sheet>
  );
}
