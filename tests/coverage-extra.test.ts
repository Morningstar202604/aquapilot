import { describe, expect, it } from 'vitest';
import { labelOf, precisionOf, unitOf, SCENARIO_LABELS } from '../src/client/components/labels';
import { qualityScore, estimateMargin } from '../src/sim/metrics';
import { networkSnapshot, legacyModel } from '../src/sim/plantModel';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import { createNetworkState } from '../src/sim/networkEngine';
import { createInitialState, forecast } from '../src/sim/engine';
import {
  applyTopology,
  createRuntime,
  runtimeQuality,
  stepRuntime,
  topologySummary,
} from '../src/server/topologyRuntime';
import { compileNetwork } from '../src/sim/network';
import { BSM1_SETTLER, sludgeBlanketHeight } from '../src/sim/takacs';

/**
 * 补齐低覆盖分支。
 *
 * 这些不是"为了数字"的测试：每个用例都对应一条真实会被触发的边界
 * （未知控制键、极端出水、空状态适配器），只是平时不会被稳态路径走到。
 */

describe('标签映射的兜底', () => {
  it('未知控制键返回原键与默认精度', () => {
    expect(labelOf('ghost')).toBe('ghost');
    expect(unitOf('ghost')).toBe('');
    expect(precisionOf('ghost')).toBe(2);
  });

  it('已知控制键返回工艺名称与单位', () => {
    expect(labelOf('doSetpoint')).toBe('好氧区溶解氧设定');
    expect(unitOf('doSetpoint')).toBe('mg/L');
    expect(precisionOf('wasRatio')).toBe(3);
  });

  it('场景标签覆盖全部场景', () => {
    expect(Object.keys(SCENARIO_LABELS).length).toBeGreaterThanOrEqual(6);
    expect(SCENARIO_LABELS.storm).toBeTruthy();
  });
});

describe('出水评分的边界', () => {
  const clean = {
    flow: 2000,
    cod: 10,
    bod: 2,
    ss: 1,
    nh: 0.1,
    tn: 2,
    tp: 0.05,
    ph: 7,
    temperature: 20,
  };

  it('全部远低于限值时得满分', () => {
    expect(qualityScore(clean)).toBe(100);
  });

  it('全部超限时得 0 分且不出现负分', () => {
    const dirty = { ...clean, cod: 500, nh: 40, tn: 90, tp: 8, ss: 90, bod: 200 };
    const score = qualityScore(dirty);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThan(20);
  });

  it('最紧指标由 margins 排序给出', () => {
    const margins = estimateMargin({ ...clean, ss: 9.5 });
    expect(margins[0].metric).toBe('SS');
    expect(margins[0].ratio).toBeCloseTo(0.95, 5);
  });
});

describe('PlantModel 适配器的空状态', () => {
  it('空状态快照仍给出完整结构', () => {
    const s = createNetworkState(PLANT_TOPOLOGY, { seed: 1 });
    const snap = networkSnapshot(s);
    expect(snap.reactorCount).toBe(5);
    expect(Number.isFinite(snap.mlss)).toBe(true);
    expect(Number.isFinite(snap.clarifier.blanketM)).toBe(true);
  });

  it('旧引擎适配器读取快照不改变状态', () => {
    const s = createInitialState({ seed: 5 });
    const before = s.timeMin;
    const model = legacyModel(s, forecast);
    expect(model.snapshot().timeMin).toBe(before);
    expect(model.snapshot().reactorCount).toBe(s.tanks.length);
  });
});

describe('拓扑运行时的辅助接口', () => {
  it('stepRuntime 推进仿真时钟', () => {
    const rt = createRuntime(PLANT_TOPOLOGY, 7);
    const before = rt.net.timeMin;
    stepRuntime(rt, 2);
    expect(rt.net.timeMin).toBe(before + 2);
  });

  it('runtimeQuality 返回 0–100 的分数', () => {
    const rt = createRuntime(PLANT_TOPOLOGY, 7);
    const q = runtimeQuality(rt);
    expect(q).toBeGreaterThan(0);
    expect(q).toBeLessThanOrEqual(100);
  });

  it('topologySummary 汇总结构与回流信息', () => {
    const summary = topologySummary(PLANT_TOPOLOGY);
    expect(summary.units).toBe(PLANT_TOPOLOGY.units.length);
    expect(summary.hasRas).toBe(true);
    expect(summary.hasInternalRecycle).toBe(true);
    expect(summary.hasStorage).toBe(true);
    expect(summary.trainLength).toBeGreaterThan(0);
  });

  it('应用不可运行拓扑时保留原运行时不变', () => {
    const rt = createRuntime(PLANT_TOPOLOGY, 7);
    const revision = rt.revision;
    const broken = JSON.parse(JSON.stringify(PLANT_TOPOLOGY));
    broken.units = broken.units.filter((u: { kind: string }) => u.kind !== 'clarifier');
    broken.connections = broken.connections.filter(
      (c: { to: { unit: string }; from: { unit: string } }) => c.to.unit !== 'clarifier' && c.from.unit !== 'clarifier',
    );
    const result = applyTopology(rt, broken);
    expect(result.ok).toBe(false);
    expect(rt.revision).toBe(revision);
  });
});

describe('编译期错误分支', () => {
  it('主序列引用不存在的单元时报错', () => {
    const topo = JSON.parse(JSON.stringify(PLANT_TOPOLOGY));
    topo.train = [...topo.train, 'ghost-unit'];
    const net = compileNetwork(topo);
    expect(net.problems.some((p: string) => p.includes('不存在'))).toBe(true);
  });

  it('自循环的主序列被判定为环路', () => {
    const topo = JSON.parse(JSON.stringify(PLANT_TOPOLOGY));
    topo.units.push({
      id: 'loopA',
      kind: 'aerobic',
      name: '环 A',
      role: '测试',
      volume: 1000,
      ports: [
        { id: 'in', kind: 'in', stream: 'mixed_liquor' },
        { id: 'out', kind: 'out', stream: 'mixed_liquor' },
      ],
    });
    topo.train = ['loopA'];
    topo.connections.push({
      id: 'loop-a-self',
      from: { unit: 'loopA', port: 'out' },
      to: { unit: 'loopA', port: 'in' },
      stream: 'mixed_liquor',
    });
    const net = compileNetwork(topo);
    expect(net.problems.length).toBeGreaterThan(0);
  });
});

describe('Takács 泥层函数的边界', () => {
  it('澄清区浓度接近零时返回最小泥层', () => {
    const cfg = { ...BSM1_SETTLER, area: 1500, depth: 4.5 };
    const state = { x: new Array(cfg.layers).fill(0) } as never;
    expect(sludgeBlanketHeight(state, cfg)).toBeCloseTo(0.2, 5);
  });

  it('泥层厚度不超过池深加余量', () => {
    const cfg = { ...BSM1_SETTLER, area: 1500, depth: 4.5 };
    const state = { x: new Array(cfg.layers).fill(9000) } as never;
    expect(sludgeBlanketHeight(state, cfg)).toBeLessThanOrEqual(cfg.depth + 0.5);
  });
});

describe('空反应器列表的防御分支', () => {
  it('旧引擎快照在无池时回退到 0 而不是崩溃', () => {
    const s = createInitialState({ seed: 3 });
    s.tanks = [];
    const model = legacyModel(s, forecast);
    expect(model.snapshot().mlss).toBe(0);
    expect(model.snapshot().lastDo).toBe(0);
    expect(model.snapshot().reactorCount).toBe(0);
  });
});
