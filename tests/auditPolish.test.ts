import { describe, expect, it } from 'vitest';
import { layoutTopology, portAnchors } from '../src/model/layout';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import { actionFor } from '../src/ai/agent';
import { fitCompactTitle } from '../src/client/components/labels';
import { normalizeRoute, SLO } from '../src/server/observability';
import { mergeSnapshot } from '../src/client/hooks/snapshotMerge';
import { makeSnapshot } from './fixtures/snapshot';
import { pushNotice, pruneNotices, NOTICE_LIMIT, NOTICE_TTL_MS } from '../src/client/hooks/notices';
import type { SnapshotPatch } from '../src/shared/protocol';

/**
 * 本轮全方面审计的回归锁。
 *
 * 每条都对应一处"截图/实测能看到、但单测此前没有覆盖"的缺陷：
 * - 跨层连线停在池子中线/池底，而不是端口圆点（编排器里看是断线）
 * - 紧凑模式长标题溢出到相邻单元（污泥浓缩池压到脱水机房）
 * - AI 每个决策周期都做 1–2 分的微调，控制量来回摆动
 * - 预测扇区与双跑摘要只在全量快照里，面板连上以后永久冻结
 * - 未知 API 路由没被折叠，指标基数可被打爆
 * - 顶栏提示永不消失，越堆越多挡住右下角
 */

const tokenize = (d: string) => {
  const toks = d.trim().split(/\s+/);
  const points: { x: number; y: number }[] = [];
  let x = 0;
  let y = 0;
  let i = 0;
  while (i < toks.length) {
    const cmd = toks[i++];
    if (cmd === 'M') {
      x = Number(toks[i++]);
      y = Number(toks[i++]);
      points.push({ x, y });
    } else if (cmd === 'H') {
      x = Number(toks[i++]);
      points.push({ x, y });
    } else if (cmd === 'V') {
      y = Number(toks[i++]);
      points.push({ x, y });
    }
  }
  return points;
};

describe('连线端点必须落在端口锚点上', () => {
  it('标准厂 23 条物流全部起于出口锚点、止于入口锚点', () => {
    const layout = layoutTopology(PLANT_TOPOLOGY);
    const byId = new Map(layout.nodes.map((n) => [n.unit.id, n]));
    const bad: string[] = [];
    for (const edge of layout.edges) {
      const from = byId.get(edge.connection.from.unit)!;
      const to = byId.get(edge.connection.to.unit)!;
      const out = portAnchors(from).find((p) => p.kind === 'out' && p.port.id === edge.connection.from.port)!;
      const inp = portAnchors(to).find((p) => p.kind === 'in' && p.port.id === edge.connection.to.port)!;
      const pts = tokenize(edge.path);
      const first = pts[0];
      const last = pts[pts.length - 1];
      if (Math.abs(first.x - out.x) > 0.75 || Math.abs(first.y - out.y) > 0.75) {
        bad.push(`${edge.connection.id}: 起点 ${first.x},${first.y} ≠ ${out.x},${out.y}`);
      }
      if (Math.abs(last.x - inp.x) > 0.75 || Math.abs(last.y - inp.y) > 0.75) {
        bad.push(`${edge.connection.id}: 终点 ${last.x},${last.y} ≠ ${inp.x},${inp.y}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('人工摆放后端点仍然对齐（走 routeManual）', () => {
    const topo = {
      ...PLANT_TOPOLOGY,
      positions: { anaerobic: { x: 600, y: 400 }, aerobic1: { x: 1000, y: 520 } },
    };
    const layout = layoutTopology(topo);
    const byId = new Map(layout.nodes.map((n) => [n.unit.id, n]));
    for (const edge of layout.edges) {
      const from = byId.get(edge.connection.from.unit)!;
      const to = byId.get(edge.connection.to.unit)!;
      const out = portAnchors(from).find((p) => p.kind === 'out' && p.port.id === edge.connection.from.port)!;
      const inp = portAnchors(to).find((p) => p.kind === 'in' && p.port.id === edge.connection.to.port)!;
      const pts = tokenize(edge.path);
      expect(Math.abs(pts[0].x - out.x)).toBeLessThan(0.75);
      expect(Math.abs(pts[pts.length - 1].y - inp.y)).toBeLessThan(0.75);
    }
  });
});

describe('紧凑模式标题不越界', () => {
  it('长中文名在 118px 宽节点里收缩到可容纳', () => {
    const fitted = fitCompactTitle('污泥浓缩池', 118);
    expect(fitted.fontSize).toBeLessThan(24);
    expect(fitted.text.length).toBeLessThanOrEqual(6);
  });

  it('短名字保持 24px', () => {
    const fitted = fitCompactTitle('好氧池 A', 114);
    expect(fitted.fontSize).toBe(24);
    expect(fitted.text).toBe('好氧池 A');
  });

  it('极窄节点也不会把字号压到不可读以下', () => {
    expect(fitCompactTitle('污泥浓缩池', 60).fontSize).toBeGreaterThanOrEqual(15);
  });
});

describe('AI 决策死区', () => {
  it('增益低于死区且非应急时维持现状', () => {
    expect(actionFor({ gain: 5, tweaks: 1, severity: 'normal', deadband: 18 })).toBe('hold');
    expect(actionFor({ gain: 5, tweaks: 1, severity: 'watch', deadband: 18 })).toBe('hold');
  });

  it('应急永远放行', () => {
    expect(actionFor({ gain: 0, tweaks: 1, severity: 'critical', deadband: 18 })).toBe('emergency');
  });

  it('增益超过死区时执行调整', () => {
    expect(actionFor({ gain: 40, tweaks: 2, severity: 'normal', deadband: 18 })).toBe('adjust');
  });

  it('没有可执行改动就是 hold', () => {
    expect(actionFor({ gain: 100, tweaks: 0, severity: 'normal', deadband: 18 })).toBe('hold');
  });

  it('critical 即使无改动也不得降级为 hold（风险不能静默）', () => {
    // 预测已超标、但 guard 已把最优候选压到与当前控制一致：仍必须是 emergency
    expect(actionFor({ gain: 0, tweaks: 0, severity: 'critical', deadband: 18 })).toBe('emergency');
  });
});

describe('增量快照必须刷新预测与双跑', () => {
  const basePatch = (over: Partial<SnapshotPatch> = {}): SnapshotPatch => {
    const snap = makeSnapshot();
    return {
      timeMin: snap.timeMin + 2,
      influentFlow: 2100,
      influent: snap.influent,
      effluent: snap.effluent,
      tanks: [],
      clarifier: {
        blanketM: snap.clarifier.blanketM,
        xRas: snap.clarifier.xRas,
        xEff: snap.clarifier.xEff,
        slr: snap.clarifier.slr,
      },
      energy: snap.energy,
      cost: { totalToday: snap.cost.totalToday, total: snap.cost.total },
      srtDays: snap.srtDays,
      fmRatio: snap.fmRatio,
      controls: snap.controls,
      scenario: null,
      totals: snap.totals,
      score: snap.score,
      margins: snap.margins,
      trendsAppend: [],
      alarms: [],
      activeAlarms: [],
      alarmAttribution: {},
      health: snap.health,
      stormStorageM3: 0,
      reactorCount: 5,
      forecastBand: null,
      benchmark: null,
      ...over,
    };
  };

  it('预测扇区随补丁更新（此前只在全量快照里，面板连上后冻结）', () => {
    const band = {
      points: [{ minute: 60, cod: { p10: 30, p50: 34, p90: 38 }, nh: { p10: 0.4, p50: 0.6, p90: 0.9 } }],
      exceedanceProbability: 0.12,
      worstRatio: 0.91,
      members: 3,
    } as never;
    const merged = mergeSnapshot(makeSnapshot(), basePatch({ forecastBand: band }));
    expect(merged.forecastBand).toBe(band);
  });

  it('双跑摘要随补丁更新', () => {
    const benchmark = {
      ai: { minutes: 120, compliantMinutes: 110, specificKwhM3: 0.15, inflowM3: 4000, cost: 500, scoreSum: 7000 },
      manual: { minutes: 120, compliantMinutes: 70, specificKwhM3: 0.16, inflowM3: 4000, cost: 600, scoreSum: 5600 },
      complianceDeltaPct: 33,
      specificEnergyDelta: -0.01,
      costDeltaPct: -16,
      scoreDelta: 11,
      mature: true,
    } as never;
    const merged = mergeSnapshot(makeSnapshot(), basePatch({ benchmark }));
    expect(merged.benchmark).toBe(benchmark);
  });
});

describe('指标路由折叠', () => {
  it('未知 API 路径折叠为 __unmatched__，避免基数爆炸', () => {
    expect(normalizeRoute('/api/whatever-123')).toBe('/api/__unmatched__');
    expect(normalizeRoute('/api/../api/snapshot')).toBe('/api/__unmatched__');
  });

  it('SLO 表里每个名字都能渲染（Prometheus 标签不含非法字符）', () => {
    for (const s of SLO) expect(s.name).toMatch(/^[a-zA-Z_:][a-zA-Z0-9_:]*$/);
  });
});

describe('提示条：上限与过期', () => {
  it('超过上限只保留最新三条', () => {
    let list: { id: number; at: number; level: string; text: string }[] = [];
    for (let i = 1; i <= 5; i++) list = pushNotice(list, { id: i, at: i * 1000, level: 'info', text: `n${i}` });
    expect(list).toHaveLength(NOTICE_LIMIT);
    expect(list[0].text).toBe('n5');
  });

  it('过期条目被清掉，未过期的保留', () => {
    const list = [
      { id: 1, at: 0, level: 'info', text: 'old' },
      { id: 2, at: 9000, level: 'info', text: 'fresh' },
    ];
    // now = 15 s：id 1 已活 15 s（> 12 s 上限）被清掉，id 2 只活了 6 s 仍在
    const pruned = pruneNotices(list, 15_000, NOTICE_TTL_MS);
    expect(pruned.map((n) => n.text)).toEqual(['fresh']);
  });
});
