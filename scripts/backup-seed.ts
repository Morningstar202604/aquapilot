/**
 * CI 辅助：给备份往返测试造数 / 校验行数。
 *
 * 单独成文件而不是塞进 workflow 的 node -e：
 * 内联脚本里的引号在 YAML 里极易被吃掉，且无法本地复现。
 */
import { Store } from '../src/server/store';

const path = process.argv[2];
const verifyIndex = process.argv.indexOf('--verify');
const expected = verifyIndex > 0 ? Number(process.argv[verifyIndex + 1]) : null;

const store = new Store(path);
await store.open();

if (!store.enabled) {
  console.error('persistence unavailable on this Node version');
  process.exit(1);
}

if (expected === null) {
  for (let i = 0; i < 5; i++) {
    store.recordSnapshot({
      runId: 'ci',
      atMin: i,
      effluentCod: 40,
      effluentNh: 0.5,
      effluentTn: 10,
      effluentTp: 0.2,
      effluentSs: 3,
      mlss: 3000,
      srtDays: 20,
      energyKw: 200,
      score: 85,
    });
  }
  store.flush();
  store.close();
  console.log('seeded 5 snapshots into', path);
} else {
  const n = store.count().snapshots;
  store.close();
  if (n !== expected) {
    console.error(`expected ${expected} snapshots, found ${n}`);
    process.exit(1);
  }
  console.log(`verified ${n} snapshots in`, path);
}
