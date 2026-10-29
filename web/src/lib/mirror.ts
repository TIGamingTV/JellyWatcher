import { plural, relativeTime } from './format';
import type { JellyfinMirror, JellyfinMirrorMode } from './types';

/** Shared by the web app and the Jellyfin plugin's Watchlists page. */

export const MIRROR_OPTIONS: { value: 'off' | JellyfinMirrorMode; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'collection', label: 'Collection' },
  { value: 'playlist', label: 'Private Playlist' },
];

/** What the setting does, shown while it is off. */
export const MIRROR_INTRO = 'Keep this list in Jellyfin in your order, so it also shows up in apps like Infuse. Changes to the list are applied automatically.';

export const MIRROR_HINT: Record<'off' | JellyfinMirrorMode, string> = {
  off: 'Not shown in Jellyfin.',
  collection:
    'A Jellyfin collection in your order, with shows and seasons as single tiles. Everyone who can see these titles in Jellyfin sees the collection. Turning it off deletes the collection.',
  playlist: 'A playlist only you can see, in your order. Shows and seasons are added as their episodes. Turning it off deletes the playlist.',
};

export interface MirrorStatus {
  kind: 'ok' | 'busy' | 'error';
  text: string;
}

export function mirrorStatus(m: JellyfinMirror): MirrorStatus {
  const what = m.mode === 'collection' ? 'collection' : 'playlist';
  if (!m.synced) return { kind: 'busy', text: `Waiting for Jellyfin to create the ${what}. The plugin applies changes within a few minutes.` };
  if (m.error) return { kind: 'error', text: m.error };
  const parts = [`${plural(m.applied, 'item')} in the Jellyfin ${what}`];
  if (m.missing > 0) parts.push(`${plural(m.missing, 'entry', 'entries')} not in the library`);
  parts.push(`updated ${relativeTime(m.syncedAt)}`);
  return { kind: 'ok', text: parts.join(' · ') };
}
