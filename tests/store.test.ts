import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store';

/**
 * 持久化测试。
 *
 * 关键回归点：仿真时钟每次启动归零，若快照不按 run 区分，
 * 多次运行的数据会在同一时间轴上重叠，回放曲线呈现假锯齿。
 */

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aquapilot-store-'));
  store = new Store(join(dir, 'test.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('持久化', () => {
  it('写入后能读出，且按 run 隔离', async () => {
    await store.open();
    if (!store.enabled) return; // Node 20 上自动降级，跳过

    store.recordSnapshot({
      runId: 'run-A', atMin: 10, effluentCod: 40, effluentNh: 0.5, effluentTn: 10,
      effluentTp: 0.2, effluentSs: 3, mlss: 3000, srtDays: 20, energyKw: 200, score: 85,
    });
    store.recordSnapshot({
      runId: 'run-A', atMin: 20, effluentCod: 41, effluentNh: 0.6, effluentTn: 10,
      effluentTp: 0.2, effluentSs: 3, mlss: 3000, srtDays: 20, energyKw: 200, score: 85,
    });
    store.recordSnapshot({
      runId: 'run-B', atMin: 10, effluentCod: 99, effluentNh: 9, effluentTn: 30,
      effluentTp: 2, effluentSs: 30, mlss: 1000, srtDays: 5, energyKw: 300, score: 20,
    });
    store.flush();

    const a = store.snapshotsBetween(0, 1000, 'run-A');
    expect(a).toHaveLength(2);
    expect(a.map((r) => r.atMin)).toEqual([10, 20]);

    const b = store.snapshotsBetween(0, 1000, 'run-B');
    expect(b).toHaveLength(1);
    expect(b[0].effluentCod).toBe(99);
  });

  it('默认只返回最近一次运行，避免时间轴重叠', async () => {
    await store.open();
    if (!store.enabled) return;

    store.recordSnapshot({
      runId: 'run-old', atMin: 10, effluentCod: 40, effluentNh: 0.5, effluentTn: 10,
      effluentTp: 0.2, effluentSs: 3, mlss: 3000, srtDays: 20, energyKw: 200, score: 85,
    });
    store.flush();
    store.recordSnapshot({
      runId: 'run-new', atMin: 10, effluentCod: 41, effluentNh: 0.6, effluentTn: 10,
      effluentTp: 0.2, effluentSs: 3, mlss: 3000, srtDays: 20, energyKw: 200, score: 85,
    });
    store.flush();

    expect(store.latestRunId()).toBe('run-new');
    const recent = store.snapshotsBetween(0, 1000);
    expect(recent).toHaveLength(1);
    expect(recent[0].runId).toBe('run-new');
  });

  it('决策记录按时间倒序返回', async () => {
    await store.open();
    if (!store.enabled) return;

    for (const at of [10, 20, 30]) {
      store.recordDecision({
        runId: 'run-A', atMin: at, action: 'adjust', severity: 'normal',
        summary: `决策 ${at}`, tweaks: '[]', predictedScore: 80, separation: 0.7,
      });
    }
    store.flush();

    const list = store.recentDecisions(10);
    expect(list).toHaveLength(3);
    expect(list[0].atMin).toBe(30);
  });

  it('未启用时不抛错，所有读取返回空', async () => {
    process.env.AQUAPILOT_PERSIST = '0';
    const disabled = new Store(join(dir, 'off.db'));
    await disabled.open();
    expect(disabled.enabled).toBe(false);
    disabled.recordDecision({
      atMin: 0, action: 'hold', severity: 'normal', summary: 'x',
      tweaks: '[]', predictedScore: 0, separation: 0,
    });
    disabled.flush();
    expect(disabled.recentDecisions()).toEqual([]);
    disabled.close();
    delete process.env.AQUAPILOT_PERSIST;
  });
});
