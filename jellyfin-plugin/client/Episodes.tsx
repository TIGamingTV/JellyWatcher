import { useEffect, useState } from 'preact/hooks';
import { episodeCode } from '../../web/src/lib/format';
import {
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
} from '../../web/src/lib/episodes';
import type { EpisodeGuide, GuideEpisode, GuideSeason, TimelineEntry } from '../../web/src/lib/types';
import { api, errorText } from './api';
import { openJellyfinItem } from './jf-dom';
import { Icon, Spinner } from './ui';

type OnChange = (s: GuideSeason, e: GuideEpisode, patch: { watched?: boolean; skipped?: boolean }) => void;

/**
 * The episodes of an expanded show or season: seasons that fold open, each with a rail of its
 * episodes and Play, "Not Watching" and watched buttons per episode.
 */
export function Episodes({ entry, id, onChanged, onError }: { entry: TimelineEntry; id: string; onChanged: () => void; onError: (message: string) => void }) {
  const titleId = entry.title!.id;
  const [guide, setGuide] = useState<EpisodeGuide | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    api
      .episodes(titleId)
      .then((g) => {
        if (!live) return;
        setGuide(g);
        setError(null);
      })
      .catch((e: unknown) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [titleId, tick]);

  const change: OnChange = async (s, e, patch) => {
    if (guide) setGuide(withEpisode(guide, s.season, e.episode, { ...patch, source: patch.watched ? 'manual' : patch.watched === false ? null : e.source }));
    try {
      if (patch.watched !== undefined) await api.watched(titleId, patch.watched, { season: s.season, episode: e.episode });
      else await api.skip(titleId, Boolean(patch.skipped), { season: s.season, episode: e.episode });
    } catch (err) {
      onError(errorText(err));
    }
    setTick((n) => n + 1);
    onChanged();
  };

  if (!guide) {
    return (
      <div class="jw-episodes" id={id}>
        {error ? (
          <div class="jw-inline">
            <span>{error}</span>
            <button class="jw-btn jw-btn-small" onClick={() => setTick((n) => n + 1)}>
              Try Again
            </button>
          </div>
        ) : (
          <div class="jw-inline">
            <Spinner /> Loading episodes…
          </div>
        )}
      </div>
    );
  }

  const { regular, specials } = guideSeasons(guide, entry);
  const first = initialSeason(regular);
  return (
    <div class="jw-episodes" id={id}>
      {regular.length === 0 && <p class="jw-sub">The episodes of this show are not known yet.</p>}
      {regular.map((s) => (
        <Season key={s.season} s={s} initiallyOpen={entry.kind === 'season' || s.season === first} onChange={change} />
      ))}
      {specials && <Season s={specials} initiallyOpen={false} onChange={change} />}
    </div>
  );
}

function Season({ s, initiallyOpen, onChange }: { s: GuideSeason; initiallyOpen: boolean; onChange: OnChange }) {
  const [open, setOpen] = useState(initiallyOpen);
  const name = seasonTitle(s);
  const pct = seasonPercent(s);
  const rail = seasonRail(s);
  const next = nextEpisodeIndex(s);
  const listId = `jw-ep-${s.season}-${s.list[0]?.episode ?? 0}`;
  return (
    <section class={`jw-ep-season${open ? ' open' : ''}`}>
      <button class="jw-ep-season-head" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)} disabled={s.list.length === 0}>
        <Icon name="chevron_right" size={20} />
        <span class="jw-ep-season-text">
          <span class="jw-ep-season-title">
            {name}
            {seasonDone(s) && <Icon name="check" size={16} />}
          </span>
          <span class="jw-ep-season-facts">{seasonFacts(s).join(' · ')}</span>
        </span>
        <span class="jw-progress jw-ep-season-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${name} watched`}>
          <i style={{ width: `${pct}%` }} />
        </span>
      </button>
      {open && (
        <ol class="jw-ep-list" id={listId} aria-label={`Episodes of ${name}`}>
          {s.list.map((e, i) => (
            <Episode key={e.episode} s={s} e={e} done={rail[i]!} next={i === next} onChange={onChange} />
          ))}
        </ol>
      )}
    </section>
  );
}

function Episode({ s, e, done, next, onChange }: { s: GuideSeason; e: GuideEpisode; done: boolean; next: boolean; onChange: OnChange }) {
  const title = episodeTitle(e);
  const name = `${episodeCode(s.season, e.episode)} ${title}`;
  const facts = episodeFacts(e);
  const locked = e.source === 'jellyfin';
  return (
    <li class={`jw-ep${e.watched ? ' watched' : ''}${e.skipped ? ' skipped' : ''}${done ? ' done' : ''}${next ? ' next' : ''}${e.aired ? '' : ' unaired'}`}>
      <span class="jw-ep-node" aria-hidden="true">
        {e.watched ? <Icon name="check" size={14} /> : e.skipped ? <Icon name="skip_next" size={14} /> : null}
      </span>
      <span class="jw-ep-num" aria-hidden="true">
        {e.episode}
      </span>
      <div class="jw-ep-body">
        <div class="jw-ep-title">{title}</div>
        {(facts.length > 0 || next) && (
          <div class="jw-ep-sub">
            {next && <span class="jw-ep-next">Up Next</span>}
            {facts.map((f) => (
              <span key={f}>{f}</span>
            ))}
          </div>
        )}
      </div>
      <div class="jw-tl-actions">
        {e.jellyfinItemId && (
          <button class="jw-round jw-ep-btn" onClick={() => openJellyfinItem(e.jellyfinItemId!)} aria-label={`Play ${name} in Jellyfin`} title="Open in Jellyfin">
            <Icon name="play_arrow" size={18} />
          </button>
        )}
        {!e.watched && (
          <button
            class={`jw-round jw-ep-btn${e.skipped ? ' on' : ''}`}
            onClick={() => onChange(s, e, { skipped: !e.skipped })}
            aria-pressed={e.skipped}
            aria-label={e.skipped ? `${name}: not watching. Put it back` : `Not watching ${name}: skip it`}
            title={e.skipped ? 'Not watching · tap to put it back' : 'Not watching (skip)'}
          >
            <Icon name={e.skipped ? 'undo' : 'skip_next'} size={18} />
          </button>
        )}
        <button
          class={`jw-round jw-check jw-ep-btn${e.watched ? ' on' : ''}`}
          onClick={() => onChange(s, e, { watched: !e.watched })}
          disabled={locked}
          aria-pressed={e.watched}
          aria-label={e.watched ? `${name}: watched.${locked ? ' Watched in Jellyfin' : ' Unmark it'}` : `Mark ${name} as watched`}
          title={locked ? 'Watched in Jellyfin' : e.watched ? 'Watched · tap to unmark' : 'Mark as watched'}
        >
          <Icon name={e.watched ? 'check' : 'radio_button_unchecked'} size={18} />
        </button>
      </div>
    </li>
  );
}
