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
  /**
   * 环境变量必须无条件复位。
   *
   * 之前两个用例会临时把 AQUAPILOT_PERSIST 设为 '0' 并在用例末尾 delete；
   * 一旦断言提前失败，delete 就执行不到，后面所有用例都会在"持久化关闭"
   * 状态下运行——表现为一串莫名其妙的 "node:sqlite 不可用"。
   * 本例曾真实踩到：count() 形状变更让前一个用例失败，后续 3 个用例连带失败。
   */
  delete process.env.AQUAPILOT_PERSIST;
});

describe('持久化', () => {
  it('写入后能读出，且按 run 隔离', async () => {
    await store.open();
    /**
     * Node >= 22.12 是本仓库声明的下限（package.json engines），node:sqlite
     * 自 Node 22.5 起内置，因此持久化在这里**必须**可用。旧写法
     * `if (!store.enabled) return;` 会把"SQLite 打不开"这个真实故障
     * 静默变成 9 个跳过的用例——测试全绿但什么都没验证。
     * 现在硬断言：持久化层坏了就让测试红，而不是假绿。
     */
    if (!store.enabled) throw new Error('node:sqlite 不可用：持久化层故障，测试无法继续');

    store.recordSnapshot({
      runId: 'run-A',
      atMin: 10,
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
    store.recordSnapshot({
      runId: 'run-A',
      atMin: 20,
      effluentCod: 41,
      effluentNh: 0.6,
      effluentTn: 10,
      effluentTp: 0.2,
      effluentSs: 3,
      mlss: 3000,
      srtDays: 20,
      energyKw: 200,
      score: 85,
    });
    store.recordSnapshot({
      runId: 'run-B',
      atMin: 10,
      effluentCod: 99,
      effluentNh: 9,
      effluentTn: 30,
      effluentTp: 2,
      effluentSs: 30,
      mlss: 1000,
      srtDays: 5,
      energyKw: 300,
      score: 20,
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
    /**
     * Node >= 22.12 是本仓库声明的下限（package.json engines），node:sqlite
     * 自 Node 22.5 起内置，因此持久化在这里**必须**可用。旧写法
     * `if (!store.enabled) return;` 会把"SQLite 打不开"这个真实故障
     * 静默变成 9 个跳过的用例——测试全绿但什么都没验证。
     * 现在硬断言：持久化层坏了就让测试红，而不是假绿。
     */
    if (!store.enabled) throw new Error('node:sqlite 不可用：持久化层故障，测试无法继续');

    store.recordSnapshot({
      runId: 'run-old',
      atMin: 10,
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
    store.flush();
    store.recordSnapshot({
      runId: 'run-new',
      atMin: 10,
      effluentCod: 41,
      effluentNh: 0.6,
      effluentTn: 10,
      effluentTp: 0.2,
      effluentSs: 3,
      mlss: 3000,
      srtDays: 20,
      energyKw: 200,
      score: 85,
    });
    store.flush();

    expect(store.latestRunId()).toBe('run-new');
    const recent = store.snapshotsBetween(0, 1000);
    expect(recent).toHaveLength(1);
    expect(recent[0].runId).toBe('run-new');
  });

  it('决策记录按时间倒序返回', async () => {
    await store.open();
    /**
     * Node >= 22.12 是本仓库声明的下限（package.json engines），node:sqlite
     * 自 Node 22.5 起内置，因此持久化在这里**必须**可用。旧写法
     * `if (!store.enabled) return;` 会把"SQLite 打不开"这个真实故障
     * 静默变成 9 个跳过的用例——测试全绿但什么都没验证。
     * 现在硬断言：持久化层坏了就让测试红，而不是假绿。
     */
    if (!store.enabled) throw new Error('node:sqlite 不可用：持久化层故障，测试无法继续');

    for (const at of [10, 20, 30]) {
      store.recordDecision({
        runId: 'run-A',
        atMin: at,
        action: 'adjust',
        severity: 'normal',
        summary: `决策 ${at}`,
        tweaks: '[]',
        predictedScore: 80,
        separation: 0.7,
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
      atMin: 0,
      action: 'hold',
      severity: 'normal',
      summary: 'x',
      tweaks: '[]',
      predictedScore: 0,
      separation: 0,
    });
    disabled.flush();
    expect(disabled.recentDecisions()).toEqual([]);
    disabled.close();
    delete process.env.AQUAPILOT_PERSIST;
  });
});

describe('未启用持久化时的全部读取路径', () => {
  it('所有查询都安全返回空值', async () => {
    process.env.AQUAPILOT_PERSIST = '0';
    const s = new Store(join(dir, 'off2.db'));
    await s.open();
    expect(s.enabled).toBe(false);
    expect(s.recentDecisions()).toEqual([]);
    expect(s.snapshotsBetween(0, 100)).toEqual([]);
    expect(s.latestRunId()).toBeNull();
    expect(s.listRuns()).toEqual([]);
    expect(s.count()).toEqual({ decisions: 0, alarms: 0, snapshots: 0, reviews: 0 });
    s.recordAlarm({ id: 'a1', atMin: 1, severity: 'warning', code: 'X', message: 'm' });
    s.flush();
    expect(s.count().alarms).toBe(0);
    s.close();
    delete process.env.AQUAPILOT_PERSIST;
  });
});

describe('store 的错误恢复路径', () => {
  it('表名互换后迁移可重复执行（ALTER 已存在不抛）', async () => {
    const s1 = new Store(join(dir, 'repeat.db'));
    await s1.open();
    if (!s1.enabled) return;
    s1.close();
    // 二次 open 会重复执行 ALTER，必须被 catch 吞掉而不是崩溃
    const s2 = new Store(join(dir, 'repeat.db'));
    await s2.open();
    expect(s2.enabled).toBe(true);
    s2.close();
  });

  it('同一目录两个实例并存不崩溃', async () => {
    const a = new Store(join(dir, 'shared.db'));
    const b = new Store(join(dir, 'shared.db'));
    await a.open();
    await b.open();
    if (a.enabled && b.enabled) {
      a.recordDecision({
        runId: 'r',
        atMin: 1,
        action: 'hold',
        severity: 'normal',
        summary: 'x',
        tweaks: '[]',
        predictedScore: 1,
        separation: 0.5,
      });
      a.flush();
      expect(a.count().decisions).toBeGreaterThan(0);
    }
    a.close();
    b.close();
  });

  it('flush 在无数据时是空操作', async () => {
    const s = new Store(join(dir, 'empty.db'));
    await s.open();
    expect(() => s.flush()).not.toThrow();
    s.close();
  });

  it('listRuns 返回按时间聚合的运行列表', async () => {
    const s = new Store(join(dir, 'runs.db'));
    await s.open();
    if (!s.enabled) return;
    for (const [runId, atMin] of [
      ['r1', 10],
      ['r1', 20],
      ['r2', 5],
    ] as const) {
      s.recordSnapshot({
        runId,
        atMin,
        effluentCod: 30,
        effluentNh: 0.5,
        effluentTn: 10,
        effluentTp: 0.2,
        effluentSs: 3,
        mlss: 3000,
        srtDays: 20,
        energyKw: 200,
        score: 80,
      });
    }
    s.flush();
    const runs = s.listRuns();
    expect(runs.length).toBe(2);
    const r1 = runs.find((r) => r.runId === 'r1')!;
    expect(r1.points).toBe(2);
    expect(r1.fromMin).toBe(10);
    expect(r1.toMin).toBe(20);
    s.close();
  });
});

describe('告警持久化', () => {
  it('告警按 run 隔离并能读出（此前 recordAlarm 从未被调用，表永远为空）', async () => {
    await store.open();
    /**
     * Node >= 22.12 是本仓库声明的下限（package.json engines），node:sqlite
     * 自 Node 22.5 起内置，因此持久化在这里**必须**可用。旧写法
     * `if (!store.enabled) return;` 会把"SQLite 打不开"这个真实故障
     * 静默变成 9 个跳过的用例——测试全绿但什么都没验证。
     * 现在硬断言：持久化层坏了就让测试红，而不是假绿。
     */
    if (!store.enabled) throw new Error('node:sqlite 不可用：持久化层故障，测试无法继续');
    store.recordAlarm({ runId: 'run-A', id: 'A1', atMin: 10, severity: 'warning', code: 'DO_LOW', message: '低氧' });
    store.recordAlarm({
      runId: 'run-B',
      id: 'A2',
      atMin: 20,
      severity: 'critical',
      code: 'EFF_NH',
      message: '氨氮超标',
    });
    store.flush();
    const a = store.recentAlarms(10, 'run-A');
    expect(a).toHaveLength(1);
    expect(a[0].code).toBe('DO_LOW');
    expect(a[0].runId).toBe('run-A');
    expect(store.count().alarms).toBe(2);
  });
});

describe('人工裁决审计', () => {
  /**
   * 「采纳」与「拒绝」必须同等留痕。
   *
   * 这是对标 waterworks-ai 的审计设计后补的：它把 approve 与 deny
   * 以同等保真度写入审计日志。本项目此前只有 AI 侧 decisions，
   * 人的处置完全不留痕——复盘时无法区分「人拒绝了」与「消息丢了」。
   */
  it('approve/reject/auto 三类裁决都能落库并按 run 隔离', async () => {
    await store.open();
    if (!store.enabled) throw new Error('node:sqlite 不可用：持久化层故障，测试无法继续');
    store.recordReview({
      runId: 'run-A',
      atMin: 15,
      verdict: 'approve',
      actor: 'operator',
      action: 'adjust',
      reason: '',
    });
    store.recordReview({
      runId: 'run-A',
      atMin: 30,
      verdict: 'reject',
      actor: 'admin',
      action: 'adjust',
      reason: '成本不划算',
    });
    store.recordReview({ runId: 'run-B', atMin: 45, verdict: 'auto', actor: 'ai', action: 'dose', reason: '' });
    store.flush();

    const a = store.recentReviews(10, 'run-A');
    expect(a).toHaveLength(2);
    // 倒序：最新在前
    expect(a[0].verdict).toBe('reject');
    expect(a[0].reason).toBe('成本不划算');
    expect(a[1].verdict).toBe('approve');

    const b = store.recentReviews(10, 'run-B');
    expect(b).toHaveLength(1);
    expect(b[0].actor).toBe('ai');
    expect(store.count().reviews).toBe(3);
  });

  it('未按 run 过滤时返回全部裁决，且受 limit 约束', async () => {
    await store.open();
    if (!store.enabled) throw new Error('node:sqlite 不可用');
    for (let i = 0; i < 5; i += 1) {
      store.recordReview({
        runId: `run-${i}`,
        atMin: i,
        verdict: 'reject',
        actor: 'operator',
        action: 'hold',
        reason: '',
      });
    }
    store.flush();
    expect(store.recentReviews()).toHaveLength(5);
    expect(store.recentReviews(2)).toHaveLength(2);
  });

  it('持久化关闭时写入不抛错、读取返回空', async () => {
    // 未 open 的实例：db 为 null，所有路径必须安全
    store.recordReview({ atMin: 1, verdict: 'reject', actor: 'operator', action: 'hold', reason: 'x' });
    expect(store.recentReviews()).toEqual([]);
  });
});
