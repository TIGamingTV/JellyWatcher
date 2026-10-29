import { Link } from 'react-router';
import { AlertTriangle, Check } from 'lucide-react';
import type { Timeline, TimelineEntry, TimelineSummary } from '../lib/types';
import { duration, episodeCode, plural } from '../lib/format';
import { PosterImage } from './Poster';
import { StagePill } from './status';

/** Display name of an entry: the show for seasons/episodes, plus what part of it. */
export function entryHeading(e: TimelineEntry): { title: string; part: string | null } {
  const title = e.title?.title ?? e.sourceTitle;
  if (e.kind === 'episode') return { title, part: [episodeCode(e.season, e.episode), e.episodeTitle].filter(Boolean).join(' · ') };
  if (e.kind === 'season') return { title, part: episodeCode(e.season, null) };
  return { title, part: null };
}

export function entryFacts(e: TimelineEntry): string[] {
  const facts: (string | null)[] = [];
  if (e.kind === 'movie') facts.push('Movie', e.year ? String(e.year) : null);
  else if (e.kind === 'show') facts.push('Show', e.seasons ? plural(e.seasons, 'season') : null, e.episodes ? plural(e.episodes, 'episode') : null);
  else if (e.kind === 'season') facts.push(e.episodes ? plural(e.episodes, 'episode') : 'Season');
  else facts.push('Episode');
  facts.push(e.runtime ? duration(e.runtime) : null);
  return facts.filter((f): f is string => Boolean(f));
}

export function TimelineSummaryPanel({ summary, compact }: { summary: TimelineSummary; compact?: boolean }) {
  const pct = summary.totalMinutes > 0 ? Math.round((summary.watchedMinutes / summary.totalMinutes) * 100) : 0;
  const stats = [
    { n: summary.films, label: summary.films === 1 ? 'Film' : 'Films' },
    { n: summary.shows, label: summary.shows === 1 ? 'Show' : 'Shows' },
    { n: summary.seasons, label: summary.seasons === 1 ? 'Season' : 'Seasons' },
    { n: summary.episodes, label: summary.episodes === 1 ? 'Episode' : 'Episodes' },
  ].filter((s, i) => s.n > 0 || i === 0);
  const done = summary.entries > 0 && summary.watchedEntries === summary.entries;
  return (
    <section className={compact ? 'tl-summary' : 'panel tl-summary'} aria-label="List totals">
      <div className="tl-stats">
        {stats.map((s) => (
          <div key={s.label} className="tl-stat">
            <b>{s.n.toLocaleString()}</b>
            <span>{s.label}</span>
          </div>
        ))}
        <div className="tl-stat">
          <b>{summary.totalMinutes > 0 ? duration(summary.totalMinutes) : '—'}</b>
          <span>Total Watch Time</span>
        </div>
        <div className="tl-stat">
          <b style={{ color: done ? 'var(--green)' : undefined }}>{done ? 'Done' : summary.totalMinutes > 0 ? duration(summary.remainingMinutes) : '—'}</b>
          <span>Left to Watch</span>
        </div>
      </div>
      {summary.totalMinutes > 0 && (
        <div className="stack" style={{ gap: 6 }}>
          <div className="progress progress-lg" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Watched">
            <i style={{ width: `${pct}%` }} />
          </div>
          <div className="tl-time">
            <span>
              <strong>{pct}%</strong> watched · {summary.watchedEntries} of {plural(summary.entries, 'entry', 'entries')} done
            </span>
            {summary.unknownRuntime > 0 && <span>{plural(summary.unknownRuntime, 'entry', 'entries')} without a runtime not counted</span>}
          </div>
        </div>
      )}
    </section>
  );
}

function EntryRow({ e, next }: { e: TimelineEntry; next: boolean }) {
  const { title, part } = entryHeading(e);
  const facts = entryFacts(e);
  const progressLabel =
    e.state === 'in_progress' && e.episodes ? `${e.watchedEpisodes ?? 0} of ${plural(e.episodes, 'episode')}` : e.state === 'in_progress' ? `${e.percent}% watched` : null;
  const kicker = next ? 'Up Next' : e.state === 'watched' ? 'Watched' : e.state === 'in_progress' ? 'Watching' : null;
  const body = (
    <>
      <div className="tl-thumb" aria-hidden>
        <PosterImage src={e.title?.posterUrl ?? null} alt="" fallback={title} />
      </div>
      <div className="tl-body">
        {kicker && <div className="tl-kicker">{kicker}</div>}
        <div className="tl-title">
          {title}
          {part && <span className="secondary" style={{ fontWeight: 500 }}> · {part}</span>}
        </div>
        <div className="tl-sub">
          {facts.map((f) => (
            <span key={f}>{f}</span>
          ))}
          {progressLabel && <span>{progressLabel}</span>}
        </div>
        {e.state === 'in_progress' && (
          <div className="progress" aria-hidden>
            <i style={{ width: `${e.percent}%` }} />
          </div>
        )}
      </div>
    </>
  );
  const label = `${e.position}. ${title}${part ? `, ${part}` : ''}. ${facts.join(', ')}. ${kicker ?? ''}`;
  return (
    <li className={`tl-item ${e.state}${next ? ' next' : ''}`} style={{ ['--pct' as string]: e.percent }} aria-current={next ? 'step' : undefined}>
      <span className="tl-node" aria-hidden>
        {e.state === 'watched' ? <Check size={14} strokeWidth={3} /> : e.position}
      </span>
      {e.title ? (
        <Link to={`/titles/${e.title.id}`} className="tl-card" aria-label={label}>
          {body}
        </Link>
      ) : (
        <div className="tl-card">{body}</div>
      )}
      <div className="tl-side">
        {e.matched ? (
          e.state !== 'watched' && (e.stage === 'listed' ? <span className="pill">Not Requested</span> : <StagePill stage={e.stage} />)
        ) : (
          <Link to="/watchlists/review" className="pill pill-orange">
            <AlertTriangle size={12} aria-hidden /> Needs Match
          </Link>
        )}
      </div>
    </li>
  );
}

export function TimelineView({ timeline }: { timeline: Timeline }) {
  return (
    <ol className="timeline" aria-label="Watch order">
      {timeline.entries.map((e, i) => (
        <EntryRow key={e.itemId} e={e} next={i === timeline.nextIndex} />
      ))}
    </ol>
  );
}
