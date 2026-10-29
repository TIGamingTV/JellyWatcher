import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { errorText, get, post } from '../lib/api';
import { useToast } from '../lib/session';
import type { Eligibility } from '../lib/types';
import { Banner, Sheet, Spinner, Time } from './ui';
import { RequestPill } from './status';

/** Asks Seerr live what can be requested, then sends the request (seasons for shows). */
export function RequestSheet({ titleId, title, mediaType, preset, onClose }: { titleId: number; title: string; mediaType: 'movie' | 'tv'; preset: number[] | null; onClose: () => void }) {
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
      for (const k of ['title', 'catalog', 'home', 'requests', 'lists']) void qc.invalidateQueries({ queryKey: [k] });
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
