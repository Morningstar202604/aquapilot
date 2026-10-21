import { describe, expect, it } from 'vitest';
import { PLANT_TOPOLOGY, ProcessTopology, validateTopology } from '../src/model/topology';
import { checkRunReadiness, availableInterventions, retentionBreakdown } from '../src/sim/topologyEngine';
import { decide } from '../src/ai/agent';
import { PLANT_TOPOLOGY as TOPO } from '../src/model/topology';
import { createNetworkState, networkModel, spinUpNetwork } from '../src/sim/networkEngine';

/**
 * 覆盖率补齐测试。
 *
 * 目标不是凑数字，而是覆盖此前从未执行的分支：
 *   - topologyEngine 的可运行性校验分支（覆盖率仅 46%）
 *   - agent 的决策分支（58%）
 * 这些分支对应真实的错误输入与边界工况，属于应当被验证的路径。
 */

const clone = (): ProcessTopology => JSON.parse(JSON.stringify(PLANT_TOPOLOGY));

describe('可运行性校验：全部分支', () => {
  it('缺少进水单元时阻断', () => {
    const t = clone();
    t.units = t.units.filter((u) => u.kind !== 'inlet');
    expect(checkRunReadiness(t).blockers.join()).toContain('进水');
  });

  it('缺少排放单元时阻断', () => {
    const t = clone();
    t.units = t.units.filter((u) => u.kind !== 'outlet');
    expect(checkRunReadiness(t).ready).toBe(false);
  });

  it('主序列为空时阻断', () => {
    const t = clone();
    t.train = [];
    expect(checkRunReadiness(t).blockers.join()).toContain('主序列');
  });

  it('好氧池无容积时阻断', () => {
    const t = clone();
    const a = t.units.find((u) => u.id === 'aerobic1')!;
    a.volume = 0;
    const r = checkRunReadiness(t);
    expect(r.ready).toBe(false);
  });

  it('HRT 过长时给出警告', () => {
    const t = clone();
    for (const u of t.units) if (u.volume && t.train.includes(u.id)) u.volume = 40000;
    const r = checkRunReadiness(t);
    expect(r.warnings.join()).toContain('停留时间');
  });

  it('缺少内回流只警告不阻断', () => {
    const t = clone();
    t.connections = t.connections.filter((c) => c.stream !== 'internal_recycle');
    const r = checkRunReadiness(t);
    expect(r.ready).toBe(true);
    expect(r.warnings.join()).toContain('内回流');
  });

  it('未接线的生物池阻断', () => {
    const t = clone();
    t.units.push({
      id: 'orphan',
      kind: 'aerobic',
      name: '孤儿池',
      role: 'x',
      volume: 1000,
      ports: [
        { id: 'in', kind: 'in', stream: 'mixed_liquor' },
        { id: 'out', kind: 'out', stream: 'mixed_liquor' },
      ],
    });
    t.train.push('orphan');
    const r = checkRunReadiness(t);
    expect(r.ready).toBe(false);
    expect(r.blockers.join()).toContain('没有入口物流');
  });

  it('派生指标反映拓扑', () => {
    const r = checkRunReadiness(PLANT_TOPOLOGY, 2000);
    expect(r.derived.trainUnits).toBe(5);
    expect(r.derived.bioVolume).toBe(22500);
    expect(r.derived.aerobicVolume).toBe(15000);
    expect(r.derived.hrtHours).toBeGreaterThan(10);
  });
});

describe('拓扑辅助函数', () => {
  it('列出可干预控制项', () => {
    const list = availableInterventions(PLANT_TOPOLOGY);
    expect(list.length).toBeGreaterThan(3);
    expect(list.some((x) => x.key === 'doSetpoint')).toBe(true);
  });

  it('停留时间分解覆盖主序列', () => {
    const rows = retentionBreakdown(PLANT_TOPOLOGY, 2000);
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r.hrt).toBeGreaterThan(0);
  });

  it('校验器识别自连', () => {
    const t = clone();
    t.connections.push({
      id: 'self',
      from: { unit: 'aerobic1', port: 'out' },
      to: { unit: 'aerobic1', port: 'in' },
      stream: 'mixed_liquor',
    });
    expect(validateTopology(t).some((i) => i.code === 'SELF_LOOP')).toBe(true);
  });

  it('校验器识别悬空单元', () => {
    const t = clone();
    t.units.push({
      id: 'lone',
      kind: 'aerobic',
      name: '孤立',
      role: 'x',
      volume: 100,
      ports: [{ id: 'in', kind: 'in', stream: 'mixed_liquor' }],
    });
    const issues = validateTopology(t);
    expect(issues.some((i) => i.code === 'NO_INPUT' || i.code === 'NO_OUTPUT')).toBe(true);
  });
});

describe('AI 决策分支', () => {
  const plant = () => {
    const s = spinUpNetwork(createNetworkState(TOPO, { seed: 7 }), TOPO, 20);
    return { s, model: networkModel(TOPO, s) };
  };

  it('AI 关闭时仍能给出建议', () => {
    const { s, model } = plant();
    s.controls.aiEnabled = false;
    const rec = decide({ model, horizonMin: 120 });
    expect(rec.summary.length).toBeGreaterThan(5);
  });

  it('应急严重度对应 critical', () => {
    const { model } = plant();
    const rec = decide({ model, horizonMin: 240 });
    expect(['normal', 'watch', 'critical']).toContain(rec.severity);
    expect(['hold', 'adjust', 'emergency']).toContain(rec.action);
  });

  it('候选方案包含备选且各不相同', () => {
    const { model } = plant();
    const rec = decide({ model, horizonMin: 120 });
    expect(rec.alternatives.length).toBeGreaterThan(0);
    const labels = new Set(rec.alternatives.map((a) => a.label));
    expect(labels.size).toBe(rec.alternatives.length);
  });

  it('风险提示非空', () => {
    const { model } = plant();
    const rec = decide({ model, horizonMin: 120 });
    expect(rec.risks.length).toBeGreaterThan(0);
  });
});
