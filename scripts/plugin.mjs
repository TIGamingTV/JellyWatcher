// Jellyfin plugin release helper.
//
//   node scripts/plugin.mjs check                 versions agree (package.json, plugin csproj, manifest)
//   node scripts/plugin.mjs pack                  builds dist/plugin/jellywatcher_<version>.zip
//   node scripts/plugin.mjs manifest <zip> <url>  adds the zip's version to jellyfin-plugin/manifest.json
//
// The plugin version is the JellyWatcher version with a fourth part: 0.5.0 → 0.5.0.0.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const at = (...p) => path.join(root, ...p);
const json = (p) => JSON.parse(readFileSync(at(p), 'utf8'));

const pkg = json('package.json');
const meta = json('jellyfin-plugin/plugin.json');
const csprojPath = 'jellyfin-plugin/src/Jellyfin.Plugin.JellyWatcher/Jellyfin.Plugin.JellyWatcher.csproj';
const manifestPath = 'jellyfin-plugin/manifest.json';

export const pluginVersion = (v = pkg.version) => `${v.split('-')[0]}.0`;
const version = pluginVersion();

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function check() {
  const csproj = readFileSync(at(csprojPath), 'utf8');
  const v = /<Version>([^<]+)<\/Version>/.exec(csproj)?.[1];
  if (v !== version) fail(`${csprojPath} has version ${v}, expected ${version} (package.json ${pkg.version}).`);
  const guid = /PluginId = Guid\.Parse\("([^"]+)"\)/.exec(readFileSync(at('jellyfin-plugin/src/Jellyfin.Plugin.JellyWatcher/Plugin.cs'), 'utf8'))?.[1];
  if (guid !== meta.guid) fail(`Plugin.cs id ${guid} does not match plugin.json ${meta.guid}.`);
  const manifest = json(manifestPath);
  if (!Array.isArray(manifest) || manifest[0]?.guid !== meta.guid || !Array.isArray(manifest[0].versions)) fail(`${manifestPath} is not a plugin repository manifest for ${meta.guid}.`);
  console.log(`Plugin version ${version} matches JellyWatcher ${pkg.version}.`);
}

async function pack() {
  check();
  const { zipSync } = await import('fflate');
  const out = at('dist/plugin');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  execFileSync('dotnet', ['publish', at('jellyfin-plugin/src/Jellyfin.Plugin.JellyWatcher'), '-c', 'Release', '-o', path.join(out, 'publish'), '-p:ContinuousIntegrationBuild=true'], { stdio: 'inherit' });
  const pluginMeta = {
    category: meta.category,
    changelog: `See https://github.com/TIGamingTV/JellyWatcher/releases/tag/v${pkg.version}`,
    description: meta.description,
    guid: meta.guid,
    name: meta.name,
    overview: meta.overview,
    owner: meta.owner,
    targetAbi: meta.targetAbi,
    timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    version,
    status: 'Active',
    autoUpdate: true,
    imagePath: 'logo.png',
    assemblies: [],
  };
  const files = {
    'Jellyfin.Plugin.JellyWatcher.dll': readFileSync(path.join(out, 'publish', 'Jellyfin.Plugin.JellyWatcher.dll')),
    'meta.json': Buffer.from(JSON.stringify(pluginMeta, null, 2)),
    'logo.png': readFileSync(at('assets/jellyfin-plugin.png')),
  };
  const zip = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, new Uint8Array(v)])), { level: 9 });
  const file = path.join(out, `jellywatcher_${version}.zip`);
  writeFileSync(file, zip);
  const md5 = createHash('md5').update(zip).digest('hex');
  writeFileSync(`${file}.md5`, `${md5}  ${path.basename(file)}\n`);
  console.log(`${path.relative(root, file)} (md5 ${md5})`);
}

function manifest(zipPath, sourceUrl) {
  if (!zipPath || !sourceUrl) fail('Usage: node scripts/plugin.mjs manifest <zip> <sourceUrl>');
  if (!existsSync(zipPath)) fail(`${zipPath} not found.`);
  // The version comes from the zip (built from the release tag), not from the checked-out package.json.
  const zipVersion = /_(\d+\.\d+\.\d+\.\d+)\.zip$/.exec(zipPath)?.[1];
  if (!zipVersion) fail(`Cannot read the plugin version from ${zipPath}.`);
  const release = zipVersion.replace(/\.0$/, '');
  const checksum = createHash('md5').update(readFileSync(zipPath)).digest('hex');
  const repo = json(manifestPath);
  const entry = repo.find((p) => p.guid === meta.guid);
  if (!entry) fail(`${manifestPath} has no entry for ${meta.guid}.`);
  Object.assign(entry, { name: meta.name, description: meta.description, overview: meta.overview, owner: meta.owner, category: meta.category, imageUrl: meta.imageUrl });
  const v = {
    version: zipVersion,
    changelog: `JellyWatcher ${release}: https://github.com/TIGamingTV/JellyWatcher/releases/tag/v${release}`,
    targetAbi: meta.targetAbi,
    sourceUrl,
    checksum,
    timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  };
  // Newest first; publishing the same version again replaces it.
  entry.versions = [v, ...entry.versions.filter((x) => x.version !== zipVersion)].sort((a, b) => cmpVersion(b.version, a.version));
  writeFileSync(at(manifestPath), `${JSON.stringify(repo, null, 2)}\n`);
  console.log(`${manifestPath}: ${zipVersion} → ${sourceUrl} (md5 ${checksum})`);
}

function cmpVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 4; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'check') check();
else if (cmd === 'pack') await pack();
else if (cmd === 'manifest') manifest(args[0] && path.resolve(args[0]), args[1]);
else fail('Usage: node scripts/plugin.mjs check | pack | manifest <zip> <sourceUrl>');
