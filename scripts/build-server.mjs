import { build } from 'esbuild';

await build({
  entryPoints: ['src/server/index.ts'],
  outfile: 'dist/server/index.mjs',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
});
console.log('server bundled -> dist/server/index.mjs');
