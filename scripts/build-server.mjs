// Bundles the server into dist/server. Native and large runtime deps stay external
// and are installed from package.json in the production image.
import { build } from 'esbuild';
import { cp, mkdir, readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

await build({
  entryPoints: ['server/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/server/index.js',
  sourcemap: true,
  external: Object.keys(pkg.dependencies ?? {}),
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'info',
});

await mkdir('dist/server/migrations', { recursive: true });
await cp('server/db/migrations', 'dist/server/migrations', { recursive: true });
console.log('Server bundle written to dist/server');
