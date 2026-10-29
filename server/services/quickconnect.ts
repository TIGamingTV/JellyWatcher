import { randomToken } from '../security/crypto.js';

/**
 * Pending Jellyfin Quick Connect requests. The Jellyfin secret never leaves the server: the browser
 * only gets an opaque id and the code to approve. Requests expire with Jellyfin's own 10 minutes.
 */

export type QuickConnectPurpose = 'login' | 'setup' | 'link';

export interface PendingQuickConnect {
  id: string;
  purpose: QuickConnectPurpose;
  /** Jellyfin server the request was started on (setup has no saved integration yet). */
  url: string;
  secret: string;
  code: string;
  deviceId: string;
  /** Signed-in person for 'link'. */
  userId: number | null;
  expiresAt: number;
}

const TTL_MS = 10 * 60_000;
const MAX_PENDING = 500;
export const QUICK_CONNECT_POLL_MS = 2000;

export class QuickConnectStore {
  private readonly pending = new Map<string, PendingQuickConnect>();

  add(p: Omit<PendingQuickConnect, 'id' | 'expiresAt'>): PendingQuickConnect {
    this.prune();
    if (this.pending.size >= MAX_PENDING) {
      const oldest = [...this.pending.values()].sort((a, b) => a.expiresAt - b.expiresAt)[0];
      if (oldest) this.pending.delete(oldest.id);
    }
    const entry: PendingQuickConnect = { ...p, id: randomToken(24), expiresAt: Date.now() + TTL_MS };
    this.pending.set(entry.id, entry);
    return entry;
  }

  /** The pending request if it exists, has not expired and was started for this purpose (and person). */
  get(id: string, purpose: QuickConnectPurpose, userId: number | null = null): PendingQuickConnect | null {
    const p = this.pending.get(id);
    if (!p) return null;
    if (p.expiresAt < Date.now()) {
      this.pending.delete(id);
      return null;
    }
    if (p.purpose !== purpose || (purpose === 'link' && p.userId !== userId)) return null;
    return p;
  }

  delete(id: string): void {
    this.pending.delete(id);
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, p] of this.pending) if (p.expiresAt < now) this.pending.delete(id);
  }
}
