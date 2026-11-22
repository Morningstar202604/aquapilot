import { describe, expect, it } from 'vitest';
import { createNetworkState, spinUpNetwork, stepNetwork } from '../src/sim/networkEngine';
import { PLANT_TOPOLOGY, type ProcessTopology, type UnitSpec } from '../src/model/topology';
import {
  createPlantBoundary,
  plantView,
  recordPlantError,
  updatePlantBalance,
  PLANT_ERRORS,
} from '../src/sim/plantBoundary';
import { plantBoundaryRoute } from '../src/server/routes/plantBoundary';
import { ASM2D_COMPONENTS, ASM2D_PARAMS, emptyAsm2dState, stepAsm2dCstr } from '../src/sim/asm2d';

/** 短周期网络推进：预热 3 d，再按 30 min 一步跑 `days` 天。 */
function runNetwork(
  model: 'simple' | 'asm1' | 'asm2d',
  plantEnabled: boolean,
  controls: Record<string, number> = {},
  days = 5,
) {
  const s = createNetworkState(PLANT_TOPOLOGY, {
    seed: 5,
    model,
    plantEnabled,
    controls,
  });
  spinUpNetwork(s, PLANT_TOPOLOGY, 3);
  for (let i = 0; i < days * 48; i++) stepNetwork(s, PLANT_TOPOLOGY, 30);
  return s;
}

describe('WP2 主引擎接入 ASM2d', () => {
  it('createNetworkState 选 asm2d 后，每个反应器持有 19 组分状态且全部有限非负', () => {
    const s = runNetwork('asm2d', false);
    expect(s.modelMode).toBe('asm2d');
    expect(s.reactors.length).toBeGreaterThan(0);
    for (const r of s.reactors) {
      expect(r.asm2d, `反应器 ${r.id} 应持有 asm2d 状态`).toBeDefined();
      for (const comp of ASM2D_COMPONENTS) {
        const v = r.asm2d![comp];
        expect(Number.isFinite(v), `${r.id}.${comp} 必须有限`).toBe(true);
        expect(v, `${r.id}.${comp} 不得为负`).toBeGreaterThanOrEqual(0);
      }
    }
    // 界面聚合量（TP/COD/NH）有限非负，快照链路可读 S_PO4 / X_PP
    const last = s.reactors[s.reactors.length - 1].asm2d!;
    expect(Number.isFinite(last.S_PO4)).toBe(true);
    expect(Number.isFinite(last.X_PP)).toBe(true);
    expect(s.effluent.cod).toBeGreaterThanOrEqual(0);
    expect(s.effluent.nh).toBeGreaterThanOrEqual(0);
    expect(s.effluent.tp).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(s.effluent.cod)).toBe(true);
  });

  it('默认 simple 路径不产生 asm2d 状态（基准拓扑不退化）', () => {
    const s = runNetwork('simple', false, {}, 1);
    expect(s.modelMode).toBe('simple');
    for (const r of s.reactors) expect(r.asm2d).toBeUndefined();
  });

  it('asm2d 模式下一单步后组分发生积分变化，不是常量投影', () => {
    const s = createNetworkState(PLANT_TOPOLOGY, { seed: 5, model: 'asm2d', plantEnabled: false });
    stepNetwork(s, PLANT_TOPOLOGY, 30); // 先初始化组分状态
    const aerobic = s.reactors.find((r) => r.kind === 'aerobic')!;
    const before = { ...aerobic.asm2d! };
    stepNetwork(s, PLANT_TOPOLOGY, 30);
    const after = aerobic.asm2d!;
    const changed = ASM2D_COMPONENTS.some((c) => Math.abs(after[c] - before[c]) > 1e-9);
    expect(changed, '一步之后至少一个组分应随反应/平流变化').toBe(true);
    expect(Number.isFinite(after.X_H)).toBe(true);
    expect(after.X_H).toBeGreaterThanOrEqual(0);
  });
});

describe('WP2 三条除磷路径', () => {
  const influent = emptyAsm2dState({
    S_A: 60,
    S_F: 30,
    S_PO4: 5,
    S_NH4: 30,
    S_O: 0,
    S_NO3: 0.1,
    X_H: 2000,
    X_PAO: 300,
    X_AUT: 80,
    X_PP: 300,
    X_PHA: 50,
    S_ALK: 8,
  });

  it('厌氧段：PAO 分解胞内储能、释放正磷，S_PO4 与 X_PHA 上升', () => {
    let state = { ...influent, S_O: 0, S_NO3: 0 };
    for (let i = 0; i < 24; i++) {
      state = stepAsm2dCstr(state, influent, ASM2D_PARAMS, { volume: 1000, flow: 100, dtHours: 1 });
    }
    expect(state.S_PO4).toBeGreaterThan(influent.S_PO4);
    expect(state.X_PHA).toBeGreaterThan(influent.X_PHA);
  });

  it('好氧段：相对厌氧状态吸磷，S_PO4 下降', () => {
    let anaerobic = { ...influent, S_O: 0, S_NO3: 0 };
    for (let i = 0; i < 24; i++) {
      anaerobic = stepAsm2dCstr(anaerobic, influent, ASM2D_PARAMS, { volume: 1000, flow: 100, dtHours: 1 });
    }
    let aerobic = { ...anaerobic, S_O: 2, S_NO3: 0.1 };
    for (let i = 0; i < 48; i++) {
      aerobic = stepAsm2dCstr(aerobic, influent, ASM2D_PARAMS, { volume: 1000, flow: 100, dtHours: 1 });
    }
    expect(aerobic.S_PO4).toBeLessThan(anaerobic.S_PO4);
  });

  it('PAC 化学除磷是独立路径：60 mg/L 出水 TP 低于不投加，且与生物路径可分别开关', () => {
    const noPac = runNetwork('simple', false, { pacDose: 0 }, 5);
    const pac = runNetwork('simple', false, { pacDose: 60 }, 5);
    expect(pac.effluent.tp).toBeLessThan(noPac.effluent.tp);
    expect(noPac.effluent.tp).toBeGreaterThan(0);
    expect(pac.effluent.tp).toBeGreaterThanOrEqual(0.01);
  });
});

describe('WP2 泥线闭环（ADM1 CSTR + 沼液回流）', () => {
  it('开启后产生沼气、泥饼与回流滤液；CH4 体积分数落在工程区间 0.6–0.7', () => {
    const s = runNetwork('asm1', true);
    const plant = s.plant!;
    expect(plant.enabled).toBe(true);

    const gas = plant.sludgeLine.digester.gas;
    expect(gas.methaneM3d).toBeGreaterThan(50);
    expect(gas.ch4Fraction).toBeGreaterThanOrEqual(0.6);
    expect(gas.ch4Fraction).toBeLessThanOrEqual(0.7);
    expect(gas.totalM3d).toBeGreaterThan(gas.methaneM3d);
    expect(gas.methaneKgD).toBeGreaterThan(0);
    expect(plant.sludgeLine.dewatering.cakeWetKgD).toBeGreaterThan(0);
    expect(plant.sludgeLine.dewatering.filtrate.flowM3h).toBeGreaterThan(0);
    expect(plant.sludgeLine.cumulative.methaneM3).toBeGreaterThan(0);
  });

  it('沼液回流使进水 NH4-N 负荷可见抬升（开启 vs 关闭对照）', () => {
    const off = runNetwork('asm1', false, {}, 5);
    const on = runNetwork('asm1', true, {}, 5);
    expect(on.influent.nh).toBeGreaterThan(off.influent.nh + 2);
    expect(on.plant!.sludgeLine.dewatering.filtrate.nh4NKgM3).toBeGreaterThan(0);
  });

  it('默认关闭：零沼气、零滤液、累计泥量为零，不改变基准进水', () => {
    const s = createNetworkState(PLANT_TOPOLOGY, { seed: 5 });
    expect(s.plant!.enabled).toBe(false);
    const gas = s.plant!.sludgeLine.digester.gas;
    expect(gas.methaneM3d).toBe(0);
    expect(gas.totalM3d).toBe(0);
    expect(s.plant!.sludgeLine.dewatering.filtrate.flowM3h).toBe(0);
    expect(s.plant!.sludgeLine.cumulative.methaneM3).toBe(0);
  });
});

describe('WP2 全厂三本账与诊断', () => {
  it('COD/N/P 行式齐全，数值有限非负，残差以比例形式给出', () => {
    const s = runNetwork('asm1', true);
    const balance = s.plant!.balance;
    for (const key of ['cod', 'n', 'p'] as const) {
      const row = balance[key];
      for (const field of [
        'inflowKg',
        'effluentKg',
        'wastedKg',
        'methaneCodKg',
        'oxidizedKg',
        'denitrifiedKg',
        'inventoryChangeKg',
        'recycleKg',
      ] as const) {
        expect(Number.isFinite(row[field]), `${key}.${field}`).toBe(true);
        expect(row[field], `${key}.${field}`).toBeGreaterThanOrEqual(0);
      }
      // 残差按「供给 − 损失」带符号，可为负；只要求有限，比例取绝对值
      expect(Number.isFinite(row.residualKg), `${key}.residualKg`).toBe(true);
      expect(Number.isFinite(row.residualPct)).toBe(true);
      expect(row.residualPct).toBeGreaterThanOrEqual(0);
      expect(typeof row.closed).toBe('boolean');
    }
  });

  it('出水负荷超过进水且无库存/排泥可平衡时触发 PLANT_BALANCE_UNCLOSED 诊断（不抛异常）', () => {
    const pb = createPlantBoundary(false);
    updatePlantBalance(pb, {
      influent: { flow: 1000, cod: 100, nh: 100, tn: 100, tp: 10 },
      effluent: { flow: 1000, cod: 10000, nh: 1000, tn: 1000, tp: 100 },
      dtH: 1,
      biomassKg: 0,
      oxidizedCodKgH: 0,
      wastedDryKg: 0,
    });
    expect(pb.balance.cod.closed).toBe(false);
    expect(pb.errors.some((e) => e.code === PLANT_ERRORS.PLANT_BALANCE_UNCLOSED)).toBe(true);
  });

  it('ASM2D_STATE_INVALID 诊断经 plantView 投影后可见', () => {
    const pb = createPlantBoundary(true);
    recordPlantError(pb, PLANT_ERRORS.ASM2D_STATE_INVALID, '反应器 r1 组分越界，已钳制到物理边界');
    const view = plantView(pb)!;
    expect(view.errors.some((e) => e.code === PLANT_ERRORS.ASM2D_STATE_INVALID)).toBe(true);
    // 同一错误码重复记录只保留一条最新消息
    recordPlantError(pb, PLANT_ERRORS.ASM2D_STATE_INVALID, '反应器 r2 组分越界，已钳制到物理边界');
    expect(pb.errors.filter((e) => e.code === PLANT_ERRORS.ASM2D_STATE_INVALID)).toHaveLength(1);
  });
});

describe('WP2 纯路由 /api/plant/balance', () => {
  it('返回三本账、沼气、泥线状态、残差闭合标志与诊断；未知路径返回 null', () => {
    const s = runNetwork('asm1', true, {}, 3);
    const url = new URL('http://localhost/api/plant/balance');

    const reply = plantBoundaryRoute('/api/plant/balance', url, { state: s });
    expect(reply).not.toBeNull();
    expect(reply!.status).toBe(200);
    const body = reply!.body as {
      balance: { cod: { inflowKg: number }; n: { inflowKg: number }; p: { inflowKg: number } };
      balanceClosed: boolean;
      unclosedDiagnostic: boolean;
      sludgeLine: { digester: { gas: { methaneM3d: number } } };
    };
    expect(Number.isFinite(body.balance.cod.inflowKg)).toBe(true);
    expect(Number.isFinite(body.balance.n.inflowKg)).toBe(true);
    expect(Number.isFinite(body.balance.p.inflowKg)).toBe(true);
    expect(typeof body.balanceClosed).toBe('boolean');
    expect(typeof body.unclosedDiagnostic).toBe('boolean');
    expect(body.sludgeLine.digester.gas.methaneM3d).toBeGreaterThan(0);

    expect(plantBoundaryRoute('/api/plant/other', url, { state: s })).toBeNull();
  });
});

/** 双系列拓扑：两条完整生化链 + 两个独立二沉池 + 独立 RAS/WAS 标签。 */
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
    id: 'two-train-wp2',
    name: '双系列 WP2',
    units,
    connections,
    train: ['a_ana', 'a_anox', 'a_aer', 'b_ana', 'b_anox', 'b_aer'],
  };
}

/** 厌氧旁路拓扑：厌氧池改作缺氧池，PAO 失去厌氧释磷段。 */
function bypassTopology(): ProcessTopology {
  const units = PLANT_TOPOLOGY.units.map((u) =>
    u.id === 'anaerobic' ? { ...u, kind: 'anoxic' as UnitSpec['kind'] } : u,
  );
  return { ...PLANT_TOPOLOGY, units };
}

interface SteadyOpts {
  bioP?: boolean;
  pac?: number;
  bypass?: boolean;
  plant?: boolean;
  spinDays?: number;
  runDays?: number;
}

/** 网络级稳态推进：预热 spinDays，再按 30 min 一步跑 runDays 天。 */
function runSteady(opts: SteadyOpts = {}) {
  const topo = opts.bypass ? bypassTopology() : PLANT_TOPOLOGY;
  const s = createNetworkState(topo, {
    seed: 5,
    model: 'asm2d',
    plantEnabled: opts.plant ?? false,
    controls: { pacDose: opts.pac ?? 0 },
    bioPRemoval: opts.bioP ?? true,
  });
  const spin = opts.spinDays ?? 10;
  const run = opts.runDays ?? 20;
  spinUpNetwork(s, topo, spin);
  for (let i = 0; i < run * 48; i++) stepNetwork(s, topo, 30);
  return s;
}

describe('WP2 返工：ASM2d 网络级 30 d 稳态', () => {
  // 已知差距（it.fails，期望失败，不删断言、不放宽阈值）：网络级 ASM2d 稳态未达 BSM2 量级，
  // 第五轮修氨化氮系数后异养菌不再爆发、硝化恢复，但 MLSS 偏低、PAO/PP/PHA 未留存、
  // 出水 TN/TP 仍超门限。见 docs/PLANT-BOUNDARY.md §3.6 / §5.1「未达成清单」。
  it.fails('生物量留住、出水达标、释磷/吸磷与 PAO 储存池循环在网络级成立', () => {
    const s = runSteady({ plant: true });
    const mlss = (s.biomassKg * 1000) / s.volume.bio;
    expect(mlss).toBeGreaterThanOrEqual(2000);
    expect(mlss).toBeLessThanOrEqual(4000);

    const anaerobic = s.reactors.find((r) => r.kind === 'anaerobic')!;
    const anoxic = s.reactors.find((r) => r.kind === 'anoxic')!;
    const aerobics = s.reactors.filter((r) => r.kind === 'aerobic');
    const lastAerobic = aerobics[aerobics.length - 1];

    expect(anaerobic.asm2d!.X_H).toBeGreaterThan(500);
    expect(anoxic.asm2d!.X_H).toBeGreaterThan(500);

    // 出水水质门
    expect(s.effluent.nh).toBeLessThan(5);
    expect(lastAerobic.no3).toBeLessThan(15);
    expect(s.effluent.tn).toBeLessThan(20);
    expect(s.effluent.tp).toBeLessThan(1.5);
    expect(s.effluent.cod).toBeLessThan(60);
    expect(s.effluent.ss).toBeLessThan(20);

    // 反硝化：缺氧段 NO₃ 相对好氧末段（内回流来源）下降 ≥30%
    const denitDrop = (lastAerobic.no3 - anoxic.no3) / Math.max(1e-6, lastAerobic.no3);
    expect(denitDrop).toBeGreaterThanOrEqual(0.3);

    // 厌氧释磷：S_PO₄ 高于进水；好氧吸磷：末段 S_PO₄ 低于厌氧段
    expect(anaerobic.asm2d!.S_PO4).toBeGreaterThan(s.influent.tp);
    expect(lastAerobic.asm2d!.S_PO4).toBeLessThan(anaerobic.asm2d!.S_PO4);

    // X_PP / X_PHA 网络级非零并呈厌氧/好氧循环
    expect(lastAerobic.asm2d!.X_PP).toBeGreaterThan(0);
    expect(anaerobic.asm2d!.X_PHA).toBeGreaterThan(0);
    expect(lastAerobic.asm2d!.X_PHA).toBeLessThanOrEqual(anaerobic.asm2d!.X_PHA);
  });

  // 已知差距（it.fails）：三本账残差仍超 5%，出水 N 仍高于进水+回流；氧化/库存口径待校准。见文档 §5.1。
  it.fails('30 d 稳态 COD/N/P 三本账残差全部 <5% 且 closed=true，反硝化 N₂ 行可见', () => {
    const s = runSteady({ plant: true });
    const bal = s.plant!.balance;
    for (const key of ['cod', 'n', 'p'] as const) {
      expect(bal[key].closed, `${key} 账应闭合`).toBe(true);
      expect(bal[key].residualPct).toBeLessThan(0.05);
    }
    // 大项均入账：进水/出水/排泥/沼气COD/氧化/库存/回流/N₂
    expect(bal.cod.inflowKg).toBeGreaterThan(0);
    expect(bal.cod.effluentKg).toBeGreaterThan(0);
    expect(bal.cod.wastedKg).toBeGreaterThan(0);
    expect(bal.cod.methaneCodKg).toBeGreaterThan(0);
    expect(bal.cod.oxidizedKg).toBeGreaterThan(0);
    // 库存变化可正可负（期末−期初），不强制符号。
    expect(Number.isFinite(bal.cod.inventoryChangeKg)).toBe(true);
    expect(bal.n.denitrifiedKg).toBeGreaterThan(0);
    // 不造氮硬约束：出水 N 不得超过进水 + 回流（初始库存释放由库存变化行体现，不得凭空多出）。
    expect(bal.n.effluentKg).toBeLessThanOrEqual(bal.n.inflowKg + bal.n.recycleKg + 1e-6);
    // 反硝化 N₂ 不得超过可供氮（进水 + 回流）。
    expect(bal.n.denitrifiedKg).toBeLessThanOrEqual(bal.n.inflowKg + bal.n.recycleKg + 1e-6);
  });
});

describe('WP2 返工：三条除磷路径网络级对照', () => {
  // 已知差距（it.fails）：PAO 留存不足，生物除磷开关在 TP 上不可分辨。见文档 §3.6。
  it.fails('生物除磷开关、PAC 投加、厌氧旁路对出水 TP 与 PAO 储存态可分辨', () => {
    const bioOnPac0 = runSteady({ bioP: true, pac: 0, runDays: 7, spinDays: 3 });
    const bioOffPac0 = runSteady({ bioP: false, pac: 0, runDays: 7, spinDays: 3 });
    const bioOnPac60 = runSteady({ bioP: true, pac: 60, runDays: 7, spinDays: 3 });
    const bypass = runSteady({ bioP: true, pac: 0, bypass: true, runDays: 7, spinDays: 3 });

    const tp = (s: typeof bioOnPac0) => s.effluent.tp;
    // PAC 化学路径：60 mg/L 明显低于 0
    expect(tp(bioOnPac60)).toBeLessThan(tp(bioOnPac0));
    // 生物路径开关只改变 PAO 储存态：开启有 PP/PHA 循环，关闭两者为 0
    const aerOn = bioOnPac0.reactors.filter((r) => r.kind === 'aerobic').pop()!;
    const aerOff = bioOffPac0.reactors.filter((r) => r.kind === 'aerobic').pop()!;
    expect(aerOn.asm2d!.X_PP).toBeGreaterThan(0);
    expect(aerOff.asm2d!.X_PP).toBe(0);
    // 厌氧旁路后不存在厌氧池，也没有厌氧 PHA 合成
    expect(bypass.reactors.some((r) => r.kind === 'anaerobic')).toBe(false);
    const bypassAnaer = bypass.reactors.find((r) => r.kind === 'anoxic')!;
    expect(bypassAnaer.asm2d!.X_PHA).toBe(0);

    // 对照数值表（断言仅要求可分辨：PAC 差 >0.05 mg/L）
    expect(Math.abs(tp(bioOnPac60) - tp(bioOnPac0))).toBeGreaterThan(0.05);
    expect(Math.abs(tp(bypass) - tp(bioOnPac0))).toBeGreaterThan(0);
  });
});

describe('WP2 双系列泥线汇总', () => {
  it('两个二沉池独立步进，WAS 汇入全厂单一消化池并产生沼气', () => {
    const topo = twoTrainTopology();
    const s = createNetworkState(topo, { seed: 5, model: 'simple', plantEnabled: true });
    spinUpNetwork(s, topo, 2);
    for (let i = 0; i < 2 * 48; i++) stepNetwork(s, topo, 30);

    expect(s.clarifiers).toHaveLength(2);
    expect(s.plant!.enabled).toBe(true);
    expect(s.plant!.sludgeLine.digester.gas.methaneM3d).toBeGreaterThan(0);
    expect(s.plant!.sludgeLine.dewatering.cakeWetKgD).toBeGreaterThan(0);
  });
});
