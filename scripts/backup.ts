/**
 * 备份 / 恢复命令行。
 *
 * 用法：
 *   node scripts/backup.mjs create [--db data/aquapilot.db] [--out backups/aquapilot-<ts>.db]
 *   node scripts/backup.mjs restore --from backups/xxx.db [--db data/aquapilot.db] [--yes]
 *   node scripts/backup.mjs list [--dir backups]
 *
 * 恢复是破坏性操作：不带 --yes 时只做预检并打印将要做的事，不落盘。
 * 服务在运行时不要在同一个库上恢复——先停服务。
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store } from '../src/server/store';

interface Args {
  _: string[];
  db?: string;
  out?: string;
  from?: string;
  dir?: string;
  yes?: boolean;
  [key: string]: unknown;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2) as keyof Args;
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
const dbPath = resolve(args.db ?? process.env.AQUAPILOT_DB ?? 'data/aquapilot.db');

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function create() {
  const out = resolve(args.out ?? join('backups', `aquapilot-${stamp()}.db`));
  if (!existsSync(dbPath)) {
    console.error(`数据库不存在：${dbPath}`);
    process.exit(1);
  }
  const store = new Store(dbPath);
  await store.open();
  if (!store.enabled) {
    console.error('持久化不可用（Node 版本过低或 AQUAPILOT_PERSIST=0）');
    process.exit(1);
  }
  const manifest = store.backupTo(out);
  store.close();
  console.log(JSON.stringify({ ok: true, backup: out, ...manifest }, null, 2));
}

async function restore() {
  const from = args.from;
  if (!from) {
    console.error('缺少 --from <备份文件>');
    process.exit(1);
  }
  const source = resolve(from);
  if (!existsSync(source)) {
    console.error(`备份不存在：${source}`);
    process.exit(1);
  }
  if (!args.yes) {
    console.log(
      [
        '预检通过（未写入任何文件）。',
        `将用 ${source}`,
        `覆盖 ${dbPath}`,
        '这是破坏性操作。确认请加 --yes，并确保服务已停止。',
      ].join('\n'),
    );
    return;
  }
  const result = await Store.restoreFrom(source, dbPath);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

function list() {
  const dir = resolve(args.dir ?? 'backups');
  if (!existsSync(dir)) {
    console.log(`备份目录不存在：${dir}`);
    return;
  }
  const rows = readdirSync(dir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => {
      const full = join(dir, f);
      const s = statSync(full);
      return { file: full, bytes: s.size, modified: s.mtime.toISOString() };
    })
    .sort((a, b) => b.modified.localeCompare(a.modified));
  if (!rows.length) console.log('没有备份文件。');
  for (const r of rows) console.log(`${r.modified}  ${String(r.bytes).padStart(10)}  ${r.file}`);
}

async function main() {
  if (command === 'create') return create();
  if (command === 'restore') return restore();
  if (command === 'list') return list();
  console.error('用法：backup.mjs create|restore|list [--db ...] [--out ...] [--from ...] [--yes]');
  process.exit(1);
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
