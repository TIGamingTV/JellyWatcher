// Bundles the Jellyfin plugin's Watchlists page (jellyfin-plugin/client) into one script that the
// plugin embeds. Runs before every `dotnet build` of the plugin.
import { build } from 'esbuild';

const outfile = 'jellyfin-plugin/src/Jellyfin.Plugin.JellyWatcher/Web/client.js';

await build({
  entryPoints: ['jellyfin-plugin/client/main.tsx'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  // jellyfin-web 12 supports these browsers too.
  target: ['chrome100', 'firefox100', 'safari15'],
  outfile,
  minify: true,
  legalComments: 'none',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  loader: { '.css': 'text' },
  banner: { js: '/* JellyWatcher for Jellyfin: Watchlists page. https://github.com/TIGamingTV/JellyWatcher (GPL-3.0-or-later) */' },
  logLevel: 'warning',
});
console.log(`Plugin client written to ${outfile}`);
