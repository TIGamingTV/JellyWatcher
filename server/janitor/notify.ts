import type { AppContext } from '../context.js';
import { errorMessage } from '../http/errors.js';
import { scrub } from '../logger.js';

/** Notifications to the administrator through Home Assistant. Failures never stop a cleanup. */

export function janitorLink(ctx: AppContext): string | null {
  return ctx.config.publicUrl ? new URL('/janitor', ctx.config.publicUrl).toString() : null;
}

export function formatBytes(n: number | null | undefined): string {
  if (!n || n <= 0) return 'unknown size';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return 'soon';
  return new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export interface TemplateVars {
  title: string;
  season: number;
  requester: string;
  date: string | null;
  size: number | null;
  rule: string;
}

/** Fills {title}, {season}, {unit}, {requester}, {date}, {size} and {rule}. */
export function renderTemplate(template: string, v: TemplateVars): string {
  const unit = v.season >= 0 ? `${v.title} · Season ${v.season}` : v.title;
  const values: Record<string, string> = {
    title: unit,
    show: v.title,
    unit,
    season: v.season >= 0 ? String(v.season) : '',
    requester: v.requester || 'someone',
    date: formatDate(v.date),
    size: formatBytes(v.size),
    rule: v.rule,
  };
  return template.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);
}

export async function notifyAdmin(ctx: AppContext, title: string, message: string): Promise<{ ok: boolean; error?: string }> {
  const ha = ctx.integrations.homeAssistant();
  if (!ha) return { ok: false, error: 'Home Assistant is not connected.' };
  try {
    await ha.notify({ title, message, url: janitorLink(ctx) });
    return { ok: true };
  } catch (err) {
    const error = scrub(errorMessage(err)).slice(0, 300);
    ctx.log.warn({ err: error }, 'janitor notification failed');
    return { ok: false, error };
  }
}
