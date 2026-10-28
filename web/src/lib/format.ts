const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const dtf = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const df = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'unknown';
  const diff = (t - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  return df.format(t);
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '—' : dtf.format(t);
}

export function date(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : df.format(t);
}

export function runtime(minutes: number | null | undefined): string | null {
  if (!minutes) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} hr ${m ? `${m} min` : ''}`.trim() : `${m} min`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export const PROVIDER_NAME: Record<string, string> = {
  trakt: 'Trakt',
  letterboxd: 'Letterboxd',
  imdb: 'IMDb',
  jellyfin: 'Jellyfin',
  seerr: 'Seerr',
  tmdb: 'TMDb',
};

export const LIST_KIND_LABEL: Record<string, string> = {
  watchlist: 'Watchlist',
  owned: 'Your list',
  liked: 'Liked list',
  public: 'Public list',
  upload: 'Imported file',
  diary: 'Diary (RSS)',
};
