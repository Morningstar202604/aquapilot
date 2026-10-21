import { describe, expect, it } from 'vitest';
import {
  PLANT_TOPOLOGY,
  ProcessTopology,
  incoming,
  outgoing,
  totalTrainVolume,
  validateTopology,
  hydraulicRetention,
  deriveTrain,
} from '../src/model/topology';
import { layoutTopology, unreachableUnits } from '../src/model/layout';
import { checkRunReadiness, createRuntime, applyTopology, stepRuntime } from '../src/server/topologyRuntime';


describe('工艺拓扑模型', () => {
  it('标准厂拓扑无阻断错误', () => {
    const issues = validateTopology(PLANT_TOPOLOGY);
    expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('每个连接引用的端口都真实存在', () => {
    const issues = validateTopology(PLANT_TOPOLOGY);
    expect(issues.filter((i) => i.code === 'BAD_PORT')).toHaveLength(0);
  });

  it('主序列五个生物池都有容积', () => {
    const train = deriveTrain(PLANT_TOPOLOGY);
    expect(train).toHaveLength(5);
    for (const t of train) expect(t.spec.volume).toBeGreaterThan(0);
  });

  it('计算出正确的总池容与停留时间', () => {
    expect(totalTrainVolume(PLANT_TOPOLOGY)).toBe(3000 + 4500 + 5000 * 3);
    const hrt = hydraulicRetention(PLANT_TOPOLOGY, 2000);
    expect(hrt).toHaveLength(5);
    for (const row of hrt) expect(row.hrt).toBeGreaterThan(0);
  });

  it('识别出内回流与污泥回流形成闭环', () => {
    const ir = PLANT_TOPOLOGY.connections.find((c) => c.stream === 'internal_recycle');
    const ras = PLANT_TOPOLOGY.connections.find((c) => c.stream === 'return_activated_sludge');
    expect(ir?.recycle).toBe(true);
    expect(ras?.recycle).toBe(true);
    expect(ir!.from.unit).toBe('aerobic3');
    expect(ir!.to.unit).toBe('anoxic');
  });

  it('主流程单元都从进水可达、且能到排放口', () => {
    const unreachable = unreachableUnits(PLANT_TOPOLOGY);
    const utility = new Set(['blower', 'chemical']);
    const sludgeLine = new Set(['thickener', 'dewatering', 'primary']);
    const waterPathUnreachable = unreachable.filter((id) => {
      const unit = PLANT_TOPOLOGY.units.find((u) => u.id === id);
      return unit && !utility.has(unit.kind) && !sludgeLine.has(unit.id);
    });
    expect(waterPathUnreachable).toEqual([]);
  });

  it('公用工程与污泥线被识别为不参与水线遍历', () => {
    const unreachable = unreachableUnits(PLANT_TOPOLOGY);
    expect(unreachable).toContain('blower');
    expect(unreachable).toContain('chemical');
  });

  it('主流程单元至少有一条进、一条出', () => {
    const sources = new Set(['inlet', 'blower', 'chemical']);
    const sinks = new Set(['outlet', 'dewatering']);
    for (const unit of PLANT_TOPOLOGY.units) {
      if (sources.has(unit.id)) continue;
      expect(incoming(PLANT_TOPOLOGY, unit.id).length, `${unit.name} 无入口`).toBeGreaterThan(0);
      if (sinks.has(unit.id)) continue;
      expect(outgoing(PLANT_TOPOLOGY, unit.id).length, `${unit.name} 无出口`).toBeGreaterThan(0);
    }
  });

  it('每个公用工程单元都有明确的去向（不会悬空）', () => {
    for (const unit of PLANT_TOPOLOGY.units.filter((u) => u.kind === 'blower' || u.kind === 'chemical')) {
      expect(outgoing(PLANT_TOPOLOGY, unit.id).length, `${unit.name} 未接线`).toBeGreaterThan(0);
    }
  });
});

describe('拓扑校验能挡住跑不了的图', () => {
  const clone = (): ProcessTopology => JSON.parse(JSON.stringify(PLANT_TOPOLOGY)) as ProcessTopology;

  it('删除二沉池后不可运行', () => {
    const topo = clone();
    topo.units = topo.units.filter((u) => u.kind !== 'clarifier');
    const readiness = checkRunReadiness(topo);
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.join()).toContain('二沉池');
  });

  it('删除全部好氧池后不可运行', () => {
    const topo = clone();
    topo.train = topo.train.filter((id) => {
      const u = topo.units.find((x) => x.id === id);
      return u?.kind !== 'aerobic';
    });
    const readiness = checkRunReadiness(topo);
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.join()).toContain('好氧池');
  });

  it('清空主序列后不可运行', () => {
    const topo = clone();
    topo.train = [];
    expect(checkRunReadiness(topo).ready).toBe(false);
  });

  it('缺少污泥回流只给警告不阻断', () => {
    const topo = clone();
    topo.connections = topo.connections.filter((c) => c.stream !== 'return_activated_sludge');
    const readiness = checkRunReadiness(topo);
    expect(readiness.ready).toBe(true);
    expect(readiness.warnings.join()).toContain('污泥回流');
  });

  it('停留时间过短时给出警告', () => {
    const topo = clone();
    for (const u of topo.units) {
      if (u.volume && topo.train.includes(u.id)) u.volume = 300;
    }
    const readiness = checkRunReadiness(topo);
    expect(readiness.warnings.join()).toContain('停留时间');
  });

  it('连接引用不存在的单元时报错', () => {
    const topo = clone();
    topo.connections.push({
      id: 'ghost',
      from: { unit: 'nope', port: 'out' },
      to: { unit: 'clarifier', port: 'in' },
      stream: 'mixed_liquor',
    });
    const issues = validateTopology(topo);
    expect(issues.some((i) => i.code === 'MISSING_UNIT')).toBe(true);
  });

  it('连接引用不存在的端口时报错', () => {
    const topo = clone();
    topo.connections.push({
      id: 'badport',
      from: { unit: 'aerobic1', port: 'ghost-port' },
      to: { unit: 'aerobic2', port: 'in' },
      stream: 'mixed_liquor',
    });
    const issues = validateTopology(topo);
    expect(issues.some((i) => i.code === 'BAD_PORT')).toBe(true);
  });
});

describe('布局引擎', () => {
  it('为主序列单元分配互不重叠的坐标', () => {
    const layout = layoutTopology(PLANT_TOPOLOGY);
    const main = layout.nodes.filter((n) => n.layer === 'main');
    expect(main.length).toBeGreaterThan(0);
    const sorted = [...main].sort((a, b) => a.x - b.x);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].x).toBeGreaterThanOrEqual(sorted[i - 1].x + sorted[i - 1].w);
    }
  });

  it('每条连接都生成了路径', () => {
    const layout = layoutTopology(PLANT_TOPOLOGY);
    expect(layout.edges).toHaveLength(PLANT_TOPOLOGY.connections.length);
    for (const edge of layout.edges) {
      expect(edge.path.length).toBeGreaterThan(0);
      expect(edge.path.startsWith('M')).toBe(true);
    }
  });

  it('公用工程与污泥线不与主线下重叠', () => {
    const layout = layoutTopology(PLANT_TOPOLOGY);
    const mainBottom = Math.max(...layout.nodes.filter((n) => n.layer === 'main').map((n) => n.y + n.h));
    for (const node of layout.nodes.filter((n) => n.layer !== 'main')) {
      expect(node.y).toBeGreaterThan(mainBottom);
    }
  });

  it('回流线与主物料流分层，不画在主线高度上', () => {
    const layout = layoutTopology(PLANT_TOPOLOGY);
    const recycles = layout.edges.filter((e) => e.connection.recycle);
    expect(recycles.length).toBeGreaterThan(0);
    for (const edge of recycles) {
      expect(edge.reverse).toBe(true);
    }
  });
});

describe('拓扑应用到仿真（真跑）', () => {
  it('标准厂可以创建运行时并完成预热到稳定出水', () => {
    const rt = createRuntime(PLANT_TOPOLOGY);
    expect(rt.net.reactors.length).toBe(5);
    // 预热后生物量应接近设计区间，出水达标
    const mlss = (rt.net.biomassKg * 1000) / rt.net.volume.bio;
    expect(mlss).toBeGreaterThan(2000);
    // Takács 二沉池的截留率高于原经验公式，MLSS 上限放宽到 8000（仍在常规活性污泥法范围内）
    expect(mlss).toBeLessThan(8000);
    expect(rt.net.effluent.nh).toBeLessThan(5);
    expect(rt.net.effluent.cod).toBeLessThan(50);
  });

  it('拓扑池容会真实影响引擎池容（运行时反应器直接反映）', () => {
    const topo: ProcessTopology = JSON.parse(JSON.stringify(PLANT_TOPOLOGY));
    for (const u of topo.units) {
      if (topo.train.includes(u.id) && u.volume) u.volume = (u.volume ?? 0) * 2;
    }
    const base = createRuntime(PLANT_TOPOLOGY);
    const doubled = createRuntime(topo);
    const sum = (rt: ReturnType<typeof createRuntime>) =>
      rt.net.reactors.reduce((a: number, t: { volume: number }) => a + t.volume, 0);
    expect(sum(doubled)).toBeCloseTo(sum(base) * 2, 0);
    expect(doubled.compiled.reactors.map((r) => r.volume)).toEqual(
      base.compiled.reactors.map((r) => r.volume * 2),
    );
  });

  it('二沉池面积改变会反映到引擎', () => {
    const topo: ProcessTopology = JSON.parse(JSON.stringify(PLANT_TOPOLOGY));
    const clarifier = topo.units.find((u) => u.kind === 'clarifier')!;
    clarifier.area = 4800;
    const rt = createRuntime(topo);
    expect(rt.net.clarifier.area).toBe(4800);
    expect(rt.net.clarifier.area).toBeGreaterThan(PLANT_TOPOLOGY.units.find((u) => u.kind === 'clarifier')!.area!);
  });

  it('不可运行的拓扑会被拒绝应用且不改变运行时', () => {
    const rt = createRuntime(PLANT_TOPOLOGY);
    const before = rt.revision;
    const broken: ProcessTopology = JSON.parse(JSON.stringify(PLANT_TOPOLOGY));
    broken.units = broken.units.filter((u) => u.kind !== 'clarifier');
    const result = applyTopology(rt, broken);
    expect(result.ok).toBe(false);
    expect(result.blockers.length).toBeGreaterThan(0);
    expect(rt.revision).toBe(before);
  });

  it('可运行的拓扑会被接受并递增版本号', () => {
    const rt = createRuntime(PLANT_TOPOLOGY);
    const before = rt.revision;
    const bigger: ProcessTopology = JSON.parse(JSON.stringify(PLANT_TOPOLOGY));
    for (const u of bigger.units) {
      if (u.kind === 'aerobic') u.volume = (u.volume ?? 0) + 2000;
    }
    const result = applyTopology(rt, bigger);
    expect(result.ok).toBe(true);
    expect(rt.revision).toBe(before + 1);
    expect(rt.topology.id).toBe(bigger.id);
  });

  it('扩大好氧池容积后出水氨氮不劣化', () => {
    const base = createRuntime(PLANT_TOPOLOGY);
    const bigger: ProcessTopology = JSON.parse(JSON.stringify(PLANT_TOPOLOGY));
    for (const u of bigger.units) {
      if (u.kind === 'aerobic') u.volume = (u.volume ?? 0) * 1.6;
    }
    const enlarged = createRuntime(bigger);
    expect(enlarged.net.effluent.nh).toBeLessThanOrEqual(base.net.effluent.nh + 0.05);
  });
});

describe('回归：HRT 与未接线单元', () => {
  it('HRT 按 m³/h 计算，标准厂约 11.25 h', () => {
    const readiness = checkRunReadiness(PLANT_TOPOLOGY, 2000);
    expect(readiness.derived.hrtHours).toBeGreaterThan(10);
    expect(readiness.derived.hrtHours).toBeLessThan(13);
  });

  it('新增未接线的生物池必须阻断应用', () => {
    const topo: ProcessTopology = JSON.parse(JSON.stringify(PLANT_TOPOLOGY));
    topo.units.push({
      id: 'aerobic9',
      kind: 'aerobic',
      name: '好氧池 D',
      role: '硝化',
      volume: 5000,
      ports: [
        { id: 'in', kind: 'in', stream: 'mixed_liquor' },
        { id: 'out', kind: 'out', stream: 'mixed_liquor' },
        { id: 'air', kind: 'in', stream: 'air' },
      ],
    });
    topo.train.push('aerobic9');
    const readiness = checkRunReadiness(topo);
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.join()).toContain('没有入口物流');
  });
});

describe('回归：拓扑几何必须真实影响物理', () => {
  const withAerobicScale = (factor: number) => {
    const topo: ProcessTopology = JSON.parse(JSON.stringify(PLANT_TOPOLOGY));
    for (const u of topo.units) {
      if (u.kind === 'aerobic' && u.volume) u.volume = Math.round(u.volume * factor);
    }
    return topo;
  };

  it('好氧池容积翻倍会降低出水氨氮', () => {
    const base = createRuntime(PLANT_TOPOLOGY);
    const big = createRuntime(withAerobicScale(2));
    expect(big.net.effluent.nh).toBeLessThan(base.net.effluent.nh);
  });

  it('好氧池容积减半会升高出水氨氮', () => {
    const base = createRuntime(PLANT_TOPOLOGY);
    const small = createRuntime(withAerobicScale(0.5));
    expect(small.net.effluent.nh).toBeGreaterThan(base.net.effluent.nh);
  });

  it('二沉池面积翻倍会降低表面固体负荷', () => {
    const topo: ProcessTopology = JSON.parse(JSON.stringify(PLANT_TOPOLOGY));
    topo.units.find((u) => u.kind === 'clarifier')!.area = 4800;
    const base = createRuntime(PLANT_TOPOLOGY);
    const big = createRuntime(topo);
    expect(big.net.clarifier.slr).toBeLessThan(base.net.clarifier.slr * 0.75);
  });

  it('二沉池面积翻倍会让泥层变薄', () => {
    const topo: ProcessTopology = JSON.parse(JSON.stringify(PLANT_TOPOLOGY));
    topo.units.find((u) => u.kind === 'clarifier')!.area = 4800;
    const base = createRuntime(PLANT_TOPOLOGY);
    const big = createRuntime(topo);
    expect(big.net.clarifier.blanketM).toBeLessThan(base.net.clarifier.blanketM);
  });

  it('回流中断会让泥层抬升（而不是因为负荷假性降低而变薄）', () => {
    const runtime = createRuntime(PLANT_TOPOLOGY);
    const before = runtime.net.clarifier.blanketM;
    runtime.net.scenario = { type: 'ras_failure', durationMin: 240, magnitude: 0, startedAt: runtime.net.timeMin };
    for (let i = 0; i < 180; i++) stepRuntime(runtime, 1);
    expect(runtime.net.clarifier.blanketM).toBeGreaterThan(before);
  });
});
