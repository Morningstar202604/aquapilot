/**
 * Node SEA（Single Executable Application）打包：产出独立 aquapilot.exe。
 *
 * 流程（https://nodejs.org/api/single-executable-applications.html）：
 *  1. esbuild 把 CLI 打成单文件 CJS（scripts/build-server.mjs 第三段）
 *  2. node --experimental-sea-config 生成注入 blob
 *  3. 复制 node.exe → aquapilot.exe
 *  4. postject 把 blob 以 NODE_SEA_BLOB 资源注入 exe
 *
 * 产物：dist/aquapilot.exe —— 无需 Node 环境，双击/命令行皆可：
 *   aquapilot.exe simulate --days 7
 *   aquapilot.exe serve --port 8080     （Web UI + WS + MCP 全功能）
 */
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function run(cmd, label) {
  console.log(`▶ ${label}`);
  execSync(cmd, { stdio: 'inherit', cwd: root });
}

const exe = 'dist/aquapilot.exe';
rmSync(exe, { force: true });

run('node --experimental-sea-config scripts/sea-config.json', '1/4 生成 SEA 注入 blob');

const nodeExe = process.execPath;
copyFileSync(nodeExe, exe);
console.log(`2/4 复制运行时 ${nodeExe} -> ${exe}`);

// postject 是 Node 官方 SEA 文档指定的注入器
run(
  'npx --yes postject dist/aquapilot.exe NODE_SEA_BLOB dist/sea-prep.blob ' +
    '--sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  '3/4 注入 blob（postject）',
);

if (!existsSync(exe)) {
  console.error('✗ aquapilot.exe 未生成');
  process.exit(1);
}
console.log(`4/4 完成 -> dist/aquapilot.exe`);
console.log('\n验证：dist\\aquapilot.exe simulate --days 1');
