import { useEffect, useId, useRef, type ReactNode } from 'react';
import { AlertTriangle, CircleAlert, Info, CheckCircle2, X, Search, RefreshCw } from 'lucide-react';
import { dateTime, relativeTime } from '../lib/format';

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  useEffect(() => {
    document.title = `${title} · JellyWatcher`;
  }, [title]);
  return (
    <header className="page-header">
      <div>
        <h1 className="large-title">{title}</h1>
        {subtitle && <p className="subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="toolbar">{actions}</div>}
    </header>
  );
}

export function Spinner({ large, label = 'Loading' }: { large?: boolean; label?: string }) {
  return <span className={`spinner${large ? ' spinner-l' : ''}`} role="progressbar" aria-label={label} />;
}

export function CenterLoading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="center-load">
      <Spinner large label={label} />
    </div>
  );
}

export function PosterSkeletons({ count = 12 }: { count?: number }) {
  return (
    <div className="poster-grid" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div key={i}>
          <div className="skeleton" style={{ aspectRatio: '2 / 3' }} />
          <div className="skeleton" style={{ height: 12, marginTop: 10, width: '70%', borderRadius: 4 }} />
        </div>
      ))}
    </div>
  );
}

export function Banner({ kind = 'info', title, children, action }: { kind?: 'info' | 'warn' | 'error' | 'success'; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  const Icon = kind === 'error' ? CircleAlert : kind === 'warn' ? AlertTriangle : kind === 'success' ? CheckCircle2 : Info;
  return (
    <div className={`banner banner-${kind}`} role={kind === 'error' ? 'alert' : undefined}>
      <Icon size={18} aria-hidden />
      <div className="banner-body">
        {title && <div className="banner-title">{title}</div>}
        {children && <div className="subhead">{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function EmptyState({ icon, title, children, actions }: { icon: ReactNode; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon" aria-hidden>
        {icon}
      </div>
      <h2 className="title-3">{title}</h2>
      {children && <p>{children}</p>}
      {actions && <div className="form-actions">{actions}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <Banner kind="error" title="This could not be loaded" action={onRetry && <button className="btn btn-small" onClick={onRetry}>Try Again</button>}>
      {error instanceof Error ? error.message : 'Something went wrong.'}
    </Banner>
  );
}

export function Time({ iso, prefix }: { iso: string | null | undefined; prefix?: string }) {
  return (
    <time dateTime={iso ?? undefined} title={dateTime(iso)}>
      {prefix}
      {relativeTime(iso)}
    </time>
  );
}

export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = options.findIndex((o) => o.value === value);
    const next = options[(i + (e.key === 'ArrowRight' ? 1 : options.length - 1)) % options.length]!;
    onChange(next.value);
    requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus());
  };
  return (
    <div className="segmented" role="radiogroup" aria-label={label} ref={ref} onKeyDown={onKey}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} tabIndex={o.value === value ? 0 : -1} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function SearchField({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder: string; label: string }) {
  return (
    <div className="search-field" role="search">
      <Search size={16} aria-hidden />
      <input className="input" type="search" value={value} placeholder={placeholder} aria-label={label} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} aria-label={label} onChange={(e) => onChange(e.target.checked)} />
      <span aria-hidden />
    </label>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null; children: (id: string, describedBy: string | undefined) => ReactNode }) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {children(id, [hintId, errId].filter(Boolean).join(' ') || undefined)}
      {hint && (
        <div className="field-hint" id={hintId}>
          {hint}
        </div>
      )}
      {error && (
        <div className="field-error" id={errId}>
          {error}
        </div>
      )}
    </div>
  );
}

/** Modal sheet built on <dialog> for native focus trapping, Escape handling and inert background. */
export function Sheet({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`sheet${wide ? ' sheet-wide' : ''}`}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <>
          <div className="sheet-head">
            <h2 className="headline" id={titleId}>
              {title}
            </h2>
            <button className="icon-btn" onClick={onClose} aria-label="Close">
              <X size={18} />
            </button>
          </div>
          <div className="sheet-body">{children}</div>
          {footer && <div className="sheet-foot">{footer}</div>}
        </>
      )}
    </dialog>
  );
}

export function ConfirmSheet({ open, title, message, confirmLabel, destructive, busy, onConfirm, onClose }: { open: boolean; title: string; message: ReactNode; confirmLabel: string; destructive?: boolean; busy?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button className="btn btn-gray" onClick={onClose}>
            Cancel
          </button>
          <button className={`btn ${destructive ? 'btn-destructive' : 'btn-primary'}`} onClick={onConfirm} disabled={busy}>
            {busy && <Spinner />}
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="secondary">{message}</div>
    </Sheet>
  );
}

export function SyncButton({ busy, onClick, label = 'Refresh', disabled }: { busy: boolean; onClick: () => void; label?: string; disabled?: boolean }) {
  return (
    <button className="btn" onClick={onClick} disabled={busy || disabled} aria-busy={busy}>
      <RefreshCw size={15} aria-hidden style={busy ? { animation: 'spin 1s linear infinite' } : undefined} />
      {busy ? 'Syncing…' : label}
    </button>
  );
}

export function ProviderMark({ provider, size = 40 }: { provider: string; size?: number }) {
  const letters: Record<string, string> = { trakt: 'T', letterboxd: 'Lb', imdb: 'IMDb', jellyfin: 'Jf', seerr: 'S', tmdb: 'TMDb' };
  return (
    <span className={`provider-mark provider-${provider}`} style={{ width: size, height: size, fontSize: size < 32 ? 10 : provider === 'imdb' || provider === 'tmdb' ? 11 : 14 }} aria-hidden>
      {letters[provider] ?? provider.slice(0, 2)}
    </span>
  );
}
