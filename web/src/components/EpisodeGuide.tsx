import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight, Circle, ListPlus, SkipForward, Undo2 } from 'lucide-react';
import { errorText, get, post, put } from '../lib/api';
import { useToast } from '../lib/session';
import { date, episodeCode } from '../lib/format';
import {
  canAddSpecials,
  episodeFacts,
  episodeTitle,
  guideSeasons,
  initialSeason,
  nextEpisodeIndex,
  seasonDone,
  seasonFacts,
  seasonPercent,
  seasonRail,
  seasonTitle,
  withEpisode,
} from '../lib/episodes';
import type { EpisodeGuide as Guide, GuideEpisode, GuideSeason, TimelineEntry } from '../lib/types';
import { Spinner } from './ui';

const sourceText = (e: GuideEpisode) =>
  e.source === 'jellyfin' ? `Watched in Jellyfin${e.watchedAt ? ` · ${date(e.watchedAt)}` : ''}` : e.source === 'manual' ? `Marked watched${e.watchedAt ? ` · ${date(e.watchedAt)}` : ''}` : null;

/**
 * The episodes of an expanded show or season in a timeline: seasons that fold open, each with a
 * rail of its episodes and a watched and a "Not Watching" button per episode.
 */
export function EpisodeGuide({ entry, entries, listId, editable, id }: { entry: TimelineEntry; entries: TimelineEntry[]; listId?: number; editable: boolean; id: string }) {
  const titleId = entry.title!.id;
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['episodes', titleId];
  const q = useQuery({ queryKey: key, queryFn: () => get<Guide>(`/titles/${titleId}/episodes`), staleTime: 30_000 });
  const [adding, setAdding] = useState(false);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    for (const k of ['lists', 'home', 'title']) void qc.invalidateQueries({ queryKey: [k] });
  };

  const change = async (s: GuideSeason, e: GuideEpisode, patch: { watched?: boolean; skipped?: boolean }) => {
    const before = qc.getQueryData<Guide>(key);
    if (before) qc.setQueryData(key, withEpisode(before, s.season, e.episode, { ...patch, source: patch.watched ? 'manual' : patch.watched === false ? null : e.source }));
    try {
      if (patch.watched !== undefined) await put(`/titles/${titleId}/watched`, { watched: patch.watched, season: s.season, episode: e.episode });
      else await put(`/titles/${titleId}/skipped`, { skipped: patch.skipped, season: s.season, episode: e.episode });
    } catch (err) {
      if (before) qc.setQueryData(key, before);
      toast('error', errorText(err));
    }
    refresh();
  };

  const addSpecials = async () => {
    if (!listId || !entry.title?.tmdbId) return;
    setAdding(true);
    try {
      await post(`/lists/${listId}/items`, { tmdbId: entry.title.tmdbId, mediaType: 'tv', title: entry.title.title, year: entry.title.year, season: 0, afterItemId: entry.itemId });
      toast('success', `Added the specials of ${entry.title.title} after the show.`);
      refresh();
    } catch (err) {
      toast('error', errorText(err));
    } finally {
      setAdding(false);
    }
  };

  if (q.isLoading) {
    return (
      <div className="tl-episodes" id={id}>
        <div className="inline secondary footnote" style={{ padding: '10px 0' }}>
          <Spinner /> Loading episodes…
        </div>
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className="tl-episodes" id={id}>
        <div className="inline footnote" style={{ padding: '10px 0', gap: 10 }}>
          <span className="secondary">{errorText(q.error)}</span>
          <button className="btn btn-small btn-gray" onClick={() => q.refetch()}>
            Try Again
          </button>
        </div>
      </div>
    );
  }

  const { regular, specials } = guideSeasons(q.data, entry);
  const showAdd = specials !== null && canAddSpecials(entry, entries, editable);
  return (
    <div className="tl-episodes" id={id}>
      {regular.length === 0 && <p className="footnote secondary" style={{ margin: '8px 0' }}>The episodes of this show are not known yet.</p>}
      <SeasonList seasons={regular} single={entry.kind === 'season'} onChange={change} />
      {specials && (
        <SeasonBlock
          s={specials}
          initiallyOpen={false}
          onChange={change}
          extra={
            showAdd && (
              <button className="btn btn-small btn-gray" onClick={addSpecials} disabled={adding}>
                {adding ? <Spinner /> : <ListPlus size={14} aria-hidden />} Add Specials to This List
              </button>
            )
          }
        />
      )}
      <div className="ep-foot">
        <Link to={`/titles/${titleId}`}>Show Details</Link>
        {q.data.source === null && regular.length > 0 && <span className="caption secondary">Connect TMDb or Seerr to see episode names.</span>}
      </div>
    </div>
  );
}

type OnChange = (s: GuideSeason, e: GuideEpisode, patch: { watched?: boolean; skipped?: boolean }) => void;

function SeasonList({ seasons, single, onChange }: { seasons: GuideSeason[]; single: boolean; onChange: OnChange }) {
  const [first] = useState(() => initialSeason(seasons));
  return (
    <>
      {seasons.map((s) => (
        <SeasonBlock key={s.season} s={s} initiallyOpen={single || s.season === first} onChange={onChange} />
      ))}
    </>
  );
}

function SeasonBlock({ s, initiallyOpen, onChange, extra }: { s: GuideSeason; initiallyOpen: boolean; onChange: OnChange; extra?: React.ReactNode }) {
  const [open, setOpen] = useState(initiallyOpen);
  const name = seasonTitle(s);
  const pct = seasonPercent(s);
  const done = seasonDone(s);
  const rail = seasonRail(s);
  const next = nextEpisodeIndex(s);
  const listId = `ep-season-${s.season}-${s.list[0]?.episode ?? 0}`;
  return (
    <section className={`ep-season${open ? ' open' : ''}${done ? ' done' : ''}`}>
      <div className="ep-season-row">
        <button className="ep-season-head" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)} disabled={s.list.length === 0}>
          <ChevronRight size={18} className="ep-chevron" aria-hidden />
          <span className="ep-season-text">
            <span className="ep-season-title">
              {name}
              {done && <Check size={14} strokeWidth={3} className="ep-season-check" aria-label="All watched" />}
            </span>
            <span className="ep-season-facts">{seasonFacts(s).join(' · ')}</span>
          </span>
          <span className="progress ep-season-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${name} watched`}>
            <i style={{ width: `${pct}%` }} />
          </span>
        </button>
        {extra}
      </div>
      {open && (
        <ol className="ep-list" id={listId} aria-label={`Episodes of ${name}`}>
          {s.list.map((e, i) => (
            <EpisodeLine key={e.episode} s={s} e={e} done={rail[i]!} next={i === next} onChange={onChange} />
          ))}
        </ol>
      )}
    </section>
  );
}

function EpisodeLine({ s, e, done, next, onChange }: { s: GuideSeason; e: GuideEpisode; done: boolean; next: boolean; onChange: OnChange }) {
  const title = episodeTitle(e);
  const name = `${episodeCode(s.season, e.episode)} ${title}`;
  const facts = episodeFacts(e);
  const locked = e.source === 'jellyfin';
  const watchedNote = sourceText(e);
  return (
    <li className={`ep-item${e.watched ? ' watched' : ''}${e.skipped ? ' skipped' : ''}${done ? ' done' : ''}${next ? ' next' : ''}${e.aired ? '' : ' unaired'}`}>
      <span className="ep-node" aria-hidden>
        {e.watched ? <Check size={12} strokeWidth={3.5} /> : e.skipped ? <SkipForward size={11} strokeWidth={2.5} /> : null}
      </span>
      <span className="ep-num" aria-hidden>
        {e.episode}
      </span>
      <div className="ep-body">
        <div className="ep-title">{title}</div>
        {(facts.length > 0 || next) && (
          <div className="ep-sub">
            {next && <span className="ep-next">Up Next</span>}
            {facts.map((f) => (
              <span key={f}>{f}</span>
            ))}
          </div>
        )}
      </div>
      <div className="tl-actions">
        {!e.watched && (
          <button
            className={`tl-check tl-skip ep-btn${e.skipped ? ' on' : ''}`}
            onClick={() => onChange(s, e, { skipped: !e.skipped })}
            aria-pressed={e.skipped}
            aria-label={e.skipped ? `${name}: not watching. Put it back` : `Not watching ${name}: skip it`}
            title={e.skipped ? 'Not watching · tap to put it back' : 'Not watching (skip)'}
          >
            {e.skipped ? <Undo2 size={14} aria-hidden /> : <SkipForward size={15} aria-hidden />}
          </button>
        )}
        <button
          className={`tl-check ep-btn${e.watched ? ' on' : ''}`}
          onClick={() => onChange(s, e, { watched: !e.watched })}
          disabled={locked}
          aria-pressed={e.watched}
          aria-label={e.watched ? `${name}: ${watchedNote ?? 'watched'}.${locked ? '' : ' Unmark it'}` : `Mark ${name} as watched`}
          title={locked ? `${watchedNote}. Mark it unwatched in Jellyfin.` : e.watched ? `${watchedNote ?? 'Watched'} · tap to unmark` : 'Mark as watched'}
        >
          {e.watched ? <Check size={14} strokeWidth={3} aria-hidden /> : <Circle size={16} aria-hidden />}
        </button>
      </div>
    </li>
  );
}
