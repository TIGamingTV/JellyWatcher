import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, AlertCircle } from 'lucide-react';
import { get, setCsrfToken } from './api';
import type { Me } from './types';

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const me = await get<Me>('/auth/me');
      setCsrfToken(me.csrfToken);
      return me;
    },
    staleTime: 60_000,
  });
}

/** Signed-in user; only call inside the authenticated shell. */
export function useUser() {
  const { data } = useMe();
  if (!data?.user) throw new Error('useUser outside of an authenticated area');
  return { user: data.user, services: data.services!, sources: data.sources ?? [], isAdmin: data.user.role === 'admin', version: data.version };
}

export function useAppearance(pref: 'system' | 'light' | 'dark' | undefined) {
  useEffect(() => {
    const root = document.documentElement;
    if (!pref || pref === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', pref);
  }, [pref]);
}

export function useRefreshMe() {
  const qc = useQueryClient();
  return useCallback(() => qc.invalidateQueries({ queryKey: ['me'] }), [qc]);
}

// ---- Toasts --------------------------------------------------------------------------------
interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info';
  text: string;
}
const ToastCtx = createContext<(kind: Toast['kind'], text: string) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 4000);
  }, []);
  const value = useMemo(() => push, [push]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.kind === 'error' ? <AlertCircle size={18} aria-hidden /> : <CheckCircle2 size={18} aria-hidden />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);
