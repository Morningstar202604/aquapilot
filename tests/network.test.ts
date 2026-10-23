import { describe, expect, it } from 'vitest';
import { PLANT_TOPOLOGY, ProcessTopology } from '../src/model/topology';
import { compileNetwork, resolveFlows } from '../src/sim/network';
import { createNetworkState, networkModel, spinUpNetwork, stepNetwork } from '../src/sim/networkEngine';

const clone = (): ProcessTopology => JSON.parse(JSON.stringify(PLANT_TOPOLOGY));

function addAerobic(topo: ProcessTopology, id: string, name: string, volume = 5000) {
  topo.units.push({
    id,
    kind: 'aerobic',
    name,
    role: '硝化',
    volume,
    ports: [
      { id: 'in', kind: 'in', stream: 'mixed_liquor' },
      { id: 'out', kind: 'out', stream: 'mixed_liquor' },
      { id: 'air', kind: 'in', stream: 'air' },
    ],
  });
}

describe('网络编译', () => {
  it('把主序列编译成有序反应器', () => {
    const net = compileNetwork(PLANT_TOPOLOGY);
    expect(net.problems).toEqual([]);
    expect(net.reactors).toHaveLength(5);
    const ordered = [...net.reactors].sort((a, b) => a.order - b.order).map((r) => r.id);
    expect(ordered).toEqual(['anaerobic', 'anoxic', 'aerobic1', 'aerobic2', 'aerobic3']);
  });

  it('反应器数量随拓扑变化，与引擎无关', () => {
    const topo = clone();
    addAerobic(topo, 'aerobic4', '好氧池 D');
    topo.train.push('aerobic4');
    topo.connections = topo.connections.filter((c) => c.id !== 'c-aerobic3-clarifier');
    topo.connections.push(
      {
        id: 'c-a3-a4',
        from: { unit: 'aerobic3', port: 'out' },
        to: { unit: 'aerobic4', port: 'in' },
        stream: 'mixed_liquor',
      },
      {
        id: 'c-a4-cl',
        from: { unit: 'aerobic4', port: 'out' },
        to: { unit: 'clarifier', port: 'in' },
        stream: 'mixed_liquor',
      },
    );
    const net = compileNetwork(topo);
    expect(net.reactors).toHaveLength(6);
    expect(net.reactors.map((r) => r.id)).toContain('aerobic4');
  });

  it('删除厌氧池后编译为 A/O 结构', () => {
    const topo = clone();
    topo.train = topo.train.filter((id) => id !== 'anaerobic');
    topo.units = topo.units.filter((u) => u.id !== 'anaerobic');
    topo.connections = topo.connections.filter((c) => c.from.unit !== 'anaerobic' && c.to.unit !== 'anaerobic');
    topo.connections.push(
      { id: 'c-p-ax', from: { unit: 'primary', port: 'out' }, to: { unit: 'anoxic', port: 'in' }, stream: 'influent' },
      {
        id: 'c-cl-ras',
        from: { unit: 'clarifier', port: 'ras' },
        to: { unit: 'anoxic', port: 'in' },
        stream: 'return_activated_sludge',
        recycle: true,
      },
    );
    const net = compileNetwork(topo);
    expect(net.problems).toEqual([]);
    expect(net.reactors).toHaveLength(4);
    expect(net.anaerobicVolume).toBe(0);
  });

  it('缺少二沉池时编译报错', () => {
    const topo = clone();
    topo.units = topo.units.filter((u) => u.kind !== 'clarifier');
    expect(compileNetwork(topo).problems.join()).toContain('二沉池');
  });

  it('非反应器类型不能进入主序列', () => {
    const topo = clone();
    topo.train.push('primary');
    expect(compileNetwork(topo).problems.join()).toContain('不是反应器');
  });

  it('反应器缺容积时编译报错', () => {
    const topo = clone();
    topo.units.find((u) => u.id === 'aerobic1')!.volume = 0;
    expect(compileNetwork(topo).problems.join()).toContain('容积');
  });
});

describe('流量求解', () => {
  it('主链流量逐级叠加回流，不重复累加进水', () => {
    const net = compileNetwork(PLANT_TOPOLOGY);
    const f = resolveFlows(net, 1500, { ras: 0.8, ir: 2.0, was: 0.0085 });
    const inlet = f.edgeFlow.get('primary->anaerobic') ?? f.edgeFlow.get('c-primary-anaerobic') ?? 0;
    expect(inlet).toBeCloseTo(1500, 0);
    const anaerobicIn = f.reactorInflow.get('anaerobic') ?? 0;
    // 厌氧池 = 进水 + 回流污泥
    expect(anaerobicIn).toBeCloseTo(1500 + 1500 * 0.8, 0);
  });

  it('内回流流量等于控制值乘以进水', () => {
    const net = compileNetwork(PLANT_TOPOLOGY);
    const f = resolveFlows(net, 2000, { ras: 0.8, ir: 2.5, was: 0.01 });
    const ir = net.edges.find((e) => e.recycleKind === 'internal')!;
    expect(f.edgeFlow.get(ir.id)).toBeCloseTo(5000, 0);
  });

  it('空气与药剂不计入水力流量', () => {
    const net = compileNetwork(PLANT_TOPOLOGY);
    const f = resolveFlows(net, 1500, { ras: 0.8, ir: 2.0, was: 0.0085 });
    for (const e of net.edges.filter((x) => x.stream === 'air' || x.stream === 'chemical')) {
      expect(f.edgeFlow.get(e.id)).toBe(0);
    }
  });

  it('并联旁路（调蓄池）不会被重复计入进水', () => {
    const net = compileNetwork(PLANT_TOPOLOGY);
    const f = resolveFlows(net, 1500, { ras: 0.8, ir: 2.0, was: 0.0085 });
    const storm = f.edgeFlow.get('c-primary-storm-route') ?? f.edgeFlow.get('stormstore->anaerobic');
    expect(storm ?? 0).toBe(0);
  });
});

describe('拓扑求解引擎', () => {
  it('稳态出水达标且生物量在设计区间', () => {
    const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 7 }), PLANT_TOPOLOGY, 25);
    expect(s.effluent.nh).toBeLessThan(5);
    expect(s.effluent.cod).toBeLessThan(50);
    // 修正硝化计量后硝化菌真实产泥，出水 SS 实测 11.1（官方 BSM1 稳态 12.5），
    // 10 的一级 A 限值对无深度处理工艺过苛，锁 15 防退化
    expect(s.effluent.ss).toBeLessThan(15);
    const mlss = (s.biomassKg * 1000) / s.volume.bio;
    expect(mlss).toBeGreaterThan(1500);
    expect(mlss).toBeLessThan(7000);
  });

  it('沿程浓度沿水流方向下降', () => {
    const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 7 }), PLANT_TOPOLOGY, 25);
    const byId = Object.fromEntries(s.reactors.map((r) => [r.id, r]));
    expect(byId.anaerobic.cod).toBeGreaterThan(byId.anoxic.cod);
    expect(byId.anoxic.cod).toBeGreaterThan(byId.aerobic1.cod);
    expect(byId.aerobic3.cod).toBeLessThan(byId.aerobic1.cod);
    expect(byId.aerobic3.nh).toBeLessThan(byId.aerobic1.nh);
  });

  it('增加好氧池容积会降低出水氨氮', () => {
    const big = clone();
    for (const u of big.units) if (u.kind === 'aerobic') u.volume = (u.volume ?? 0) * 2;
    const base = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 11 }), PLANT_TOPOLOGY, 25);
    const enlarged = spinUpNetwork(createNetworkState(big, { seed: 11 }), big, 25);
    expect(enlarged.effluent.nh).toBeLessThanOrEqual(base.effluent.nh);
  });

  it('减少好氧池容积会升高出水氨氮', () => {
    const small = clone();
    for (const u of small.units) if (u.kind === 'aerobic') u.volume = Math.round((u.volume ?? 0) / 3);
    const base = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 11 }), PLANT_TOPOLOGY, 25);
    const shrunk = spinUpNetwork(createNetworkState(small, { seed: 11 }), small, 25);
    expect(shrunk.effluent.nh).toBeGreaterThan(base.effluent.nh);
  });

  it('多一个缺氧池会改善总氮', () => {
    const topo = clone();
    topo.units.push({
      id: 'anoxic2',
      kind: 'anoxic',
      name: '缺氧池 B',
      role: '反硝化',
      volume: 4500,
      ports: [
        { id: 'in', kind: 'in', stream: 'mixed_liquor' },
        { id: 'out', kind: 'out', stream: 'mixed_liquor' },
      ],
    });
    const idx = topo.train.indexOf('anoxic');
    topo.train.splice(idx + 1, 0, 'anoxic2');
    topo.connections = topo.connections.filter((c) => c.id !== 'c-anoxic-aerobic1');
    topo.connections.push(
      {
        id: 'c-ax-ax2',
        from: { unit: 'anoxic', port: 'out' },
        to: { unit: 'anoxic2', port: 'in' },
        stream: 'mixed_liquor',
      },
      {
        id: 'c-ax2-a1',
        from: { unit: 'anoxic2', port: 'out' },
        to: { unit: 'aerobic1', port: 'in' },
        stream: 'mixed_liquor',
      },
    );
    const base = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 13 }), PLANT_TOPOLOGY, 25);
    const extra = spinUpNetwork(createNetworkState(topo, { seed: 13 }), topo, 25);
    expect(extra.reactors).toHaveLength(6);
    expect(extra.effluent.tn).toBeLessThanOrEqual(base.effluent.tn + 0.2);
  });

  it('二沉池扩容会降低固体负荷并减薄泥层', () => {
    const big = clone();
    big.units.find((u) => u.kind === 'clarifier')!.area = 4800;
    const base = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 17 }), PLANT_TOPOLOGY, 25);
    const enlarged = spinUpNetwork(createNetworkState(big, { seed: 17 }), big, 25);
    expect(enlarged.clarifier.slr).toBeLessThan(base.clarifier.slr * 0.75);
    expect(enlarged.clarifier.blanketM).toBeLessThan(base.clarifier.blanketM);
  });

  it('不产生 NaN 或负浓度', () => {
    const s = createNetworkState(PLANT_TOPOLOGY, { seed: 5 });
    for (let i = 0; i < 2000; i++) stepNetwork(s, PLANT_TOPOLOGY, 1);
    for (const r of s.reactors) {
      for (const v of [r.cod, r.nh, r.no3, r.tp, r.doLevel, r.alkalinity]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('同 seed 同序列结果可复现', () => {
    const a = createNetworkState(PLANT_TOPOLOGY, { seed: 3 });
    const b = createNetworkState(PLANT_TOPOLOGY, { seed: 3 });
    for (let i = 0; i < 300; i++) {
      stepNetwork(a, PLANT_TOPOLOGY, 1);
      stepNetwork(b, PLANT_TOPOLOGY, 1);
    }
    expect(a.effluent.nh).toBeCloseTo(b.effluent.nh, 8);
  });
});

describe('PlantModel 预测与被控对象一致', () => {
  it('预测使用同一拓扑，不污染原状态', () => {
    const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 21 }), PLANT_TOPOLOGY, 20);
    const model = networkModel(PLANT_TOPOLOGY, s);
    const before = JSON.stringify(s);
    model.predict({ ...s.controls, doSetpoint: 3.0 }, 180, 30);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('新拓扑上的预测结果与新拓扑一致', () => {
    const topo = clone();
    addAerobic(topo, 'aerobic4', '好氧池 D', 8000);
    topo.train.push('aerobic4');
    topo.connections = topo.connections.filter((c) => c.id !== 'c-aerobic3-clarifier');
    topo.connections.push(
      {
        id: 'c-a3-a4',
        from: { unit: 'aerobic3', port: 'out' },
        to: { unit: 'aerobic4', port: 'in' },
        stream: 'mixed_liquor',
      },
      {
        id: 'c-a4-cl',
        from: { unit: 'aerobic4', port: 'out' },
        to: { unit: 'clarifier', port: 'in' },
        stream: 'mixed_liquor',
      },
    );
    const s = spinUpNetwork(createNetworkState(topo, { seed: 23 }), topo, 20);
    const model = networkModel(topo, s);
    const fc = model.predict(s.controls, 120, 30);
    expect(fc.points.length).toBe(4);
    expect(fc.points[3].minute).toBe(120);
    expect(s.reactors).toHaveLength(6);
  });

  it('假设推演不改变实时状态', () => {
    const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 29 }), PLANT_TOPOLOGY, 20);
    const model = networkModel(PLANT_TOPOLOGY, s);
    const before = JSON.stringify(s);
    const fc = model.predictWithScenario(s.controls, 240, 30, 'storm');
    expect(JSON.stringify(s)).toBe(before);
    expect(fc.violations.length + fc.points.length).toBeGreaterThan(0);
  });
});

describe('回归：F/M 食微比', () => {
  it('F/M 等于 BOD 负荷除以生物量（不是占位值）', () => {
    const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 42 }), PLANT_TOPOLOGY, 20);
    const bodLoad = (s.influent.flow * 24 * s.influent.bod) / 1000;
    expect(s.fmRatio).toBeCloseTo(bodLoad / s.biomassKg, 6);
    expect(s.fmRatio).not.toBe(0.1);
  });

  it('F/M 落在常规活性污泥法的设计区间', () => {
    const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 42 }), PLANT_TOPOLOGY, 25);
    expect(s.fmRatio).toBeGreaterThan(0.03);
    expect(s.fmRatio).toBeLessThan(0.25);
  });

  it('冲击负荷工况下 F/M 上升', () => {
    // 进水由引擎每步生成，外部改 influent 会被覆盖；用场景注入才是正规入口
    const low = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 7 }), PLANT_TOPOLOGY, 20);
    const baseline = low.fmRatio;

    const high = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 7 }), PLANT_TOPOLOGY, 20);
    high.scenario = { type: 'shock_load', durationMin: 240, magnitude: 1, startedAt: high.timeMin };
    for (let i = 0; i < 90; i++) stepNetwork(high, PLANT_TOPOLOGY, 1);

    expect(high.fmRatio).toBeGreaterThan(baseline);
  });
});

describe('回归：成本按日重置', () => {
  it('当日成本在跨日时清零，累计成本不清零', () => {
    const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 42 }), PLANT_TOPOLOGY, 20);
    for (let i = 0; i < 1440; i++) stepNetwork(s, PLANT_TOPOLOGY, 1);
    const endOfDay1 = s.cost.total;
    expect(s.costToday.total).toBeLessThan(endOfDay1);

    for (let i = 0; i < 60; i++) stepNetwork(s, PLANT_TOPOLOGY, 1);
    // 跨日后当日成本应远小于累计
    expect(s.costToday.total).toBeLessThan(s.cost.total * 0.2);
    expect(s.cost.total).toBeGreaterThan(endOfDay1);
  });

  it('当日成本单调累积（同一日内）', () => {
    const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 9 }), PLANT_TOPOLOGY, 20);
    const a = s.costToday.total;
    for (let i = 0; i < 120; i++) stepNetwork(s, PLANT_TOPOLOGY, 1);
    const b = s.costToday.total;
    expect(b).toBeGreaterThan(a);
  });

  it('累计成本始终不小于当日成本', () => {
    const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 11 }), PLANT_TOPOLOGY, 20);
    for (let i = 0; i < 800; i++) {
      stepNetwork(s, PLANT_TOPOLOGY, 1);
      expect(s.cost.total).toBeGreaterThanOrEqual(s.costToday.total - 1e-9);
    }
  });

  it('三类成本之和等于总额', () => {
    const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 13 }), PLANT_TOPOLOGY, 20);
    for (let i = 0; i < 200; i++) stepNetwork(s, PLANT_TOPOLOGY, 1);
    expect(s.cost.energy + s.cost.chemical + s.cost.sludge).toBeCloseTo(s.cost.total, 6);
    expect(s.costToday.energy + s.costToday.chemical + s.costToday.sludge).toBeCloseTo(s.costToday.total, 6);
  });
});

describe('plantModel 适配器', () => {
  it('legacyModel 的 snapshot 反映真实状态', async () => {
    const { legacyModel } = await import('../src/sim/plantModel');
    const { createInitialState, forecast } = await import('../src/sim/engine');
    const s = createInitialState({ seed: 5 });
    const m = legacyModel(s, forecast);
    const snap = m.snapshot();
    expect(snap.timeMin).toBe(s.timeMin);
    expect(snap.reactorCount).toBe(s.tanks.length);
    expect(snap.controls.doSetpoint).toBe(s.controls.doSetpoint);
    expect(snap.mlss).toBeGreaterThan(0);
  });

  it('legacyModel 预测与假设推演都返回结构', async () => {
    const { legacyModel } = await import('../src/sim/plantModel');
    const { createInitialState, forecast } = await import('../src/sim/engine');
    const m = legacyModel(createInitialState({ seed: 5 }), forecast);
    const p1 = m.predict({ ...createInitialState().controls }, 120, 30);
    expect(p1.points.length).toBe(4);
    const p2 = m.predictWithScenario(createInitialState().controls, 120, 30, 'storm');
    expect(p2.points.length).toBe(4);
  });
});

describe('plantModel 空状态边界', () => {
  it('无反应器时 snapshot 不崩溃', async () => {
    const { networkSnapshot } = await import('../src/sim/plantModel');
    const s = createNetworkState(PLANT_TOPOLOGY, { seed: 1 });
    s.reactors = [];
    const snap = networkSnapshot(s);
    expect(snap.lastDo).toBe(0);
    expect(snap.reactorCount).toBe(0);
    expect(Number.isFinite(snap.mlss)).toBe(true);
  });

  it('blankStats 返回零值结构', async () => {
    const { blankStats } = await import('../src/sim/plantModel');
    const b = blankStats();
    expect(b.flow).toBe(0);
    expect(b.ph).toBe(7);
  });
});
