import { useState } from 'react';
import { Link } from 'react-router';
import { STAGE_LABEL } from '../../../shared/status';
import type { TitleCard } from '../lib/types';
import { STAGE_ICON } from './status';

export function PosterImage({ src, alt, fallback }: { src: string | null; alt: string; fallback: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <>
      {src && !failed ? <img src={src} alt={alt} loading="lazy" decoding="async" onError={() => setFailed(true)} /> : <div className="poster-fallback">{fallback}</div>}
    </>
  );
}

const QUIET_STAGES = new Set(['listed', 'unknown']);

export function PosterCard({ item }: { item: TitleCard }) {
  const Icon = STAGE_ICON[item.stage];
  const stageLabel = STAGE_LABEL[item.stage];
  const showBadge = !QUIET_STAGES.has(item.stage);
  const label = `${item.title}${item.year ? `, ${item.year}` : ''}. ${item.mediaType === 'tv' ? 'TV show' : 'Movie'}. ${stageLabel}${item.progress && item.viewing === 'in_progress' ? `, ${item.progress}% watched` : ''}.`;
  return (
    <Link to={`/titles/${item.id}`} className="poster-card" aria-label={label}>
      <div className={`poster-frame stage-${item.stage}`}>
        <PosterImage src={item.posterUrl} alt="" fallback={item.title} />
        {showBadge && (
          <span className="poster-badge" title={stageLabel} aria-hidden>
            <Icon size={14} strokeWidth={2.5} />
          </span>
        )}
        {item.viewing === 'in_progress' && item.progress !== null && item.progress > 0 && (
          <span className="poster-progress" aria-hidden>
            <i style={{ width: `${Math.min(100, item.progress)}%` }} />
          </span>
        )}
      </div>
      <div className="poster-meta" aria-hidden>
        <div className="poster-title">{item.title}</div>
        <div className="poster-sub">
          {item.year ?? '—'}
          <span>·</span>
          {item.mediaType === 'tv' ? 'Show' : 'Movie'}
        </div>
      </div>
    </Link>
  );
}

export function PosterGrid({ items, size }: { items: TitleCard[]; size?: 'small' | 'medium' | 'large' }) {
  return (
    <div className="poster-grid" data-size={size}>
      {items.map((i) => (
        <PosterCard key={i.id} item={i} />
      ))}
    </div>
  );
}

export function Shelf({ items }: { items: TitleCard[] }) {
  return (
    <div className="shelf">
      {items.map((i) => (
        <PosterCard key={i.id} item={i} />
      ))}
    </div>
  );
}
