import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { AlertTriangle, Check, ChevronDown, Circle, GripVertical, Plus, SkipForward, Trash2, Tv, Undo2 } from 'lucide-react';
import { entryRequestable } from '../../../shared/status';
import type { Timeline, TimelineEntry, TimelineSummary } from '../lib/types';
import { useUser } from '../lib/session';
import { date, duration, plural } from '../lib/format';
import { entryFacts, entryHeading, entryProgress, expandable, nextEntryIndex, scopeOf, timelineRail } from '../lib/timeline';

export { entryFacts, entryHeading, scopeOf };
import { PosterImage } from './Poster';
import { StagePill } from './status';
import { QuickWatchSheet, useSkipToggle } from './Watched';
import { RequestSheet } from './RequestSheet';
import { EpisodeGuide } from './EpisodeGuide';

export function TimelineSummaryPanel({ summary, compact }: { summary: TimelineSummary; compact?: boolean }) {
  const pct = summary.totalMinutes > 0 ? Math.round((summary.watchedMinutes / summary.totalMinutes) * 100) : 0;
  const stats = [
    { n: summary.films, label: summary.films === 1 ? 'Film' : 'Films' },
    { n: summary.shows, label: summary.shows === 1 ? 'Show' : 'Shows' },
    { n: summary.seasons, label: summary.seasons === 1 ? 'Season' : 'Seasons' },
    { n: summary.episodes, label: summary.episodes === 1 ? 'Episode' : 'Episodes' },
  ].filter((s, i) => s.n > 0 || i === 0);
  const done = summary.entries > 0 && summary.watchedEntries + (summary.skippedEntries ?? 0) >= summary.entries;
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
              {summary.skippedEntries > 0 && ` · ${summary.skippedEntries} not watching`}
            </span>
            {summary.unknownRuntime > 0 && <span>{plural(summary.unknownRuntime, 'entry', 'entries')} without a runtime not counted</span>}
          </div>
        </div>
      )}
    </section>
  );
}

interface RowProps {
  e: TimelineEntry;
  entries: TimelineEntry[];
  listId?: number;
  next: boolean;
  /** The rail runs through this entry (watched, or skipped before Up Next). */
  done: boolean;
  expanded: boolean;
  onToggle: () => void;
  editing: boolean;
  removable: boolean;
  total: number;
  canRequest: boolean;
  onRequest: (e: TimelineEntry) => void;
  onWatch: (e: TimelineEntry) => void;
  onSkip: (e: TimelineEntry) => void;
  onRemove: (e: TimelineEntry) => void;
  onHandleDown: (ev: React.PointerEvent<HTMLButtonElement>) => void;
  onHandleKey: (ev: React.KeyboardEvent<HTMLButtonElement>) => void;
}

function EntryRow({ e, entries, listId, next, done, expanded, onToggle, editing, removable, total, canRequest, onRequest, onWatch, onSkip, onRemove, onHandleDown, onHandleKey }: RowProps) {
  const { title, part } = entryHeading(e);
  const facts = entryFacts(e);
  const progressLabel = entryProgress(e);
  const kicker = e.header
    ? e.state === 'watched'
      ? 'Watched'
      : null
    : e.skipped
      ? 'Not Watching'
      : next
        ? 'Up Next'
        : e.state === 'watched'
          ? e.watchedAt
            ? `Watched ${date(e.watchedAt)}`
            : 'Watched'
          : e.state === 'in_progress'
            ? 'Watching'
            : null;
  const name = `${title}${part ? `, ${part}` : ''}`;
  const canExpand = expandable(e) && !editing;
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
          {canExpand && <ChevronDown size={16} className="tl-chevron" aria-hidden />}
        </div>
        <div className="tl-sub">
          {facts.map((f) => (
            <span key={f}>{f}</span>
          ))}
          {progressLabel && <span>{progressLabel}</span>}
        </div>
        {e.state === 'in_progress' && !e.header && (
          <div className="progress" aria-hidden>
            <i style={{ width: `${e.percent}%` }} />
          </div>
        )}
      </div>
    </>
  );
  const label = `${e.position}. ${name}. ${facts.join(', ')}. ${kicker ?? ''}`;
  const panelId = `tl-episodes-${e.itemId}`;
  return (
    <li
      className={`tl-item ${e.state}${e.header ? ' header' : ''}${e.skipped && !e.header ? ' skipped' : ''}${next ? ' next' : ''}${done ? ' done' : ''}${expanded && canExpand ? ' expanded' : ''}`}
      style={{ ['--pct' as string]: e.percent }}
      aria-current={next ? 'step' : undefined}
      data-item={e.itemId}
    >
      <div className="tl-row">
        <span className="tl-node" aria-hidden>
          {e.header ? <Tv size={13} strokeWidth={2.5} /> : e.state === 'watched' ? <Check size={14} strokeWidth={3} /> : e.skipped ? <SkipForward size={12} strokeWidth={2.5} /> : e.position}
        </span>
        {canExpand ? (
          <button type="button" className="tl-card tl-toggle" onClick={onToggle} aria-expanded={expanded} aria-controls={expanded ? panelId : undefined} aria-label={`${label}. ${expanded ? 'Hide' : 'Show'} episodes`}>
            {body}
          </button>
        ) : e.title && !editing ? (
          <Link to={`/titles/${e.title.id}`} className="tl-card" aria-label={label}>
            {body}
          </Link>
        ) : (
          <div className="tl-card">{body}</div>
        )}
        <div className="tl-side">
          {editing ? (
            removable && (
              <button className="icon-btn tl-remove" onClick={() => onRemove(e)} aria-label={`Remove ${name} from the list`} title="Remove">
                <Trash2 size={17} />
              </button>
            )
          ) : e.header ? null : (
            <>
              {e.matched ? (
                e.state !== 'watched' &&
                !e.skipped && (
                  <div className="tl-status">
                    {e.stage === 'listed' ? !canRequest && <span className="pill">Not Requested</span> : <StagePill stage={e.stage} />}
                    {canRequest && (
                      <button className="btn btn-small tl-request" onClick={() => onRequest(e)} aria-haspopup="dialog" aria-label={`Request ${name}`}>
                        <Plus size={14} aria-hidden /> {e.stage === 'declined' || e.stage === 'failed' ? 'Request Again' : 'Request'}
                      </button>
                    )}
                  </div>
                )
              ) : (
                <Link to="/watchlists/review" className="pill pill-orange">
                  <AlertTriangle size={12} aria-hidden /> Needs Match
                </Link>
              )}
              {e.matched && e.title && (
                <div className="tl-actions">
                  {e.state !== 'watched' && (
                    <button
                      className={`tl-check tl-skip${e.skipped ? ' on' : ''}`}
                      onClick={() => onSkip(e)}
                      aria-pressed={e.skipped}
                      aria-label={e.skipped ? `${name}: not watching. Put it back in the watch order` : `Not watching ${name}: skip it`}
                      title={e.skipped ? 'Not watching · tap to put it back' : 'Not watching (skip)'}
                    >
                      {e.skipped ? <Undo2 size={16} aria-hidden /> : <SkipForward size={17} aria-hidden />}
                    </button>
                  )}
                  <button
                    className={`tl-check${e.state === 'watched' ? ' on' : ''}`}
                    onClick={() => onWatch(e)}
                    aria-label={e.state === 'watched' ? `${name}: watched. Change the date or unmark` : `Mark ${name} as watched`}
                    title={e.state === 'watched' ? 'Watched' : 'Mark as watched'}
                    aria-haspopup="dialog"
                  >
                    {e.state === 'watched' ? <Check size={16} strokeWidth={3} aria-hidden /> : <Circle size={18} aria-hidden />}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
        {editing && (
          <button
            className="tl-handle"
            aria-label={`Move ${name}, position ${e.position} of ${total}. Use the arrow keys to move.`}
            aria-roledescription="sortable"
            onPointerDown={onHandleDown}
            onKeyDown={onHandleKey}
          >
            <GripVertical size={20} aria-hidden />
          </button>
        )}
      </div>
      {expanded && canExpand && <EpisodeGuide entry={e} entries={entries} listId={listId} editable={removable} id={panelId} />}
    </li>
  );
}

function renumber(entries: TimelineEntry[]): TimelineEntry[] {
  return entries.map((e, i) => (e.position === i + 1 ? e : { ...e, position: i + 1 }));
}

function move<T>(arr: T[], from: number, to: number): T[] {
  const out = [...arr];
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x!);
  return out;
}

interface DragState {
  from: number;
  over: number;
  pointerId: number;
  startPageY: number;
  clientY: number;
  items: HTMLElement[];
  rects: { top: number; height: number }[];
  raf: number;
}

/**
 * The list in order. In edit mode entries are reordered by dragging the handle (mouse, touch or
 * pen, with auto-scroll) or with the arrow keys on the focused handle.
 */
export function TimelineView({
  timeline,
  listId,
  editing = false,
  removable = false,
  onOrder,
  onRemove,
}: {
  timeline: Timeline;
  /** The list shown (adding a show's specials to it). */
  listId?: number;
  editing?: boolean;
  /** A local list: entries can be removed and added. */
  removable?: boolean;
  onOrder?: (itemIds: number[]) => void;
  onRemove?: (e: TimelineEntry) => void;
}) {
  const [entries, setEntries] = useState(timeline.entries);
  const [watching, setWatching] = useState<TimelineEntry | null>(null);
  const [requesting, setRequesting] = useState<TimelineEntry | null>(null);
  const { services } = useUser();
  const [announce, setAnnounce] = useState('');
  const listRef = useRef<HTMLOListElement>(null);
  const drag = useRef<DragState | null>(null);

  useEffect(() => {
    if (!drag.current) setEntries(timeline.entries);
  }, [timeline.entries]);

  const nextIndex = nextEntryIndex(entries);
  const rail = timelineRail(entries, nextIndex);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const toggle = (itemId: number) =>
    setExpanded((cur) => {
      const out = new Set(cur);
      if (!out.delete(itemId)) out.add(itemId);
      return out;
    });
  const skip = useSkipToggle();
  const onSkip = (e: TimelineEntry) => {
    if (!e.title) return;
    const h = entryHeading(e);
    const heading = [h.title, h.part].filter(Boolean).join(' · ');
    // Optimistic: the row updates right away; the refetch confirms it.
    setEntries((all) => all.map((x) => (x.itemId === e.itemId ? { ...x, skipped: !e.skipped } : x)));
    void skip(e.title.id, !e.skipped, scopeOf(e), heading).then((ok) => {
      if (!ok) setEntries(timeline.entries);
    });
  };

  const commit = (from: number, to: number) => {
    if (from === to) return;
    const next = renumber(move(entries, from, to));
    setEntries(next);
    const e = next[to]!;
    setAnnounce(`Moved ${entryHeading(e).title} to position ${to + 1} of ${next.length}.`);
    onOrder?.(next.map((x) => x.itemId));
  };

  const layout = (d: DragState) => {
    const dy = d.clientY + window.scrollY - d.startPageY;
    const r = d.rects[d.from]!;
    const center = r.top + r.height / 2 + dy;
    let over = d.from;
    for (let i = 0; i < d.rects.length; i++) {
      const mid = d.rects[i]!.top + d.rects[i]!.height / 2;
      if (i < d.from && center < mid) over = Math.min(over, i);
      if (i > d.from && center > mid) over = i;
    }
    d.over = over;
    d.items.forEach((el, i) => {
      if (i === d.from) el.style.transform = `translateY(${dy}px)`;
      else {
        const shift = d.from < i && i <= over ? -r.height : over <= i && i < d.from ? r.height : 0;
        el.style.transform = shift ? `translateY(${shift}px)` : '';
      }
    });
  };

  const end = (handle: HTMLElement, save: boolean) => {
    const d = drag.current;
    if (!d) return;
    cancelAnimationFrame(d.raf);
    if (handle.hasPointerCapture?.(d.pointerId)) handle.releasePointerCapture(d.pointerId);
    for (const el of d.items) el.style.transform = '';
    d.items[d.from]?.classList.remove('dragging');
    listRef.current?.classList.remove('sorting');
    drag.current = null;
    if (save) commit(d.from, d.over);
  };

  const onHandleDown = (index: number) => (ev: React.PointerEvent<HTMLButtonElement>) => {
    if (ev.button !== 0 || !listRef.current) return;
    ev.preventDefault();
    const handle = ev.currentTarget;
    handle.setPointerCapture(ev.pointerId);
    const items = [...listRef.current.children] as HTMLElement[];
    const d: DragState = {
      from: index,
      over: index,
      pointerId: ev.pointerId,
      startPageY: ev.clientY + window.scrollY,
      clientY: ev.clientY,
      items,
      rects: items.map((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top + window.scrollY, height: r.height };
      }),
      raf: 0,
    };
    drag.current = d;
    items[index]?.classList.add('dragging');
    listRef.current.classList.add('sorting');
    // Auto-scroll near the top and bottom edges (the bottom also clears the iPhone tab bar).
    const loop = () => {
      const cur = drag.current;
      if (!cur) return;
      const edgeTop = 90;
      const edgeBottom = window.innerHeight - (window.innerWidth < 900 ? 140 : 70);
      const speed = cur.clientY < edgeTop ? -Math.ceil((edgeTop - cur.clientY) / 6) : cur.clientY > edgeBottom ? Math.ceil((cur.clientY - edgeBottom) / 6) : 0;
      if (speed) {
        window.scrollBy(0, speed);
        layout(cur);
      }
      cur.raf = requestAnimationFrame(loop);
    };
    d.raf = requestAnimationFrame(loop);
    const onMove = (e: PointerEvent) => {
      const cur = drag.current;
      if (!cur || e.pointerId !== cur.pointerId) return;
      cur.clientY = e.clientY;
      layout(cur);
    };
    const onUp = (e: PointerEvent) => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      end(handle, e.type === 'pointerup');
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  };

  const onHandleKey = (index: number) => (ev: React.KeyboardEvent<HTMLButtonElement>) => {
    const to =
      ev.key === 'ArrowUp' ? index - 1 : ev.key === 'ArrowDown' ? index + 1 : ev.key === 'Home' ? 0 : ev.key === 'End' ? entries.length - 1 : ev.key === 'PageUp' ? index - 10 : ev.key === 'PageDown' ? index + 10 : null;
    if (to === null) return;
    ev.preventDefault();
    const target = Math.max(0, Math.min(entries.length - 1, to));
    commit(index, target);
    const id = entries[index]!.itemId;
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLButtonElement>(`[data-item="${id}"] .tl-handle`)?.focus());
  };

  const w = watching;
  const r = requesting;
  return (
    <>
      <ol ref={listRef} className={`timeline${editing ? ' reordering' : ''}`} aria-label="Watch order">
        {entries.map((e, i) => (
          <EntryRow
            key={e.itemId}
            e={e}
            entries={entries}
            listId={listId}
            next={!editing && i === nextIndex}
            done={rail[i]!}
            expanded={!editing && expanded.has(e.itemId)}
            onToggle={() => toggle(e.itemId)}
            editing={editing}
            removable={removable}
            total={entries.length}
            canRequest={services.seerr && entryRequestable(e)}
            onRequest={setRequesting}
            onWatch={setWatching}
            onSkip={onSkip}
            onRemove={(x) => onRemove?.(x)}
            onHandleDown={onHandleDown(i)}
            onHandleKey={onHandleKey(i)}
          />
        ))}
      </ol>
      <div className="visually-hidden" aria-live="assertive">
        {announce}
      </div>
      {w && w.title && (
        <QuickWatchSheet
          titleId={w.title.id}
          heading={[entryHeading(w).title, entryHeading(w).part].filter(Boolean).join(' · ')}
          scope={scopeOf(w)}
          manualAt={w.manualAt}
          watched={w.state === 'watched'}
          onClose={() => setWatching(null)}
        />
      )}
      {r && r.title && (
        <RequestSheet
          titleId={r.title.id}
          title={[entryHeading(r).title, entryHeading(r).part].filter(Boolean).join(' · ')}
          mediaType={r.title.mediaType}
          preset={r.season !== null && r.season > 0 ? [r.season] : null}
          onClose={() => setRequesting(null)}
        />
      )}
    </>
  );
}
