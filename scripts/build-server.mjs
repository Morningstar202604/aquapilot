import { build } from 'esbuild';

await build({
  entryPoints: ['src/server/index.ts'],
  outfile: 'dist/server/index.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
});
console.log('server bundled -> dist/server/index.mjs');

// CLI（npm bin / node dist/cli.mjs）：依赖 node_modules 里的 ws
await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
});
console.log('cli bundled -> dist/cli.mjs');

// CLI 单文件版（Node SEA exe 入口）：CJS + 全量内联（ws 一并打入，
// 不依赖 node_modules），动态 import 的服务端同捆，serve 时才启动
await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli-sea.cjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  packages: undefined,
  legalComments: 'none',
});
console.log('cli bundled (SEA, single file) -> dist/cli-sea.cjs');
