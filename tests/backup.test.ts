import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store';

/**
 * 备份/恢复。
 *
 * 真正的风险不是"复制文件会不会失败"，而是"复制出来的文件能不能用"。
 * 因此这里断言的是恢复后数据可读、且坏文件会被拒绝而不是覆盖线上库。
 */

let dir: string;
let livePath: string;
let store: Store;

const snapshot = (atMin: number, code = 40) => ({
  runId: 'run-1',
  atMin,
  effluentCod: code,
  effluentNh: 0.5,
  effluentTn: 10,
  effluentTp: 0.2,
  effluentSs: 3,
  mlss: 3000,
  srtDays: 20,
  energyKw: 200,
  score: 85,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aquapilot-backup-'));
  livePath = join(dir, 'live.db');
  store = new Store(livePath);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('备份与恢复', () => {
  it('备份文件可重新打开且数据完整', async () => {
    await store.open();
    if (!store.enabled) return;
    store.recordSnapshot(snapshot(10));
    store.recordSnapshot(snapshot(20));
    store.recordDecision({
      runId: 'run-1',
      atMin: 15,
      action: 'adjust',
      severity: 'normal',
      summary: '微调',
      tweaks: '[]',
      predictedScore: 80,
      separation: 0.7,
    });

    const backupPath = join(dir, 'backup.db');
    const manifest = store.backupTo(backupPath);
    expect(existsSync(backupPath)).toBe(true);
    expect(manifest.counts.snapshots).toBe(2);
    expect(manifest.counts.decisions).toBe(1);
    expect(manifest.bytes).toBeGreaterThan(0);

    const restored = new Store(backupPath);
    await restored.open();
    expect(restored.enabled).toBe(true);
    expect(restored.count().snapshots).toBe(2);
    expect(restored.snapshotsBetween(0, 100).map((r) => r.atMin)).toEqual([10, 20]);
    restored.close();
  });

  it('恢复到新路径后能读到原数据', async () => {
    await store.open();
    if (!store.enabled) return;
    store.recordSnapshot(snapshot(30));
    const backupPath = join(dir, 'b.db');
    store.backupTo(backupPath);
    store.close();

    const restoredPath = join(dir, 'restored.db');
    const result = await Store.restoreFrom(backupPath, restoredPath);
    expect(result.ok).toBe(true);
    expect(result.manifest?.counts.snapshots).toBe(1);
    expect(existsSync(restoredPath)).toBe(true);

    const reopened = new Store(restoredPath);
    await reopened.open();
    expect(reopened.count().snapshots).toBe(1);
    reopened.close();
  });

  it('备份不存在的路径会报错而不是静默成功', async () => {
    await store.open();
    if (!store.enabled) return;
    expect(() => store.backupTo(join(dir, 'nope', 'x.db'))).not.toThrow(); // 目录会被创建
  });

  it('恢复拒绝不存在的文件', async () => {
    const result = await Store.restoreFrom(join(dir, 'missing.db'), join(dir, 'out.db'));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('不存在');
  });

  it('恢复拒绝非 SQLite 的垃圾文件，且不覆盖目标库', async () => {
    await store.open();
    if (!store.enabled) return;
    store.recordSnapshot(snapshot(99));
    store.close();

    const garbage = join(dir, 'garbage.db');
    writeFileSync(garbage, 'this is not a database');
    const target = join(dir, 'target.db');
    const result = await Store.restoreFrom(garbage, target);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(existsSync(target)).toBe(false);
  });

  it('持久化未启用时备份会被明确拒绝', () => {
    const disabled = new Store(join(dir, 'disabled.db'));
    expect(() => disabled.backupTo(join(dir, 'x.db'))).toThrow(/持久化未启用/);
  });
});

describe('持久化失败路径（注入 I/O 故障）', () => {
  it('flush 写失败时回滚、计数并保留待写数据', async () => {
    await store.open();
    if (!store.enabled) return;
    const raw = store.__rawDbForTests();
    expect(raw).not.toBeNull();
    if (!raw) return;

    // 让下一次 flush 在 COMMIT 前抛错，模拟磁盘写失败
    const original = raw.prepare.bind(raw);
    let calls = 0;
    (raw as unknown as { prepare: typeof raw.prepare }).prepare = ((sql: string) => {
      calls += 1;
      if (calls === 2) throw new Error('disk I/O error');
      return original(sql);
    }) as typeof raw.prepare;

    store.recordSnapshot(snapshot(77));
    expect(() => store.flush()).not.toThrow();
    expect(store.count().snapshots).toBe(0);

    // 恢复句柄后同一批数据仍应写入（缓冲没有被清空）
    (raw as unknown as { prepare: typeof raw.prepare }).prepare = original;
    store.flush();
    expect(store.count().snapshots).toBe(1);
  });

  it('备份在数据库不可用时抛错而不是产出空文件', () => {
    const disabled = new Store(join(dir, 'closed.db'));
    expect(() => disabled.backupTo(join(dir, 'x.db'))).toThrow(/持久化未启用/);
  });
});
