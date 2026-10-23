import { ASM1_PARAMS, emptyAsm1State, reactionRates, type Asm1Params, type Asm1State } from './asm1';
import { BSM1_INFLUENT } from './asm1Cstr';
import { BSM1_SETTLER, createSettler, stepSettler, type SettlerState } from './takacs';

/**
 * BSM1（Benchmark Simulation Model No.1）开环稳态基准。
 *
 * 目的：把本项目已有的 ASM1 组态（asm1.ts）与 Takács 沉降器（takacs.ts）
 * 按 IWA BSM1 技术报告的默认配置装成五池厂，跑出稳态并与报告 Table 6
 * 公开值逐项对照。这是 QUALITY-ROADMAP §A1 规定的"唯一不可绕过"的
 * 外部验证步骤。
 *
 * 开环默认操纵量（技术报告 §4，已核实）：
 *   Qintr = 55 338 m³/d（内回流，固定）
 *   KLa(3) = KLa(4) = 10 h⁻¹ = 240 d⁻¹（固定）
 *   KLa(5) = 3.5 h⁻¹ = 84 d⁻¹（固定）
 *   DO 饱和浓度 8 gO₂/m³
 *
 * 模型细节与报告一致：
 *   TSS = 0.75 × (X_I + X_S + X_B_H + X_B_A + X_P)（X_ND 不计入，
 *         与报告进水 TSS 211.2675 = 0.75 × 281.69 逐位吻合）
 *   二沉池非反应性：溶解性组分原样通过，颗粒组分按沉降器 TSS 剖面
 *         比例劈分（与报告 RAS/出水组分比例 1.9556 的构成方式一致）。
 */

export const BSM1_PLANT = {
  /** 五池容积 m³：2 缺氧 + 3 好氧（报告 Table 2.1） */
  tankVolumesM3: [1000, 1000, 1333, 1333, 1333],
  /** 体积传氧系数 d⁻¹：开环默认 3/4 池 240，5 池 84；缺氧池为 0 */
  klaPerDay: [0, 0, 240, 240, 84],
  /** DO 饱和浓度 gO₂/m³ */
  oxygenSaturation: 8,
  /** 干季平均进水 m³/d */
  influentFlowM3d: 18446,
  /** 内回流（5 池 → 1 池）m³/d，开环固定 */
  internalRecycleM3d: 55338,
  /** 污泥回流（二沉池底流 → 1 池）m³/d */
  returnSludgeM3d: 18446,
  /** 剩余污泥（自二沉池底流排出）m³/d */
  wasteSludgeM3d: 385,
  settler: { ...BSM1_SETTLER, area: 1500, depth: 4 },
} as const;

/**
 * BSM1 官方参数集（Henze et al. 1987 原始 ASM1 参数，即 IWA 基准采用的数值；
 * 温度系数取 BSM1 技术报告表值）。
 *
 * 为什么不是 asm1.ts 里的 IWA-1999 典型集：那套参数（μ_H 6、μ_A 0.8、K_X 0.03、
 * η_h 0.4）在官方稳态上算出的吸氧量约为 KLa 传氧量的 1.8 倍，官方 Table 6
 * 根本不可能维持；换成本参数集后 R3 氧衡算闭合到 1.4%（实测见审计报告）。
 * 参数集与模型结构是配套的，对照基准必须用基准自己的参数。
 */
export const BSM1_ASM1_PARAMS: Asm1Params = {
  ...ASM1_PARAMS,
  Y_H: 0.67,
  Y_A: 0.24,
  f_P: 0.08,
  i_XB: 0.08,
  i_XP: 0.06,
  mu_H: 4.0,
  K_S: 10.0,
  K_O_H: 0.2,
  K_NO: 0.5,
  b_H: 0.3,
  eta_g: 0.8,
  eta_h: 0.8,
  mu_A: 0.5,
  K_NH: 1.0,
  K_O_A: 0.4,
  b_A: 0.05,
  k_a: 0.05,
  k_h: 3.0,
  K_X: 0.1,
  theta_mu_H: 1.066,
  theta_b_H: 1.029,
  theta_mu_A: 1.103,
  theta_b_A: 1.045,
  theta_k_h: 1.116,
  theta_k_a: 1.116,
};

/** 技术 Report Table 6 开环稳态出水（多平台交叉一致：Matlab/GPS-X/FORTRAN/SIMBA/WEST） */
export const BSM1_TABLE6_EFFLUENT = {
  S_I: 30.0,
  S_S: 0.889,
  X_I: 4.39,
  X_S: 0.188,
  X_B_H: 9.78,
  X_B_A: 0.573,
  X_P: 1.728,
  S_O: 0.491,
  S_NO: 10.415,
  S_NH: 1.733,
  S_ND: 0.688,
  X_ND: 0.013,
  S_ALK: 4.13,
  tss: 12.5,
} as const;

/** 颗粒性组分（沉降器劈分与 TSS 折算的适用范围） */
const PARTICULATE = ['X_I', 'X_S', 'X_B_H', 'X_B_A', 'X_P', 'X_ND'] as const;
const PARTICULATE_SET = new Set<string>(PARTICULATE);

/** 报告口径：TSS = 0.75 × 颗粒 COD（不含 X_ND） */
export function tssOf(s: Asm1State): number {
  return 0.75 * (s.X_I + s.X_S + s.X_B_H + s.X_B_A + s.X_P);
}

/**
 * 官方稳态初始向量（BSM1 描述文档附带的 Steady.txt 数据，Jeppsson Matlab/Simulink 实现）。
 *
 * BSM1 的验证协议是"从稳态出发检验不变性"：技术报告向实现者提供该初始向量，
 * 要求在开环默认操纵量下模拟后与 Table 6 对照。直接从稀释进水冷启动会落入
 * 另一个自洽平衡（无硝化：缺氧区没有 NO₃ 可反硝化 → 碳氧化挤占好氧氧 →
 * 硝化菌洗出）——该吸引子与官方稳态并存，不是模型缺陷，而是启动方式问题，
 * 实测见 docs/AUDIT-REPORT.md。
 */
export const BSM1_STEADY_INIT: Asm1State[] = [
  emptyAsm1State({
    S_I: 30,
    S_S: 3.2439,
    X_I: 1149.1683,
    X_S: 98.6029,
    X_B_H: 2552.1095,
    X_B_A: 151.6721,
    X_P: 446.9249,
    S_O: 0.0076964,
    S_NO: 3.5133,
    S_NH: 11.8312,
    S_ND: 1.3621,
    X_ND: 6.1775,
    S_ALK: 5.3399,
  }),
  emptyAsm1State({
    S_I: 30,
    S_S: 1.6707,
    X_I: 1149.1683,
    X_S: 91.7032,
    X_B_H: 2552.3711,
    X_B_A: 151.5303,
    X_P: 448.0839,
    S_O: 0.000060271,
    S_NO: 1.0,
    S_NH: 12.5482,
    S_ND: 0.78899,
    X_ND: 5.9537,
    S_ALK: 5.5706,
  }),
  emptyAsm1State({
    S_I: 30,
    S_S: 1.2195,
    X_I: 1149.1683,
    X_S: 69.6594,
    X_B_H: 2560.2025,
    X_B_A: 152.6873,
    X_P: 449.6336,
    S_O: 1.635,
    S_NO: 6.2289,
    S_NH: 7.3197,
    S_ND: 0.8307,
    X_ND: 4.7131,
    S_ALK: 4.8236,
  }),
  emptyAsm1State({
    S_I: 30,
    S_S: 0.97326,
    X_I: 1149.1683,
    X_S: 54.4484,
    X_B_H: 2563.3104,
    X_B_A: 153.7108,
    X_P: 451.1853,
    S_O: 2.4745,
    S_NO: 11.0693,
    S_NH: 2.7825,
    S_ND: 0.75276,
    X_ND: 3.8403,
    S_ALK: 4.1538,
  }),
  emptyAsm1State({
    S_I: 30,
    S_S: 0.80801,
    X_I: 1149.1683,
    X_S: 44.4828,
    X_B_H: 2562.8514,
    X_B_A: 154.163,
    X_P: 452.7367,
    S_O: 2.0,
    S_NO: 13.5243,
    S_NH: 0.67193,
    S_ND: 0.6645,
    X_ND: 3.2605,
    S_ALK: 3.8277,
  }),
];

/** 官方稳态沉降器剖面（顶层 → 底层，g SS/m³），用于按协议初始化二沉池 */
export const BSM1_SETTLER_INIT = [
  12.5016, 18.1183, 29.548, 69.0015, 356.2825, 356.2825, 356.2825, 356.2825, 356.2825, 6399.2981,
];

export interface Bsm1RunOptions {
  /**
   * 温度修正基准 ℃。默认 20（= 不修正）：BSM1 官方参数表本身对应 15 ℃
   * 工况（技术报告口径），再叠加 van't Hoff 修正会变成二次修正。
   * 传入其它温度时按 asm1.ts 的 θ 系数修正。
   */
  temperatureC?: number;
  /** 缺氧生长 NO₃ 开关指数：基准取 1（标准 ASM1），默认 1 */
  anoxicNo3Exponent?: number;
  /** 稳态探索上限（天） */
  maxDays?: number;
  /** 积分步长（天） */
  dtDays?: number;
  /** 判稳：逐日相对变化阈值 */
  tolerance?: number;
  /** 初始化：官方稳态向量（默认，验证协议）或进水+接种（冷启动） */
  init?: 'official' | 'cold';
}

export interface Bsm1SteadyResult {
  effluent: Asm1State;
  tanks: Asm1State[];
  settlerState: SettlerState;
  xEffluentTss: number;
  xUnderflowTss: number;
  /** 是否达到稳态判据（连续 5 天相对变化低于阈值） */
  converged: boolean;
  steadyDays: number;
  temperatureC: number;
}

/** BSM1 基准参数：官方 Henze-1987 参数集 + 标准 ASM1 开关函数（指数 1） */
export function bsm1Asm1Params(anoxicNo3Exponent = 1): Asm1Params {
  return { ...BSM1_ASM1_PARAMS, anoxicNo3Exponent };
}

/**
 * 全零组分态。emptyAsm1State 的 S_ALK 默认 7（进水口径），
 * 混合点必须显式清零，否则每步都会向系统注入 7 mol/m³ 的幻影碱度
 * （实测曾把稳态碱度推到 42.4，见审计报告）。
 */
const zeroAsm1 = (): Asm1State => emptyAsm1State({ S_ALK: 0 });

/**
 * 运行 BSM1 开环默认工况至稳态。
 *
 * 流量衡算（m³/d）：一池进流 = Q + QR + Qintr = 92 230；
 * 二沉池进料 = Q + QR = 36 892；底流 = QR + QW = 18 831；出水 = 18 061。
 * 与报告 "Influent flow to AS / Settler feed / Returned sludge" 逐项一致。
 */
export function runBsm1OpenLoopSteady(options: Bsm1RunOptions = {}): Bsm1SteadyResult {
  const plant = BSM1_PLANT;
  const temperatureC = options.temperatureC ?? 20;
  const maxDays = options.maxDays ?? 200;
  const dtDays = options.dtDays ?? 1 / 1440;
  const tol = options.tolerance ?? 1e-3;
  // dtDays ≤ 0 会让 maxSteps 变成 Infinity（死循环）而非报错——这是挂死不是失败
  if (!(dtDays > 0) || !Number.isFinite(dtDays)) {
    throw new Error(`dtDays 必须为正有限值，收到 ${dtDays}`);
  }
  const params = bsm1Asm1Params(options.anoxicNo3Exponent ?? 1);

  const qThrough = plant.influentFlowM3d + plant.returnSludgeM3d + plant.internalRecycleM3d;
  const qToSettler = plant.influentFlowM3d + plant.returnSludgeM3d;
  const qUnderflow = plant.returnSludgeM3d + plant.wasteSludgeM3d;

  const dtH = dtDays * 24; // 小时
  const nTanks = plant.tankVolumesM3.length;

  /**
   * 初始状态：进水组分 + 常量接种生物量。
   * 冷启动（全零生物量）需要额外数十天才能养起硝化菌；
   * 接种量级与报告稳态相同（X_B_H ≈ 2500 gCOD/m³），只影响收敛速度，
   * 不影响稳态位置——稳态由 SRT（QW）与进水决定。
   */
  const seed: Partial<Asm1State> = { X_B_H: 2500, X_B_A: 150, X_P: 450, X_I: 1150, S_O: 0, S_NO: 0 };
  const initMode = options.init ?? 'official';
  let tanks: Asm1State[] =
    initMode === 'official'
      ? BSM1_STEADY_INIT.map((s) => ({ ...s }))
      : plant.tankVolumesM3.map(() => emptyAsm1State({ ...BSM1_INFLUENT, ...seed }));
  let settler: SettlerState =
    initMode === 'official' ? { x: [...BSM1_SETTLER_INIT] } : createSettler(plant.settler, 3000);

  const stepsPerDay = Math.round(1 / dtDays);
  const maxSteps = Math.ceil(maxDays * stepsPerDay);
  // 判稳必须覆盖生物量：硝化菌恢复是慢过程，只盯溶解性指标会把
  // "生物量仍在爬坡"误判为稳态（实测曾 40 天假收敛）。
  const track = ['S_NH', 'S_NO', 'S_S', 'X_B_H', 'X_B_A'] as const;
  let prevTracked: number[] | null = null;
  let stableDays = 0;
  let converged = false;
  let dayCount = 0;
  let xEffluent = settler.x[0];
  let xUnderflow = settler.x[settler.x.length - 1];

  const mixInto = (target: Asm1State, src: Asm1State, q: number): void => {
    for (const c of Object.keys(target) as (keyof Asm1State)[]) {
      target[c] += (q / qThrough) * src[c];
    }
  };

  for (let step = 1; step <= maxSteps; step++) {
    // 本步起点的旧状态快照：显式 Euler 的输运项必须用同一时刻的值，
    // 不能让一池的更新值在同一时间里被下游池引用（Gauss-Seidel 偏置）。
    const prevTanks = tanks;
    const last = prevTanks[nTanks - 1];
    const feedTss = Math.max(1, tssOf(last));

    // 沉降器当前剖面给出的劈分比例（上一步状态，变化缓慢）
    const ratioU = xUnderflow / feedTss;
    const ras = zeroAsm1();
    for (const c of Object.keys(ras) as (keyof Asm1State)[]) {
      ras[c] = PARTICULATE_SET.has(c) ? last[c] * ratioU : last[c];
    }

    // 一池混合进流：Q·进水 + QR·回流 + Qintr·五池出水
    const inlet = zeroAsm1();
    mixInto(inlet, BSM1_INFLUENT, plant.influentFlowM3d);
    mixInto(inlet, ras, plant.returnSludgeM3d);
    mixInto(inlet, last, plant.internalRecycleM3d);

    // 五池串联推进（Euler，1 min）
    const nextTanks: Asm1State[] = new Array(nTanks);
    for (let i = 0; i < nTanks; i++) {
      const v = plant.tankVolumesM3[i];
      const inState = i === 0 ? inlet : prevTanks[i - 1];
      const cur = prevTanks[i];
      const r = reactionRates(cur, params, temperatureC);
      const qv = qThrough / v / 24; // 1/h
      const klaH = plant.klaPerDay[i] / 24; // 1/h
      const next = emptyAsm1State();
      for (const c of Object.keys(next) as (keyof Asm1State)[]) {
        let rate = qv * (inState[c] - cur[c]) + r[c];
        if (c === 'S_O' && klaH > 0) rate += klaH * (plant.oxygenSaturation - cur[c]);
        next[c] = cur[c] + dtH * rate;
      }
      // 物理下限：浓度非负
      for (const c of Object.keys(next) as (keyof Asm1State)[]) {
        next[c] = Math.max(0, next[c]);
      }
      nextTanks[i] = next;
    }
    tanks = nextTanks;

    // 二沉池推进（非反应性）
    const res = stepSettler(
      settler,
      plant.settler,
      { flow: qToSettler, concentration: feedTss },
      { flow: qUnderflow },
      dtDays,
    );
    settler = res.state;
    xEffluent = res.xEffluent;
    xUnderflow = res.xUnderflow;

    // 逐日判稳：溶解性关键组分 + 生物量（相对变化）
    if (step % stepsPerDay === 0) {
      dayCount = step / stepsPerDay;
      const curTracked = track.map((c) => tanks[nTanks - 1][c]);
      const prev = prevTracked;
      if (prev) {
        const maxRel = Math.max(...curTracked.map((v, i) => Math.abs(v - prev[i]) / Math.max(1e-6, Math.abs(prev[i]))));
        if (maxRel < tol) {
          stableDays += 1;
          if (stableDays >= 5) {
            converged = true;
            break;
          }
        } else {
          stableDays = 0;
        }
      }
      prevTracked = curTracked;
    }
  }

  const finalTank = tanks[nTanks - 1];
  const finalFeedTss = Math.max(1, tssOf(finalTank));
  const ratioE = xEffluent / finalFeedTss;
  const effluent = zeroAsm1();
  for (const c of Object.keys(effluent) as (keyof Asm1State)[]) {
    effluent[c] = PARTICULATE_SET.has(c) ? finalTank[c] * ratioE : finalTank[c];
  }

  return {
    effluent,
    tanks,
    settlerState: settler,
    xEffluentTss: xEffluent,
    xUnderflowTss: xUnderflow,
    converged,
    steadyDays: dayCount,
    temperatureC,
  };
}
