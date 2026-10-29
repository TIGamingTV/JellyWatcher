import { useId, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, Eye, EyeOff } from 'lucide-react';
import { errorText, put } from '../lib/api';
import { useToast } from '../lib/session';
import type { MediaType, SeasonWatch, TitleStatus, WatchDetail } from '../lib/types';
import { date, episodeCode, plural, todayInput, watchedAtFromInput } from '../lib/format';
import { Banner, Sheet, Spinner } from './ui';

export interface WatchScope {
  season?: number | null;
  episode?: number | null;
  episodes?: { season: number; episode: number }[];
}

/** Marks or unmarks a title, season or episode as watched and refreshes everything that shows it. */
export function useWatchToggle(titleId: number) {
  const qc = useQueryClient();
  const toast = useToast();
  return async (watched: boolean, scope: WatchScope, dateInput?: string): Promise<{ status: TitleStatus; watch: WatchDetail } | null> => {
    try {
      const r = await put<{ status: TitleStatus; watch: WatchDetail }>(`/titles/${titleId}/watched`, {
        watched,
        season: scope.season ?? null,
        episode: scope.episode ?? null,
        episodes: scope.episodes,
        watchedAt: watched ? watchedAtFromInput(dateInput ?? todayInput()) : undefined,
      });
      for (const k of ['title', 'lists', 'catalog', 'home', 'library']) void qc.invalidateQueries({ queryKey: [k] });
      return r;
    } catch (err) {
      toast('error', errorText(err));
      return null;
    }
  };
}

export function DateField({ value, onChange, label = 'Watched on' }: { value: string; onChange: (v: string) => void; label?: string }) {
  const id = useId();
  return (
    <div className="field" style={{ maxWidth: 260 }}>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input id={id} className="input" type="date" max={todayInput()} min="1900-01-01" value={value} onChange={(e) => onChange(e.target.value || todayInput())} required />
    </div>
  );
}

const sourceText = (source: 'manual' | 'jellyfin' | null, at: string | null) =>
  source === 'jellyfin' ? `Watched in Jellyfin${at ? ` · ${date(at)}` : ''}` : source === 'manual' ? `Marked watched${at ? ` · ${date(at)}` : ''}` : 'Not watched';

function SeasonRow({ s, busy, onSeason, onEpisode }: { s: SeasonWatch; busy: string | null; onSeason: (s: SeasonWatch) => void; onEpisode: (s: SeasonWatch, e: number, watched: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const name = s.season === 0 ? 'Specials' : `Season ${s.season}`;
  const done = s.episodes !== null ? s.watched >= s.episodes && s.episodes > 0 : Boolean(s.manualAt);
  const fromJellyfinOnly = done && !s.manualAt && s.list.every((e) => e.source !== 'manual');
  return (
    <div className="watch-season">
      <div className="row" style={{ paddingInline: 12 }}>
        <button className="icon-btn" type="button" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} episodes of ${name}`} onClick={() => setOpen(!open)} disabled={s.list.length === 0}>
          <ChevronDown size={18} style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform .2s' }} aria-hidden />
        </button>
        <div className="row-main">
          <div className="row-title">{name}</div>
          <div className="row-sub">
            {s.episodes !== null ? `${s.watched} of ${plural(s.episodes, 'episode')} watched` : s.manualAt ? 'Marked watched' : 'Episode count unknown'}
            {s.manualAt && ` · ${date(s.manualAt)}`}
          </div>
        </div>
        <button className={`btn btn-small ${done ? 'btn-gray' : ''}`} type="button" disabled={busy !== null || fromJellyfinOnly} onClick={() => onSeason(s)} title={fromJellyfinOnly ? 'Watched in Jellyfin' : undefined}>
          {busy === `s${s.season}` ? <Spinner /> : done ? <Check size={14} aria-hidden /> : null}
          {done ? (s.manualAt || !fromJellyfinOnly ? 'Unmark' : 'Watched') : 'Mark Season'}
        </button>
      </div>
      {open && (
        <div className="ep-grid" role="group" aria-label={`Episodes of ${name}`}>
          {s.list.map((e) => (
            <button
              key={e.episode}
              type="button"
              className={`ep-chip${e.watched ? ' on' : ''}${e.source === 'jellyfin' ? ' locked' : ''}`}
              aria-pressed={e.watched}
              disabled={busy !== null || e.source === 'jellyfin'}
              title={`${episodeCode(s.season, e.episode)} · ${sourceText(e.source, e.watchedAt)}${e.inLibrary ? ' · in library' : ''}`}
              aria-label={`Episode ${e.episode}. ${sourceText(e.source, e.watchedAt)}.`}
              onClick={() => onEpisode(s, e.episode, !e.watched)}
            >
              {busy === `e${s.season}:${e.episode}` ? <Spinner /> : e.episode}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Mark as Watched: whole movie or show, single seasons and single episodes, each with the date it
 * was watched. Watched states reported by Jellyfin are shown but cannot be removed here.
 */
export function WatchedSheet({ titleId, title, mediaType, watch: initial, onClose }: { titleId: number; title: string; mediaType: MediaType; watch: WatchDetail; onClose: () => void }) {
  const toggle = useWatchToggle(titleId);
  const toast = useToast();
  const [watch, setWatch] = useState(initial);
  const [day, setDay] = useState(todayInput());
  const [busy, setBusy] = useState<string | null>(null);
  const [earlier, setEarlier] = useState(false);

  const act = async (key: string, watched: boolean, scope: WatchScope, message?: string) => {
    setBusy(key);
    const r = await toggle(watched, scope, day);
    setBusy(null);
    if (r) {
      setWatch(r.watch);
      if (message) toast('success', message);
    }
  };

  const watchedAll = Boolean(watch.watchedAt);
  const onEpisode = (s: SeasonWatch, e: number, watched: boolean) => {
    if (watched && earlier) {
      const eps: { season: number; episode: number }[] = [];
      for (const ss of watch.seasons) {
        if (ss.season === 0 || ss.season > s.season) continue;
        for (const x of ss.list) if (!x.watched && (ss.season < s.season || x.episode <= e)) eps.push({ season: ss.season, episode: x.episode });
      }
      void act(`e${s.season}:${e}`, true, { episodes: eps });
    } else void act(`e${s.season}:${e}`, watched, { season: s.season, episode: e });
  };
  const onSeason = (s: SeasonWatch) => {
    const done = s.episodes !== null ? s.watched >= s.episodes && s.episodes > 0 : Boolean(s.manualAt);
    void act(`s${s.season}`, !done, { season: s.season });
  };

  return (
    <Sheet open onClose={onClose} title={`Watched: ${title}`} wide={mediaType === 'tv'} footer={<button className="btn btn-primary" onClick={onClose}>Done</button>}>
      <div className="stack">
        <DateField value={day} onChange={setDay} />
        <div className="group" style={{ background: 'var(--surface-2)' }}>
          <div className="row">
            <div className="row-main">
              <div className="row-title">{mediaType === 'tv' ? 'Entire show' : title}</div>
              <div className="row-sub">
                {watch.manualAt ? `You marked it watched · ${date(watch.manualAt)}` : watchedAll ? `Watched${watch.watchedAt ? ` · ${date(watch.watchedAt)}` : ''}` : 'Not watched yet'}
              </div>
            </div>
            {watch.manualAt ? (
              <>
                <button className="btn btn-small btn-gray" disabled={busy !== null} onClick={() => act('title', true, {}, 'Date updated.')}>
                  Save Date
                </button>
                <button className="btn btn-small" disabled={busy !== null} onClick={() => act('title', false, {}, 'Marked as unwatched.')}>
                  {busy === 'title' ? <Spinner /> : <EyeOff size={14} aria-hidden />} Unmark
                </button>
              </>
            ) : (
              <button className="btn btn-small btn-primary" disabled={busy !== null || (watchedAll && mediaType === 'movie')} onClick={() => act('title', true, {}, mediaType === 'tv' ? 'Marked the whole show as watched.' : 'Marked as watched.')}>
                {busy === 'title' ? <Spinner /> : <Eye size={14} aria-hidden />} {mediaType === 'tv' ? 'Mark All Watched' : 'Mark Watched'}
              </button>
            )}
          </div>
        </div>
        {mediaType === 'tv' && (
          <>
            {watch.seasons.length === 0 ? (
              <Banner kind="info">Season details are not known yet. You can still mark the whole show as watched.</Banner>
            ) : (
              <>
                <div className="inline" style={{ justifyContent: 'space-between' }}>
                  <h3 className="group-title" style={{ margin: 0 }}>
                    Seasons and episodes
                  </h3>
                  <label className="inline footnote secondary" style={{ gap: 6 }}>
                    <input type="checkbox" checked={earlier} onChange={(e) => setEarlier(e.target.checked)} style={{ width: 16, height: 16, accentColor: 'var(--accent-fill)' }} />
                    Also mark earlier episodes
                  </label>
                </div>
                <div className="group" style={{ background: 'var(--surface-2)' }}>
                  {watch.seasons.map((s) => (
                    <SeasonRow key={s.season} s={s} busy={busy} onSeason={onSeason} onEpisode={onEpisode} />
                  ))}
                </div>
                <p className="caption secondary" style={{ margin: 0 }}>
                  Tap an episode to mark it. Episodes Jellyfin reports as watched are locked; mark them unwatched in Jellyfin.
                </p>
              </>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}

/** Compact sheet for one timeline entry: pick the date, or take a manual mark back. */
export function QuickWatchSheet({
  titleId,
  heading,
  scope,
  manualAt,
  watched,
  onClose,
}: {
  titleId: number;
  heading: string;
  scope: WatchScope;
  manualAt: string | null;
  watched: boolean;
  onClose: () => void;
}) {
  const toggle = useWatchToggle(titleId);
  const toast = useToast();
  const [day, setDay] = useState(manualAt ? manualAt.slice(0, 10) : todayInput());
  const [busy, setBusy] = useState(false);
  const run = async (w: boolean) => {
    setBusy(true);
    const r = await toggle(w, scope, day);
    setBusy(false);
    if (r) {
      toast('success', w ? `Marked ${heading} as watched.` : `Marked ${heading} as unwatched.`);
      onClose();
    }
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title={manualAt ? 'Watched' : 'Mark as Watched'}
      footer={
        <>
          {manualAt && (
            <button className="btn btn-gray" onClick={() => run(false)} disabled={busy}>
              <EyeOff size={15} aria-hidden /> Unmark
            </button>
          )}
          <span className="spacer" />
          <button className="btn btn-gray" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => run(true)} disabled={busy}>
            {busy && <Spinner />}
            {manualAt ? 'Save Date' : 'Mark Watched'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="subhead">
          <strong>{heading}</strong>
          {watched && !manualAt && <div className="secondary footnote">Jellyfin already reports this as watched; a mark adds your own date.</div>}
          {manualAt && <div className="secondary footnote">You marked this watched on {date(manualAt)}.</div>}
        </div>
        <DateField value={day} onChange={setDay} />
      </div>
    </Sheet>
  );
}
