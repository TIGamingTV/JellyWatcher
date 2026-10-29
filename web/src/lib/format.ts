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

/** Long durations for watch-time totals: "52 h 10 min", "3 d 4 h" past 72 hours. */
export function duration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h >= 72) {
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return rh ? `${d} d ${rh} h` : `${d} d`;
  }
  const rm = m % 60;
  return rm ? `${h} h ${rm} min` : `${h} h`;
}

/** "S01E03", "Season 2" for season/episode entries. */
export function episodeCode(season: number | null, episode: number | null): string | null {
  if (season === null) return null;
  if (episode === null) return season === 0 ? 'Specials' : `Season ${season}`;
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

/** What a source's season name adds beyond "<show> Season N", e.g. "Part 2"; null when nothing. */
export function seasonName(name: string | null, show: string, season: number | null): string | null {
  if (!name) return null;
  let rest = name.trim();
  if (rest.toLowerCase().startsWith(show.toLowerCase())) rest = rest.slice(show.length);
  rest = rest.replace(new RegExp(`^[\\s:–-]*(season\\s*${season ?? ''}|s${season ?? ''})\\b`, 'i'), '').replace(/^[\s:–-]+/, '').trim();
  return rest || null;
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
  myanimelist: 'MyAnimeList',
  anilist: 'AniList',
  simkl: 'Simkl',
  mdblist: 'MDBList',
  local: 'JellyWatcher',
};

export const LIST_KIND_LABEL: Record<string, string> = {
  watchlist: 'Watchlist',
  owned: 'Your list',
  liked: 'Liked list',
  public: 'Public list',
  upload: 'Imported file',
  diary: 'Diary (RSS)',
  local: 'Your list',
};

/** Greeting for the hour of the day on this device. Around midday it is simply "Good Day". */
export function greeting(hour: number = new Date().getHours()): string {
  if (hour >= 5 && hour < 11) return 'Good Morning';
  if (hour >= 11 && hour < 14) return 'Good Day';
  if (hour >= 14 && hour < 18) return 'Good Afternoon';
  return 'Good Evening';
}

/** Today's date as YYYY-MM-DD in local time, for date inputs. */
export function todayInput(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A date input value as an ISO time: now for today, local noon for other days. */
export function watchedAtFromInput(value: string): string {
  if (!value || value === todayInput()) return new Date().toISOString();
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 12, 0, 0).toISOString();
}
