import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

/** Small building blocks styled after Jellyfin (Material icons, theme colours). */

export function Icon({ name, size }: { name: string; size?: number }) {
  return (
    <span class="material-icons jw-icon" aria-hidden="true" style={size ? { fontSize: `${size}px` } : undefined}>
      {name}
    </span>
  );
}

export function Spinner() {
  return <span class="jw-spinner" aria-hidden="true" />;
}

export function Banner({ kind, title, children, action }: { kind: 'info' | 'warn' | 'error' | 'success'; title?: string; children?: ComponentChildren; action?: ComponentChildren }) {
  return (
    <div class={`jw-banner jw-banner-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <div class="jw-banner-body">
        {title && <div class="jw-banner-title">{title}</div>}
        {children}
      </div>
      {action}
    </div>
  );
}

/** A modal dialog over Jellyfin (Escape and the backdrop close it). */
export function Dialog({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ComponentChildren; footer?: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, button:not(.jw-dialog-close), select, textarea');
    (first ?? ref.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      previous?.focus?.();
    };
  }, []);
  return (
    <div class="jw-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="jw-dialog" role="dialog" aria-modal="true" aria-label={title} ref={ref} tabIndex={-1}>
        <div class="jw-dialog-head">
          <h2>{title}</h2>
          <button class="jw-icon-btn jw-dialog-close" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <div class="jw-dialog-body">{children}</div>
        {footer && <div class="jw-dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}

export interface ToastMsg {
  id: number;
  kind: 'success' | 'error' | 'info';
  text: string;
  action?: { label: string; run: () => void };
}

let nextToast = 1;

/** Short messages at the bottom of the page, some with an Undo button. */
export function useToasts() {
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const push = (kind: ToastMsg['kind'], text: string, action?: ToastMsg['action']) => {
    const id = nextToast++;
    setToasts((t) => [...t.slice(-2), { id, kind, text, action }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), action ? 6000 : 3500);
  };
  const dismiss = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));
  return { toasts, push, dismiss };
}

export type Toast = ReturnType<typeof useToasts>['push'];

export function Toasts({ toasts, dismiss }: { toasts: ToastMsg[]; dismiss: (id: number) => void }) {
  return (
    <div class="jw-toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} class={`jw-toast jw-toast-${t.kind}`}>
          <span>{t.text}</span>
          {t.action && (
            <button
              class="jw-link-btn"
              onClick={() => {
                dismiss(t.id);
                t.action!.run();
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export function Progress({ pct, large }: { pct: number; large?: boolean }) {
  return (
    <div class={`jw-progress${large ? ' jw-progress-lg' : ''}`} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

export function Poster({ src, alt }: { src: string | null; alt: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div class="jw-thumb">
      {src && !failed ? <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} /> : <span class="jw-thumb-fallback">{alt.slice(0, 24)}</span>}
    </div>
  );
}
