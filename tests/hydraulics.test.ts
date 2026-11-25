import { describe, expect, it } from 'vitest';
import { PLANT_TOPOLOGY, type ProcessTopology, type UnitSpec } from '../src/model/topology';
import { compileNetwork, resolveFlows } from '../src/sim/network';
import {
  HYDRAULICS_ERRORS,
  branchHydraulics,
  createHydraulics,
  deriveEdgeGeometry,
  diameterForFlow,
  hydraulicView,
  injectTracer,
  pumpHead,
  refreshRtdMetrics,
  splitByResistance,
  stepHydraulics,
  tracerMassBalance,
  valveFlow,
  weirFlow,
  type EdgeGeometry,
} from '../src/sim/hydraulics';
import { createNetworkState, spinUpNetwork, stepNetwork } from '../src/sim/networkEngine';
import { hydraulicsRoute } from '../src/server/routes/hydraulics';

/** 阻力分流：同流量下阀位不同 → 份额不同，总量守恒 */
describe('WP3 阻力分流', () => {
  it('等阻力支路退化为均分（旧语义回归）', () => {
    const out = splitByResistance(100, [
      { edgeId: 'a', resistance: 1, closed: false, capacityM3h: Infinity },
      { edgeId: 'b', resistance: 1, closed: false, capacityM3h: Infinity },
    ]);
    expect(out.status).toBe('ok');
    expect(out.flows[0]).toBeCloseTo(50, 6);
    expect(out.flows[1]).toBeCloseTo(50, 6);
    expect(out.flows.reduce((s, f) => s + f, 0)).toBeCloseTo(100, 9);
  });

  it('阀位 30% 的支路份额小于 70% 支路，且总量守恒', () => {
    const geo30 = deriveEdgeGeometry({ valveOpen: 0.3 }, undefined);
    const geo70 = deriveEdgeGeometry({ valveOpen: 0.7 }, undefined);
    const br30 = branchHydraulics(geo30, 1000, 1000);
    const br70 = branchHydraulics(geo70, 1000, 1000);
    const out = splitByResistance(1000, [
      { edgeId: 'narrow', resistance: br30.resistance, closed: br30.closed, capacityM3h: br30.capacityM3h },
      { edgeId: 'wide', resistance: br70.resistance, closed: br70.closed, capacityM3h: br70.capacityM3h },
    ]);
    expect(out.status).toBe('ok');
    expect(out.flows[0]).toBeLessThan(out.flows[1]);
    expect(out.flows.reduce((s, f) => s + f, 0)).toBeCloseTo(1000, 6);
    // 低开度支路阻力更高
    expect(br30.resistance).toBeGreaterThan(br70.resistance);
  });

  it('阀全关时开放支路独吞流量；全支路关闭返回 UNSOLVABLE_SPLIT', () => {
    const oneClosed = splitByResistance(80, [
      { edgeId: 'a', resistance: Infinity, closed: true, capacityM3h: Infinity },
      { edgeId: 'b', resistance: 1, closed: false, capacityM3h: Infinity },
    ]);
    expect(oneClosed.flows[0]).toBe(0);
    expect(oneClosed.flows[1]).toBeCloseTo(80, 6);

    const allClosed = splitByResistance(80, [
      { edgeId: 'a', resistance: Infinity, closed: true, capacityM3h: Infinity },
      { edgeId: 'b', resistance: Infinity, closed: true, capacityM3h: Infinity },
    ]);
    expect(allClosed.status).toBe('unsolvable');
    expect(allClosed.errorCode).toBe(HYDRAULICS_ERRORS.UNSOLVABLE_SPLIT);
  });

  it('支路能力封顶后余量在未封顶支路间重分，总量守恒', () => {
    const total = 478.95815148949623;
    const out = splitByResistance(total, [
      { edgeId: 'b0', resistance: 3.9154343579888664, closed: false, capacityM3h: Infinity },
      { edgeId: 'b1', resistance: 0.01272132208181067, closed: false, capacityM3h: 373.8579474296421 },
      { edgeId: 'b2', resistance: 38.60422341225238, closed: false, capacityM3h: 344.07467459794134 },
    ]);
    expect(out.status).toBe('ok');
    expect(out.flows[1]).toBeCloseTo(373.8579474296421, 9);
    expect(out.flows.reduce((s, f) => s + f, 0)).toBeCloseTo(total, 9);
    expect(out.flows[0]).toBeLessThan(80);
    expect(out.flows[2]).toBeLessThan(30);
  });

  it('全部支路能力不足时返回 UNSOLVABLE_SPLIT，不静默丢流量', () => {
    const out = splitByResistance(100, [
      { edgeId: 'a', resistance: 1, closed: false, capacityM3h: 20 },
      { edgeId: 'b', resistance: 1, closed: false, capacityM3h: 20 },
    ]);
    expect(out.status).toBe('unsolvable');
    expect(out.errorCode).toBe(HYDRAULICS_ERRORS.UNSOLVABLE_SPLIT);
    expect(out.flows).toEqual([20, 20]);
  });

  it('泵超出 H-Q 曲线判为 overCurve，阀全关流量为 0', () => {
    const curve = { head0M: 18, k: 2.4e-5, rpm: 1450, ratedRpm: 1450 };
    const ok = pumpHead(curve, 500);
    const over = pumpHead(curve, ok.maxFlowM3h * 1.5);
    expect(ok.overCurve).toBe(false);
    expect(over.overCurve).toBe(true);

    const closed = valveFlow(120, 0.01, 2);
    expect(closed.closed).toBe(true);
    expect(closed.flowM3h).toBe(0);
    const open = valveFlow(120, 0.8, 2);
    expect(open.closed).toBe(false);
    expect(open.flowM3h).toBeGreaterThan(0);
  });

  it('矩形堰与 V 形三角堰 Q-H 单调，超高水位记溢流', () => {
    const rect = weirFlow(1.0, 'rectangular', 0.2);
    const rectHigh = weirFlow(1.0, 'rectangular', 0.6);
    expect(rect.flowM3h).toBeGreaterThan(0);
    expect(rectHigh.overflow).toBe(true);
    const v = weirFlow(1.0, 'v-notch', 0.2);
    expect(v.flowM3h).toBeGreaterThan(0);
  });

  it('无几何信息时按目标流速反推管径，钳制在合理区间', () => {
    const d = diameterForFlow(2000, 1.2);
    expect(d).toBeGreaterThanOrEqual(100);
    expect(d).toBeLessThanOrEqual(2000);
    const geo: EdgeGeometry = deriveEdgeGeometry(undefined, undefined);
    expect(geo.targetVelocityMps).toBeGreaterThanOrEqual(1.0);
    expect(geo.targetVelocityMps).toBeLessThanOrEqual(1.5);
  });
});

/** 管渠容积、输运延迟与示踪剂 RTD */
describe('WP3 管段输运与示踪剂 RTD', () => {
  function singleEdgeState(volumeM3: number, flowM3h: number) {
    const net = compileNetwork(PLANT_TOPOLOGY);
    const h = createHydraulics(net, flowM3h);
    const edge = h.edges.find((e) => e.stream === 'mixed_liquor')!;
    // 显式给定管径（避免 0 管径走流速反推时与手工管长不自洽），再按目标容积反推管长
    edge.geometry.diameterMm = 500;
    const area = (Math.PI * Math.pow(edge.geometry.diameterMm / 1000, 2)) / 4;
    edge.geometry.lengthM = volumeM3 / area;
    const br = branchHydraulics(edge.geometry, flowM3h, flowM3h);
    edge.volumeM3 = br.volumeM3;
    edge.residenceMin = br.residenceMin;
    return { net, h, edge, volumeM3, flowM3h };
  }

  it('脉冲示踪：出口出现峰值，平均停留时间 ≈ V/Q，方差大于 0', () => {
    const volumeM3 = 30;
    const flowM3h = 600;
    const { net, h, edge, volumeM3: V, flowM3h: Q } = singleEdgeState(volumeM3, flowM3h);
    const expectedThetaMin = (V / Q) * 60;

    injectTracer(h, edge.id, 30, Q); // 30 kg / 30 m³ = 1000 mg/L
    const flows = new Map([[edge.id, Q]]);
    for (let i = 1; i <= 40; i++) {
      stepHydraulics(h, net, { flows, dtMin: 1, timeMin: i, outletEdgeIds: [edge.id] });
      refreshRtdMetrics(h, 1);
    }

    expect(h.tracer.active).toBe(true);
    expect(h.tracer.peakC).toBeGreaterThan(0);
    expect(h.tracer.meanResidenceMin).toBeGreaterThan(expectedThetaMin * 0.5);
    expect(h.tracer.meanResidenceMin).toBeLessThan(expectedThetaMin * 1.8);
    expect(h.tracer.varianceMin2).toBeGreaterThan(0);
  });

  it('管段质量守恒：注入量 ≈ 存留 + 排出，残差在容差内', () => {
    const volumeM3 = 20;
    const flowM3h = 300;
    const { net, h, edge, volumeM3: V, flowM3h: Q } = singleEdgeState(volumeM3, flowM3h);
    injectTracer(h, edge.id, 20, Q);
    const flows = new Map([[edge.id, Q]]);
    // 跑足 5 倍停留时间，示踪剂基本排空
    const thetaMin = (V / Q) * 60;
    for (let i = 1; i <= Math.ceil(thetaMin * 5); i++) {
      stepHydraulics(h, net, { flows, dtMin: 1, timeMin: i, outletEdgeIds: [edge.id] });
    }
    refreshRtdMetrics(h, 1);
    const balance = tracerMassBalance(h);
    expect(balance.injectedKg).toBeCloseTo(20, 6);
    expect(Math.abs(balance.balanceResidualKg)).toBeLessThan(20 * 0.08);
    expect(balance.dischargedKg).toBeGreaterThan(0);
  });

  it('示踪剂超上限与未知边返回显式错误码，不出 NaN', () => {
    const net = compileNetwork(PLANT_TOPOLOGY);
    const h = createHydraulics(net, 1000);
    injectTracer(h, 'no-such-edge', 1, 1000);
    expect(h.errors.some((e) => e.code === HYDRAULICS_ERRORS.INVALID_GEOMETRY)).toBe(true);

    const edge = h.edges[0];
    injectTracer(h, edge.id, 1_000_000, 1000);
    expect(h.errors.some((e) => e.code === HYDRAULICS_ERRORS.TRACER_OVERFLOW)).toBe(true);
    expect(h.tracer.active).toBe(false);
    for (const e of h.edges) {
      for (const c of e.tracerSegments) expect(Number.isFinite(c)).toBe(true);
    }
  });
});

/** 多系列：两条完整链 + 独立二沉池 + 独立 RAS/WAS 标签 */
describe('WP3 多系列', () => {
  function trainReactor(id: string, kind: UnitSpec['kind'], volume: number): UnitSpec {
    return {
      id,
      kind,
      name: id,
      role: '',
      volume,
      ports: [
        { id: 'in', kind: 'in', stream: 'mixed_liquor' },
        { id: 'out', kind: 'out', stream: 'mixed_liquor' },
      ],
    };
  }

  function twoTrainTopology(): ProcessTopology {
    const units: UnitSpec[] = [
      { id: 'inlet', kind: 'inlet', name: '进水', role: '', ports: [{ id: 'out', kind: 'out', stream: 'influent' }] },
      trainReactor('a_ana', 'anaerobic', 3000),
      trainReactor('a_anox', 'anoxic', 4500),
      trainReactor('a_aer', 'aerobic', 5750),
      trainReactor('b_ana', 'anaerobic', 3000),
      trainReactor('b_anox', 'anoxic', 4500),
      trainReactor('b_aer', 'aerobic', 5750),
    ];
    for (const [cid, label] of [
      ['clarA', 'A'],
      ['clarB', 'B'],
    ] as const) {
      units.push({
        id: cid,
        kind: 'clarifier',
        name: `二沉池${label}`,
        role: '',
        area: 2000,
        depth: 4,
        ports: [
          { id: 'in', kind: 'in', stream: 'mixed_liquor' },
          { id: 'out', kind: 'out', stream: 'effluent' },
          { id: 'ras', kind: 'out', stream: 'return_activated_sludge' },
          { id: 'was', kind: 'out', stream: 'waste_sludge' },
        ],
      });
    }
    const connections: ProcessTopology['connections'] = [
      {
        id: 'in-a',
        from: { unit: 'inlet', port: 'out' },
        to: { unit: 'a_ana', port: 'in' },
        stream: 'influent',
        flowRef: 'influentFlow',
      },
      {
        id: 'in-b',
        from: { unit: 'inlet', port: 'out' },
        to: { unit: 'b_ana', port: 'in' },
        stream: 'influent',
        flowRef: 'influentFlow',
      },
      { id: 'a1', from: { unit: 'a_ana', port: 'out' }, to: { unit: 'a_anox', port: 'in' }, stream: 'mixed_liquor' },
      { id: 'a2', from: { unit: 'a_anox', port: 'out' }, to: { unit: 'a_aer', port: 'in' }, stream: 'mixed_liquor' },
      { id: 'a3', from: { unit: 'a_aer', port: 'out' }, to: { unit: 'clarA', port: 'in' }, stream: 'mixed_liquor' },
      { id: 'b1', from: { unit: 'b_ana', port: 'out' }, to: { unit: 'b_anox', port: 'in' }, stream: 'mixed_liquor' },
      { id: 'b2', from: { unit: 'b_anox', port: 'out' }, to: { unit: 'b_aer', port: 'in' }, stream: 'mixed_liquor' },
      { id: 'b3', from: { unit: 'b_aer', port: 'out' }, to: { unit: 'clarB', port: 'in' }, stream: 'mixed_liquor' },
      {
        id: 'rasA',
        from: { unit: 'clarA', port: 'ras' },
        to: { unit: 'a_ana', port: 'in' },
        stream: 'return_activated_sludge',
        recycle: true,
      },
      {
        id: 'rasB',
        from: { unit: 'clarB', port: 'ras' },
        to: { unit: 'b_ana', port: 'in' },
        stream: 'return_activated_sludge',
        recycle: true,
      },
      {
        id: 'wasA',
        from: { unit: 'clarA', port: 'was' },
        to: { unit: 'a_anox', port: 'in' },
        stream: 'waste_sludge',
        recycle: true,
      },
      {
        id: 'wasB',
        from: { unit: 'clarB', port: 'was' },
        to: { unit: 'b_anox', port: 'in' },
        stream: 'waste_sludge',
        recycle: true,
      },
    ];
    return {
      id: 'two-train',
      name: '双系列',
      units,
      connections,
      train: ['a_ana', 'a_anox', 'a_aer', 'b_ana', 'b_anox', 'b_aer'],
    };
  }

  it('编译出两条系列、两个二沉池，RAS/WAS 按系列独立定值', () => {
    const topo = twoTrainTopology();
    const net = compileNetwork(topo);
    expect(net.problems).toEqual([]);
    expect(net.trains).toHaveLength(2);
    expect(net.clarifiers).toHaveLength(2);
    const trainA = net.trains.find((t) => t.clarifierId === 'clarA')!;
    const trainB = net.trains.find((t) => t.clarifierId === 'clarB')!;
    expect(trainA.reactorIds).toEqual(['a_ana', 'a_anox', 'a_aer']);
    expect(trainB.reactorIds).toEqual(['b_ana', 'b_anox', 'b_aer']);

    const f = resolveFlows(net, 1500, { ras: 0.8, ir: 2.0, was: 0.01 });
    // 两个主进水头均分 1500 → 每系列 750
    expect(f.edgeFlow.get('in-a')).toBeCloseTo(750, 6);
    expect(f.edgeFlow.get('in-b')).toBeCloseTo(750, 6);
    // 各系列 RAS = 本系列进水 × 0.8；WAS = 本系列进水 × 0.01
    expect(f.edgeFlow.get('rasA')).toBeCloseTo(750 * 0.8, 6);
    expect(f.edgeFlow.get('rasB')).toBeCloseTo(750 * 0.8, 6);
    expect(f.edgeFlow.get('wasA')).toBeCloseTo(750 * 0.01, 6);
    expect(f.edgeFlow.get('wasB')).toBeCloseTo(750 * 0.01, 6);
  });

  it('网络级集成：双系列可预热、可步进，二沉池与水力学状态独立且无数值异常', () => {
    const topo = twoTrainTopology();
    const s = createNetworkState(topo, { seed: 11 });
    expect(s.clarifiers).toHaveLength(2);
    expect(s.hydraulics).toBeDefined();
    spinUpNetwork(s, topo, 5);
    for (let i = 0; i < 20; i++) stepNetwork(s, topo, 1);
    expect(s.clarifiers).toHaveLength(2);
    for (const c of s.clarifiers!) {
      expect(Number.isFinite(c.xRas)).toBe(true);
      expect(Number.isFinite(c.xEff)).toBe(true);
    }
    for (const e of s.hydraulics!.edges) {
      expect(Number.isFinite(e.flowM3h)).toBe(true);
      expect(e.flowM3h).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(e.residenceMin)).toBe(true);
    }
    const view = hydraulicView(s.hydraulics);
    expect(view).toBeDefined();
    expect(view!.trains).toHaveLength(2);
  });
});

/** 单系列回归与快照/路由可见性 */
describe('WP3 单系列回归与路由', () => {
  it('单系列编译为一条 train，水力学视图字段齐全', () => {
    const net = compileNetwork(PLANT_TOPOLOGY);
    expect(net.trains).toHaveLength(1);
    expect(net.clarifiers).toHaveLength(1);
    const s = createNetworkState(PLANT_TOPOLOGY, { seed: 5 });
    const view = hydraulicView(s.hydraulics);
    expect(view).toBeDefined();
    expect(view!.edgeCount).toBe(s.hydraulics!.edges.length);
    for (const e of view!.edges) {
      expect(Number.isFinite(e.flowM3h)).toBe(true);
      expect(Number.isFinite(e.residenceMin)).toBe(true);
      expect(['ok', 'closed', 'pump_over_curve', 'weir_overflow', 'no_flow']).toContain(e.status);
    }
  });

  it('网络级步进后水力学状态仍有限、非负', () => {
    const s = createNetworkState(PLANT_TOPOLOGY, { seed: 5 });
    for (let i = 0; i < 60; i++) stepNetwork(s, PLANT_TOPOLOGY, 1);
    for (const e of s.hydraulics!.edges) {
      expect(Number.isFinite(e.flowM3h)).toBe(true);
      expect(e.flowM3h).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(e.volumeM3)).toBe(true);
    }
  });

  it('路由：/api/hydraulics 与 /api/hydraulics/tracer 返回结构化诊断，未知边 404', () => {
    const s = createNetworkState(PLANT_TOPOLOGY, { seed: 5 });
    const url = new URL('http://localhost/api/hydraulics');
    const reply = hydraulicsRoute('/api/hydraulics', url, { state: s });
    expect(reply?.status).toBe(200);
    const body = reply?.body as { edges: unknown[]; edgeCount: number };
    expect(body.edges.length).toBe(body.edgeCount);

    const tracer = hydraulicsRoute('/api/hydraulics/tracer', new URL('http://localhost/api/hydraulics/tracer'), {
      state: s,
    });
    expect(tracer?.status).toBe(200);
    expect((tracer?.body as { active: boolean }).active).toBe(false);

    const unknown = hydraulicsRoute('/api/hydraulics', new URL('http://localhost/api/hydraulics?edge=nope'), {
      state: s,
    });
    expect(unknown?.status).toBe(404);
    expect((unknown?.body as { code: string }).code).toBe(HYDRAULICS_ERRORS.INVALID_GEOMETRY);

    const empty = hydraulicsRoute('/api/hydraulics', new URL('http://localhost/api/hydraulics?edge='), { state: s });
    expect(empty?.status).toBe(400);

    expect(hydraulicsRoute('/api/other', url, { state: s })).toBeNull();
  });
});
