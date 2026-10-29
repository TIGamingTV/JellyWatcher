import { useEffect, useRef, useState } from 'preact/hooks';
import { entryRequestable, REQUEST_STATE_LABEL, STAGE_LABEL } from '../../shared/status';
import { date, duration, plural } from '../../web/src/lib/format';
import { entryFacts, entryHeading, scopeOf } from '../../web/src/lib/timeline';
import { MIRROR_HINT, MIRROR_INTRO, MIRROR_OPTIONS, mirrorStatus } from '../../web/src/lib/mirror';
import type { Eligibility, JellyfinMirrorMode, ListView, Timeline, TimelineEntry } from '../../web/src/lib/types';
import { api, errorText, imageUrl } from './api';
import { listSource, syncLabel, webLink, type Ctx } from './App';
import { openJellyfinItem } from './jf-dom';
import { Banner, Dialog, Icon, Poster, Progress, Spinner } from './ui';

const heading = (e: TimelineEntry) => {
  const h = entryHeading(e);
  return [h.title, h.part].filter(Boolean).join(' · ');
};

const PLAYABLE = new Set(['in_library', 'partially_in_library']);

export function TimelineScreen({ id, ctx }: { id: number; ctx: Ctx }) {
  const [list, setList] = useState<ListView | null>(null);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [busyItem, setBusyItem] = useState<number | null>(null);
  const [requesting, setRequesting] = useState<TimelineEntry | null>(null);
  const [mirroring, setMirroring] = useState(false);
  const scrolled = useRef(false);

  const reload = () => setTick((n) => n + 1);

  useEffect(() => {
    let live = true;
    Promise.all([api.list(id), api.timeline(id)])
      .then(([l, t]) => {
        if (!live) return;
        setList(l.list);
        setTimeline(t);
        setEntries(t.entries);
        setError(null);
      })
      .catch((e: unknown) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [id, tick]);

  const busy = list ? list.lastStatus === 'running' || list.pending > 0 : false;
  const mirrorPending = Boolean(list?.jellyfin && !list.jellyfin.synced);
  useEffect(() => {
    if (!busy && !mirrorPending) return;
    const t = window.setTimeout(reload, busy ? 4000 : 5000);
    return () => window.clearTimeout(t);
  }, [busy, mirrorPending, list]);

  const nextIndex = entries.findIndex((e) => e.matched && e.state !== 'watched' && !e.skipped);

  // Bring Up Next into view the first time the list opens.
  useEffect(() => {
    if (scrolled.current || !timeline || nextIndex < 3) return;
    scrolled.current = true;
    requestAnimationFrame(() => document.querySelector('#jw-root .jw-tl-item.next')?.scrollIntoView({ block: 'center' }));
  }, [timeline]);

  const skip = async (e: TimelineEntry, skipped: boolean, undoable = true) => {
    if (!e.title) return;
    setEntries((all) => all.map((x) => (x.itemId === e.itemId ? { ...x, skipped } : x)));
    try {
      await api.skip(e.title.id, skipped, scopeOf(e));
      if (undoable) ctx.toast('info', skipped ? `Not watching ${heading(e)}.` : `${heading(e)} is back in the watch order.`, { label: 'Undo', run: () => void skip({ ...e, skipped }, !skipped, false) });
    } catch (err) {
      ctx.toast('error', errorText(err));
    }
    reload();
  };

  const watch = async (e: TimelineEntry, watched: boolean, undoable = true) => {
    if (!e.title) return;
    setBusyItem(e.itemId);
    try {
      await api.watched(e.title.id, watched, scopeOf(e));
      if (undoable) ctx.toast('success', watched ? `Marked ${heading(e)} as watched.` : `${heading(e)} is no longer marked as watched.`, { label: 'Undo', run: () => void watch(e, !watched, false) });
    } catch (err) {
      ctx.toast('error', errorText(err));
    } finally {
      setBusyItem(null);
      reload();
    }
  };

  const runSync = async () => {
    setSyncing(true);
    try {
      await api.sync(id);
    } catch (err) {
      ctx.toast('error', errorText(err));
    } finally {
      setSyncing(false);
      reload();
    }
  };

  const back = (
    <a class="jw-back" href="#/jellywatcher">
      <Icon name="arrow_back" size={18} /> All Lists
    </a>
  );

  if (error && !timeline) {
    return (
      <>
        {back}
        <Banner kind="error" action={<button class="jw-btn" onClick={reload}>Try Again</button>}>
          {error}
        </Banner>
      </>
    );
  }
  if (!list || !timeline) {
    return (
      <>
        {back}
        <div class="jw-center">
          <Spinner />
        </div>
      </>
    );
  }

  const s = timeline.summary;
  const pct = s.totalMinutes > 0 ? Math.round((s.watchedMinutes / s.totalMinutes) * 100) : 0;
  const done = s.entries > 0 && s.watchedEntries + s.skippedEntries >= s.entries;
  const status = syncLabel(list);
  const web = webLink(ctx.webUrl, `/watchlists/lists/${list.id}`);
  const review = webLink(ctx.webUrl, '/watchlists/review');
  const canRequest = ctx.boot.seerr.available;

  return (
    <>
      {back}
      <div class="jw-head">
        <div>
          <div class="jw-card-source">{listSource(list)}</div>
          <h1>{list.name}</h1>
          {status && (
            <div class={`jw-card-status jw-status-${status.kind}`}>
              {status.kind === 'busy' && <Spinner />}
              <span>{status.text}</span>
            </div>
          )}
        </div>
        <div class="jw-head-actions">
          {web && (
            <a class="jw-btn jw-btn-plain" href={web} target="_blank" rel="noopener noreferrer">
              <Icon name="open_in_new" size={18} /> JellyWatcher
            </a>
          )}
          <button class="jw-btn" onClick={() => setMirroring(true)} aria-haspopup="dialog">
            <Icon name={list.jellyfin?.mode === 'playlist' ? 'playlist_play' : 'video_library'} size={18} /> {list.jellyfin ? 'In Jellyfin' : 'Show in Jellyfin'}
          </button>
          {list.canSync && (
            <button class="jw-btn" onClick={runSync} disabled={syncing || list.lastStatus === 'running'}>
              {syncing ? <Spinner /> : <Icon name="sync" size={18} />} Sync
            </button>
          )}
        </div>
      </div>
      {list.jellyfin && <MirrorLine list={list} />}

      <section class="jw-summary" aria-label="List totals">
        <div class="jw-stats">
          <Stat n={s.entries.toLocaleString()} label={s.entries === 1 ? 'Entry' : 'Entries'} />
          {s.films > 0 && <Stat n={s.films.toLocaleString()} label={s.films === 1 ? 'Film' : 'Films'} />}
          {s.shows + s.seasons > 0 && <Stat n={s.episodes.toLocaleString()} label={s.episodes === 1 ? 'Episode' : 'Episodes'} />}
          <Stat n={s.totalMinutes > 0 ? duration(s.totalMinutes) : '—'} label="Watch Time" />
          <Stat n={done ? 'Done' : s.totalMinutes > 0 ? duration(s.remainingMinutes) : '—'} label="Left to Watch" accent={done} />
        </div>
        {s.totalMinutes > 0 && (
          <>
            <Progress pct={pct} large />
            <div class="jw-sub">
              {pct}% watched · {s.watchedEntries} of {plural(s.entries, 'entry', 'entries')} done
              {s.skippedEntries > 0 && ` · ${s.skippedEntries} not watching`}
            </div>
          </>
        )}
      </section>

      {list.pending > 0 && <Banner kind="info">JellyWatcher is still matching {plural(list.pending, 'title')} of this list. They appear here when they are matched.</Banner>}

      {entries.length === 0 ? (
        <div class="jw-empty">
          <Icon name="playlist_add" size={44} />
          <h2>This list is empty</h2>
          {list.editable && web && (
            <p>
              Add titles to it in{' '}
              <a href={web} target="_blank" rel="noopener noreferrer">
                JellyWatcher
              </a>
              .
            </p>
          )}
        </div>
      ) : (
        <ol class="jw-timeline" aria-label="Watch order">
          {entries.map((e, i) => (
            <Row
              key={e.itemId}
              e={e}
              next={i === nextIndex}
              busy={busyItem === e.itemId}
              canRequest={canRequest && entryRequestable(e)}
              reviewUrl={review}
              onSkip={() => void skip(e, !e.skipped)}
              onWatch={() => void watch(e, e.state !== 'watched')}
              onRequest={() => setRequesting(e)}
            />
          ))}
        </ol>
      )}

      {mirroring && (
        <MirrorDialog
          list={list}
          onClose={() => setMirroring(false)}
          onChanged={(l, message) => {
            setList(l);
            ctx.toast('success', message);
            reload();
          }}
        />
      )}

      {requesting?.title && (
        <RequestDialog
          entry={requesting}
          linked={ctx.boot.seerr.linked}
          onClose={() => setRequesting(null)}
          onDone={(message) => {
            ctx.toast('success', message);
            reload();
          }}
        />
      )}
    </>
  );
}

function MirrorLine({ list }: { list: ListView }) {
  const s = mirrorStatus(list.jellyfin!);
  return (
    <div class={`jw-card-status jw-status-${s.kind} jw-mirror-line`}>
      {s.kind === 'busy' ? <Spinner /> : <Icon name={s.kind === 'error' ? 'error' : list.jellyfin!.mode === 'playlist' ? 'playlist_play' : 'video_library'} size={18} />}
      <span>{s.text}</span>
    </div>
  );
}

function MirrorDialog({ list, onClose, onChanged }: { list: ListView; onClose: () => void; onChanged: (l: ListView, message: string) => void }) {
  const current = list.jellyfin?.mode ?? 'off';
  const [choice, setChoice] = useState<'off' | JellyfinMirrorMode>(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const mode = choice === 'off' ? null : choice;
      const r = await api.mirror(list.id, mode);
      // The plugin applies it right away; without this it would wait for its next interval.
      await api.applyMirrors().catch(() => undefined);
      onChanged(r.list, mode ? `“${list.name}” is being added to Jellyfin as a ${mode === 'collection' ? 'collection' : 'private playlist'}.` : `The Jellyfin ${current === 'playlist' ? 'playlist' : 'collection'} is being removed.`);
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Show in Jellyfin"
      onClose={onClose}
      footer={
        <>
          <button class="jw-btn jw-btn-plain" onClick={onClose}>
            Cancel
          </button>
          <button class="jw-btn jw-btn-primary" onClick={save} disabled={busy || choice === current}>
            {busy && <Spinner />} Save
          </button>
        </>
      }
    >
      {error && <Banner kind="error">{error}</Banner>}
      <p class="jw-sub">{MIRROR_INTRO}</p>
      <div class="jw-form" role="radiogroup" aria-label="Show in Jellyfin">
        {MIRROR_OPTIONS.map((o) => (
          <label class={`jw-option jw-radio${choice === o.value ? ' on' : ''}`} key={o.value}>
            <input type="radio" name="jw-mirror" value={o.value} checked={choice === o.value} onChange={() => setChoice(o.value)} />
            <span>
              <span class="jw-option-title">{o.label}</span>
              <span class="jw-hint">{MIRROR_HINT[o.value]}</span>
            </span>
          </label>
        ))}
      </div>
    </Dialog>
  );
}

function Stat({ n, label, accent }: { n: string; label: string; accent?: boolean }) {
  return (
    <div class="jw-stat">
      <b class={accent ? 'jw-accent' : undefined}>{n}</b>
      <span>{label}</span>
    </div>
  );
}

interface RowProps {
  e: TimelineEntry;
  next: boolean;
  busy: boolean;
  canRequest: boolean;
  reviewUrl: string | null;
  onSkip: () => void;
  onWatch: () => void;
  onRequest: () => void;
}

function Row({ e, next, busy, canRequest, reviewUrl, onSkip, onWatch, onRequest }: RowProps) {
  const { title, part } = entryHeading(e);
  const facts = entryFacts(e);
  const name = heading(e);
  const kicker = e.skipped ? 'Not Watching' : next ? 'Up Next' : e.state === 'watched' ? (e.watchedAt ? `Watched ${date(e.watchedAt)}` : 'Watched') : e.state === 'in_progress' ? 'Watching' : null;
  const progress = e.state === 'in_progress' && e.episodes ? `${e.watchedEpisodes ?? 0} of ${plural(e.episodes, 'episode')}` : e.state === 'in_progress' ? `${e.percent}% watched` : null;
  const playable = e.jellyfinItemId && PLAYABLE.has(e.availability);
  const showStage = e.matched && e.state !== 'watched' && !e.skipped && !(canRequest && e.stage === 'listed');
  return (
    <li class={`jw-tl-item ${e.state}${e.skipped ? ' skipped' : ''}${next ? ' next' : ''}`} style={{ ['--pct' as string]: e.percent }} aria-current={next ? 'step' : undefined}>
      <span class="jw-tl-node" aria-hidden="true">
        {e.state === 'watched' ? <Icon name="check" size={16} /> : e.skipped ? <Icon name="skip_next" size={16} /> : e.position}
      </span>
      <Poster src={imageUrl(e.title?.posterUrl)} alt={title} />
      <div class="jw-tl-body">
        {kicker && <div class="jw-tl-kicker">{kicker}</div>}
        <div class="jw-tl-title">
          {title}
          {part && <span class="jw-tl-part"> · {part}</span>}
        </div>
        <div class="jw-tl-facts">{[...facts, progress].filter(Boolean).join(' · ')}</div>
        {e.state === 'in_progress' && <Progress pct={e.percent} />}
        <div class="jw-tl-status">
          {!e.matched ? (
            reviewUrl ? (
              <a class="jw-pill jw-pill-warn" href={reviewUrl} target="_blank" rel="noopener noreferrer">
                <Icon name="warning_amber" size={14} /> Needs Match
              </a>
            ) : (
              <span class="jw-pill jw-pill-warn">Needs Match</span>
            )
          ) : (
            showStage && <span class={`jw-pill jw-stage-${e.stage}`}>{e.stage === 'listed' ? 'Not Requested' : STAGE_LABEL[e.stage]}</span>
          )}
        </div>
      </div>
      {e.matched && e.title && (
        <div class="jw-tl-actions">
          {playable && (
            <button class="jw-btn jw-btn-small jw-btn-primary" onClick={() => openJellyfinItem(e.jellyfinItemId!)} aria-label={`Play ${name} in Jellyfin`} title="Open in Jellyfin">
              <Icon name="play_arrow" size={18} /> <span class="jw-hide-sm">Play</span>
            </button>
          )}
          {canRequest && (
            <button class="jw-btn jw-btn-small" onClick={onRequest} aria-haspopup="dialog" aria-label={`Request ${name}`}>
              <Icon name="add" size={18} /> <span>{e.stage === 'declined' || e.stage === 'failed' ? 'Request Again' : 'Request'}</span>
            </button>
          )}
          {e.state !== 'watched' && (
            <button
              class={`jw-round${e.skipped ? ' on' : ''}`}
              onClick={onSkip}
              aria-pressed={e.skipped}
              aria-label={e.skipped ? `${name}: not watching. Put it back in the watch order` : `Not watching ${name}: skip it`}
              title={e.skipped ? 'Not watching · tap to put it back' : 'Not watching (skip)'}
            >
              <Icon name={e.skipped ? 'undo' : 'skip_next'} size={20} />
            </button>
          )}
          <button
            class={`jw-round jw-check${e.state === 'watched' ? ' on' : ''}`}
            onClick={onWatch}
            disabled={busy}
            aria-pressed={e.state === 'watched'}
            aria-label={e.state === 'watched' ? `${name}: watched. Unmark it` : `Mark ${name} as watched`}
            title={e.state === 'watched' ? 'Watched · tap to unmark' : 'Mark as watched'}
          >
            {busy ? <Spinner /> : <Icon name={e.state === 'watched' ? 'check' : 'radio_button_unchecked'} size={20} />}
          </button>
        </div>
      )}
    </li>
  );
}

function RequestDialog({ entry, linked, onClose, onDone }: { entry: TimelineEntry; linked: boolean; onClose: () => void; onDone: (message: string) => void }) {
  const t = entry.title!;
  const [elig, setElig] = useState<Eligibility | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<number[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    api.eligibility(t.id).then(setElig, (e: unknown) => setLoadError(errorText(e)));
  }, [t.id]);

  const requestable = elig?.seasons.filter((s) => s.requestable).map((s) => s.seasonNumber) ?? [];
  const preset = entry.season !== null && entry.season > 0 && requestable.includes(entry.season) ? [entry.season] : null;
  const seasons = chosen ?? preset ?? requestable;
  const tv = t.mediaType === 'tv';

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.request(t.id, tv ? seasons : undefined);
      setDone(r.message);
      onDone(`Requested ${heading(entry)}.`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={`Request ${heading(entry)}`}
      onClose={onClose}
      footer={
        done ? (
          <button class="jw-btn jw-btn-primary" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button class="jw-btn jw-btn-plain" onClick={onClose}>
              Cancel
            </button>
            <button class="jw-btn jw-btn-primary" onClick={submit} disabled={!elig?.canRequest || busy || (tv && requestable.length > 0 && seasons.length === 0)}>
              {busy && <Spinner />}
              {tv && requestable.length > 0 ? `Request ${seasons.length === requestable.length ? 'All Missing' : seasons.length} Season${seasons.length === 1 ? '' : 's'}` : 'Request'}
            </button>
          </>
        )
      }
    >
      {loadError ? (
        <Banner kind="error">{loadError}</Banner>
      ) : !elig ? (
        <div class="jw-inline">
          <Spinner /> Checking Seerr…
        </div>
      ) : done ? (
        <Banner kind="success" title="Request sent">
          {done} It shows up here once it is in your library.
        </Banner>
      ) : (
        <>
          {error && <Banner kind="error">{error}</Banner>}
          {!elig.canRequest ? (
            <Banner kind={elig.reason === 'already_available' || elig.reason === 'already_requested' ? 'info' : 'warn'} title="This can’t be requested right now">
              {elig.message}
              {elig.reason === 'seerr_not_linked' && !linked && ' Link your account to Seerr in JellyWatcher first.'}
            </Banner>
          ) : (
            <p class="jw-sub">{elig.autoApprove ? 'Your Seerr account can auto-approve, so this is sent for download right away.' : 'An administrator needs to approve this request in Seerr before it is downloaded.'}</p>
          )}
          {tv && elig.seasons.length > 0 && (
            <fieldset class="jw-seasons">
              <legend>Seasons</legend>
              {elig.seasons.map((s) => (
                <label key={s.seasonNumber} class={`jw-season${s.requestable ? '' : ' off'}`}>
                  <input
                    type="checkbox"
                    disabled={!s.requestable}
                    checked={s.requestable && seasons.includes(s.seasonNumber)}
                    onChange={(ev) => setChosen(ev.currentTarget.checked ? [...seasons, s.seasonNumber].sort((a, b) => a - b) : seasons.filter((x) => x !== s.seasonNumber))}
                  />
                  <span class="jw-season-name">
                    {s.name ?? `Season ${s.seasonNumber}`}
                    {s.episodeCount !== null && <span class="jw-hint"> · {plural(s.episodeCount, 'episode')}</span>}
                  </span>
                  {s.state !== 'not_requested' && <span class="jw-pill">{REQUEST_STATE_LABEL[s.state]}</span>}
                </label>
              ))}
            </fieldset>
          )}
        </>
      )}
    </Dialog>
  );
}

