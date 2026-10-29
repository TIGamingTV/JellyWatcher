import { useEffect, useRef, useState } from 'react';
import { Smartphone } from 'lucide-react';
import { errorText } from '../lib/api';
import type { QuickConnectStart } from '../lib/types';
import { Banner, Spinner } from './ui';

type PollResult = { status: 'pending' | 'approved' | 'expired' | 'authorized' } & Record<string, unknown>;

/**
 * Jellyfin Quick Connect: shows a code that the person approves in any Jellyfin app they are
 * already signed in to (Settings › Quick Connect), then polls until it is approved.
 */
export function QuickConnectPanel({
  start,
  poll,
  onAuthorized,
  onCancel,
  serverName,
}: {
  start: () => Promise<QuickConnectStart>;
  poll: (id: string) => Promise<PollResult>;
  onAuthorized: (result: PollResult) => void | Promise<void>;
  onCancel: () => void;
  serverName?: string | null;
}) {
  const [req, setReq] = useState<QuickConnectStart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [left, setLeft] = useState<number | null>(null);
  const done = useRef(false);
  // Keep the latest callbacks without restarting the polling loop.
  const cb = useRef({ poll, onAuthorized });
  cb.current = { poll, onAuthorized };

  const begin = async () => {
    setError(null);
    setExpired(false);
    setReq(null);
    try {
      setReq(await start());
    } catch (err) {
      setError(errorText(err));
    }
  };

  useEffect(() => {
    void begin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!req || expired) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stopped || done.current) return;
      try {
        const r = await cb.current.poll(req.id);
        if (stopped) return;
        if (r.status === 'authorized') {
          done.current = true;
          await cb.current.onAuthorized(r);
          return;
        }
        if (r.status === 'expired') {
          setExpired(true);
          return;
        }
      } catch (err) {
        if (stopped) return;
        setError(errorText(err));
        return;
      }
      timer = setTimeout(tick, Math.max(1, req.interval) * 1000);
    };
    timer = setTimeout(tick, Math.max(1, req.interval) * 1000);
    const clock = setInterval(() => {
      const s = Math.max(0, Math.round((Date.parse(req.expiresAt) - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) setExpired(true);
    }, 1000);
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(clock);
    };
  }, [req, expired]);

  return (
    <div className="stack" aria-live="polite">
      {error && <Banner kind="error">{error}</Banner>}
      {!req && !error && (
        <div className="inline secondary">
          <Spinner /> Asking Jellyfin for a code…
        </div>
      )}
      {req && !expired && (
        <>
          <p className="secondary subhead" style={{ margin: 0 }}>
            Open Jellyfin on a phone, TV or browser where you are already signed in{serverName ? ` to ${serverName}` : ''}, go to <strong>Settings › Quick Connect</strong> and enter this code:
          </p>
          <div className="code-box" aria-label={`Quick Connect code ${req.code.split('').join(' ')}`}>
            {req.code}
          </div>
          <div className="inline secondary footnote" style={{ justifyContent: 'center' }}>
            <Spinner label="Waiting for approval" /> Waiting for approval{left !== null && left < 120 ? ` · expires in ${left} s` : ''}
          </div>
        </>
      )}
      {expired && (
        <Banner kind="warn" title="The code expired" action={<button className="btn btn-small" onClick={() => void begin()}>New Code</button>}>
          Quick Connect codes are valid for a few minutes.
        </Banner>
      )}
      <button className="btn btn-gray btn-large" type="button" onClick={onCancel} style={{ width: '100%' }}>
        Cancel
      </button>
    </div>
  );
}

export function QuickConnectButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button className="btn btn-gray btn-large" type="button" onClick={onClick} disabled={disabled} style={{ width: '100%' }}>
      <Smartphone size={17} aria-hidden /> Use Quick Connect
    </button>
  );
}
