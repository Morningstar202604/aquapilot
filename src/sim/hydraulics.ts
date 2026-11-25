/**
 * 水力学层（WP3）：阻力分流、管渠容积与输运延迟、泵/阀/堰特性、示踪剂 RTD。
 *
 * 单位约定（与契约 §2 一致）：
 *   流量 m³/h；容积 m³；时间 min；水头/扬程 m；直径 mm；长度 m；流速 m/s；
 *   浓度 mg/L（示踪剂同为 mg/L）；质量 kg。
 *
 * 模型边界（详见 docs/HYDRAULICS.md）：
 *   - 支路按下游阻力（沿程损失 + 阀/堰局部损失）分配流量，总流量守恒；
 *   - 每条水力边按分段 CSTR（N 段串联）传递保守组分与示踪剂，给出停留时间分布；
 *   - 泵 H-Q 曲线、阀 Cv/开度、矩形/V 形堰 Q-H 均有显式饱和状态；
 *   - 没有几何信息时用确定性默认（目标流速 1.0–1.5 m/s 反推管径），不做现场标定。
 */

import type { CompiledNetwork } from './network';
import type { StreamKind } from '../model/topology';

/** 水力/设备状态码（契约 §5，WP3 段） */
export const HYDRAULICS_ERRORS = {
  INVALID_GEOMETRY: 'HYDRAULICS_INVALID_GEOMETRY',
  UNSOLVABLE_SPLIT: 'HYDRAULICS_UNSOLVABLE_SPLIT',
  TRACER_OVERFLOW: 'HYDRAULICS_TRACER_OVERFLOW',
} as const;

export type HydraulicsErrorCode = (typeof HYDRAULICS_ERRORS)[keyof typeof HYDRAULICS_ERRORS];

export const HYDRAULICS_DEFAULTS = {
  /** 无几何信息时的设计目标流速（合同区间 1.0–1.5 m/s），用于反推管径 */
  targetVelocityMps: 1.2,
  /** 默认管长 m（厂区单元间连接的确定性兜底） */
  lengthM: 6,
  /** 默认管壁粗糙度 mm（新钢管/PE 管量级） */
  roughnessMm: 0.5,
  /** 20 ℃ 水运动黏度 m²/s */
  waterViscosityM2s: 1.004e-6,
  gravity: 9.81,
  minDiameterMm: 100,
  maxDiameterMm: 2000,
  /** 每段 CSTR 代表的停留时间 min；段数 = clamp(round(θ/段目标), 1, max) */
  segmentTargetMin: 5,
  minSegments: 1,
  maxSegments: 4,
  /** 阀门全开局部阻力系数 ζ₀ */
  valveFullOpenZeta: 2.5,
  /** 开度 ≤ 该值视为全关 */
  valveClosedAlpha: 0.02,
  /** 堰流流量系数（矩形薄壁堰） */
  weirCd: 0.62,
  /** 示踪剂浓度上限 mg/L，超出记 TRACER_OVERFLOW 而非出 NaN */
  tracerMaxMgL: 100_000,
  /** 泵额定转速 rpm（无 meta 时的兜底） */
  pumpRatedRpm: 1450,
  /** 泵默认关死扬程 m */
  pumpHead0M: 18,
  /** 泵默认曲线系数（m/(m³/h)² 量级的折算系数） */
  pumpK: 2.4e-5,
} as const;

export type DeviceKind = 'none' | 'valve' | 'pump' | 'weir';
export type EdgeStatus = 'ok' | 'closed' | 'pump_over_curve' | 'weir_overflow' | 'no_flow';

/** 边几何/设备参数；缺省项由编译期默认补齐。 */
export interface EdgeGeometry {
  lengthM: number;
  /** mm；0 表示按设计流速反推管径 */
  diameterMm: number;
  roughnessMm: number;
  targetVelocityMps: number;
  deviceKind: DeviceKind;
  /** 阀门开度 0–1 */
  valveOpen: number;
  /** 阀门额定 Cv（m³/h 每 bar 压差） */
  valveCv: number;
  /** 泵实际转速 rpm */
  pumpRpm: number;
  /** 泵关死扬程 m（额定转速） */
  pumpHead0M: number;
  /** 泵 H-Q 二次曲线系数 */
  pumpK: number;
  /** 堰顶宽度 m */
  weirWidthM: number;
  weirType: 'rectangular' | 'v-notch';
}

function num(meta: Record<string, string | number> | undefined, key: string): number | undefined {
  const v = meta?.[key];
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 从单元 meta 读取边几何。Connection 本身没有 meta（契约现状），
 * 因此几何优先取起点单元 meta，缺省再取终点单元 meta；都没有走编译期默认。
 * 识别的 meta 键：lengthM / diameterMm / roughnessMm / targetVelocity /
 * valveOpen / valveCv / pumpRpm / pumpHead0 / pumpK / weirWidthM / weirType。
 */
export function deriveEdgeGeometry(
  fromMeta: Record<string, string | number> | undefined,
  toMeta: Record<string, string | number> | undefined,
): EdgeGeometry {
  const pick = (key: string) => num(fromMeta, key) ?? num(toMeta, key);
  const lengthM = Math.max(0.5, pick('lengthM') ?? HYDRAULICS_DEFAULTS.lengthM);
  const diameterMm = Math.max(0, pick('diameterMm') ?? 0);
  const roughnessMm = Math.max(0.05, pick('roughnessMm') ?? HYDRAULICS_DEFAULTS.roughnessMm);
  const targetVelocityMps = Math.min(
    1.5,
    Math.max(1.0, pick('targetVelocity') ?? HYDRAULICS_DEFAULTS.targetVelocityMps),
  );

  const valveOpen = pick('valveOpen');
  const pumpRpm = pick('pumpRpm');
  const weirWidth = pick('weirWidthM');

  let deviceKind: DeviceKind = 'none';
  if (weirWidth !== undefined) deviceKind = 'weir';
  else if (pumpRpm !== undefined || pick('pumpHead0') !== undefined) deviceKind = 'pump';
  else if (valveOpen !== undefined) deviceKind = 'valve';

  const weirTypeRaw = (toMeta?.weirType ?? fromMeta?.weirType) === 'v-notch' ? 'v-notch' : 'rectangular';

  return {
    lengthM,
    diameterMm,
    roughnessMm,
    targetVelocityMps,
    deviceKind,
    valveOpen: valveOpen === undefined ? 1 : Math.min(1, Math.max(0, valveOpen)),
    valveCv: Math.max(0, pick('valveCv') ?? 120),
    pumpRpm: Math.max(0, pumpRpm ?? HYDRAULICS_DEFAULTS.pumpRatedRpm),
    pumpHead0M: Math.max(0, pick('pumpHead0') ?? HYDRAULICS_DEFAULTS.pumpHead0M),
    pumpK: Math.max(1e-7, pick('pumpK') ?? HYDRAULICS_DEFAULTS.pumpK),
    weirWidthM: Math.max(0.1, weirWidth ?? 1.0),
    weirType: weirTypeRaw,
  };
}

/** 按目标流速与流量反推管径（mm）。 */
export function diameterForFlow(flowM3h: number, targetVelocityMps: number): number {
  const qM3s = Math.max(0, flowM3h) / 3600;
  if (qM3s <= 0) return HYDRAULICS_DEFAULTS.minDiameterMm;
  const dM = Math.sqrt((4 * qM3s) / (Math.PI * targetVelocityMps));
  const dMm = dM * 1000;
  return Math.min(HYDRAULICS_DEFAULTS.maxDiameterMm, Math.max(HYDRAULICS_DEFAULTS.minDiameterMm, dMm));
}

export function conduitAreaM2(diameterMm: number): number {
  const dM = diameterMm / 1000;
  return (Math.PI * dM * dM) / 4;
}

/** 达西摩擦因子（Swamee-Jain；层流退回 64/Re）。 */
export function frictionFactor(diameterMm: number, roughnessMm: number, velocityMps: number): number {
  const dM = diameterMm / 1000;
  if (dM <= 0 || velocityMps <= 0) return 0.022;
  const re = (velocityMps * dM) / HYDRAULICS_DEFAULTS.waterViscosityM2s;
  if (re < 2000) return Math.min(0.5, 64 / Math.max(1, re));
  const eps = roughnessMm / 1000 / dM;
  const denom = Math.log10(eps / 3.7 + 5.74 / Math.pow(re, 0.9));
  if (denom <= 0) return 0.022;
  return Math.min(0.5, 0.25 / (denom * denom));
}

/** 泵 H-Q 曲线：H = H₀·(n/n₀)² − K·Q²；返回扬程与超曲线判定。 */
export function pumpHead(
  curve: { head0M: number; k: number; rpm: number; ratedRpm: number },
  flowM3h: number,
): { headM: number; maxFlowM3h: number; overCurve: boolean } {
  const ratio = curve.ratedRpm > 0 ? curve.rpm / curve.ratedRpm : 0;
  const headAtZero = Math.max(0, curve.head0M) * ratio * ratio;
  const maxFlow = curve.k > 0 ? Math.sqrt(headAtZero / curve.k) : Number.POSITIVE_INFINITY;
  const headM = Math.max(0, headAtZero - curve.k * flowM3h * flowM3h);
  return { headM, maxFlowM3h: maxFlow, overCurve: flowM3h > maxFlow + 1e-6 };
}

/** 阀门开度-流量（Cv 口径）：Q = Cv(α)·sqrt(ΔP/ρ·g)，ΔP 由局部损失水头给。 */
export function valveFlow(
  cvMax: number,
  open: number,
  headLossM: number,
): { flowM3h: number; closed: boolean; zeta: number } {
  const alpha = Math.min(1, Math.max(0, open));
  if (alpha <= HYDRAULICS_DEFAULTS.valveClosedAlpha) {
    return { flowM3h: 0, closed: true, zeta: Number.POSITIVE_INFINITY };
  }
  const zeta = HYDRAULICS_DEFAULTS.valveFullOpenZeta / (alpha * alpha);
  // ΔP [bar] = ρ g h / 1e5；水 SG=1，Q[m³/h] = Cv·sqrt(ΔP)
  const deltaBar = (1000 * HYDRAULICS_DEFAULTS.gravity * Math.max(0, headLossM)) / 1e5;
  const cv = cvMax * alpha;
  const flowM3h = cv * Math.sqrt(Math.max(0, deltaBar));
  return { flowM3h, closed: false, zeta };
}

/** 堰流 Q-H：矩形薄壁堰与 90° V 形三角堰。 */
export function weirFlow(
  widthM: number,
  type: 'rectangular' | 'v-notch',
  headAboveCrestM: number,
): { flowM3h: number; overflow: boolean } {
  const h = Math.max(0, headAboveCrestM);
  const g = HYDRAULICS_DEFAULTS.gravity;
  let qM3s: number;
  if (type === 'v-notch') {
    // 90° 三角堰：Q = Cd·(8/15)·tan(45°)·√(2g)·h^(5/2)
    qM3s = HYDRAULICS_DEFAULTS.weirCd * (8 / 15) * 1 * Math.sqrt(2 * g) * Math.pow(h, 2.5);
  } else {
    qM3s = HYDRAULICS_DEFAULTS.weirCd * widthM * Math.sqrt(2 * g) * Math.pow(h, 1.5);
  }
  // 堰顶以上水深超过 0.5 m 视为溢流（漫过设计堰高）
  return { flowM3h: qM3s * 3600, overflow: h > 0.5 };
}

export interface BranchHydraulics {
  areaM2: number;
  diameterMm: number;
  velocityMps: number;
  volumeM3: number;
  residenceMin: number;
  friction: number;
  /** 阻力系数 R：h = R·Q²（Q 取 m³/s） */
  resistance: number;
  headLossM: number;
  closed: boolean;
  capacityM3h: number;
  status: EdgeStatus;
  pumpHeadM: number;
  zeta: number;
}

/**
 * 计算单条支路在给定流量下的水力参数。
 * 阻力 = 沿程 + 阀局部；泵支路按曲线给出能力上限；堰支路给出溢流状态。
 */
export function branchHydraulics(geo: EdgeGeometry, flowM3h: number, designFlowM3h: number): BranchHydraulics {
  const diameterMm = geo.diameterMm > 0 ? geo.diameterMm : diameterForFlow(designFlowM3h, geo.targetVelocityMps);
  const areaM2 = conduitAreaM2(diameterMm);
  const qM3s = Math.max(0, flowM3h) / 3600;
  const velocityMps = areaM2 > 0 ? qM3s / areaM2 : 0;
  const friction = frictionFactor(diameterMm, geo.roughnessMm, velocityMps);
  const volumeM3 = areaM2 * geo.lengthM;
  const residenceMin = flowM3h > 1e-6 ? (volumeM3 / flowM3h) * 60 : Number.POSITIVE_INFINITY;

  let zeta = 0;
  let closed = false;
  let capacityM3h = Number.POSITIVE_INFINITY;
  let status: EdgeStatus = flowM3h <= 1e-6 ? 'no_flow' : 'ok';
  let pumpHeadM = 0;

  if (geo.deviceKind === 'valve') {
    const v = valveFlow(geo.valveCv, geo.valveOpen, 1);
    zeta = v.zeta;
    closed = v.closed;
    if (closed) status = 'closed';
  } else if (geo.deviceKind === 'pump') {
    const pump = pumpHead(
      { head0M: geo.pumpHead0M, k: geo.pumpK, rpm: geo.pumpRpm, ratedRpm: HYDRAULICS_DEFAULTS.pumpRatedRpm },
      flowM3h,
    );
    pumpHeadM = pump.headM;
    capacityM3h = pump.maxFlowM3h;
    if (pump.overCurve) status = 'pump_over_curve';
  } else if (geo.deviceKind === 'weir') {
    const head = Math.pow(
      flowM3h / 3600 / (HYDRAULICS_DEFAULTS.weirCd * geo.weirWidthM * Math.sqrt(2 * HYDRAULICS_DEFAULTS.gravity)),
      2 / 3,
    );
    const w = weirFlow(geo.weirWidthM, geo.weirType, head);
    if (w.overflow) status = 'weir_overflow';
  }

  const lambda = friction;
  const dM = diameterMm / 1000;
  // R = (8/(g π² D⁴))·(λ L/D + ζ)，h [m] = R·Q² [Q m³/s]
  const pipeTerm = dM > 0 ? (lambda * geo.lengthM) / dM + zeta : Number.POSITIVE_INFINITY;
  const resistance = closed
    ? Number.POSITIVE_INFINITY
    : (8 * pipeTerm) / (HYDRAULICS_DEFAULTS.gravity * Math.PI * Math.PI * Math.pow(dM, 4));

  const headLossM = Number.isFinite(resistance) && qM3s > 0 ? resistance * qM3s * qM3s : closed ? 0 : 0;

  return {
    areaM2,
    diameterMm,
    velocityMps,
    volumeM3,
    residenceMin: Number.isFinite(residenceMin) ? residenceMin : 0,
    friction,
    resistance: Number.isFinite(resistance) ? resistance : Number.POSITIVE_INFINITY,
    headLossM,
    closed,
    capacityM3h,
    status,
    pumpHeadM,
    zeta,
  };
}

export interface SplitBranch {
  edgeId: string;
  resistance: number;
  closed: boolean;
  capacityM3h: number;
}

export interface SplitOutcome {
  flows: number[];
  status: 'ok' | 'unsolvable';
  errorCode?: HydraulicsErrorCode;
}

/**
 * 阻力分流：同节点各支路损失水头相等 h = Rᵢ Qᵢ²，故 Qᵢ ∝ 1/√Rᵢ，总量守恒。
 * 全支路关闭/阻力无穷且来流 > 0 时返回 UNSOLVABLE_SPLIT，不凭空造流量。
 */
export function splitByResistance(totalQ: number, branches: SplitBranch[]): SplitOutcome {
  const active = branches
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => !b.closed && Number.isFinite(b.resistance) && b.resistance > 0);

  if (active.length === 0) {
    if (totalQ > 1e-6) {
      return {
        flows: branches.map(() => 0),
        status: 'unsolvable',
        errorCode: HYDRAULICS_ERRORS.UNSOLVABLE_SPLIT,
      };
    }
    return { flows: branches.map(() => 0), status: 'ok' };
  }

  const flows = branches.map(() => 0);
  const activeIndices = new Set(active.map(({ i }) => i));
  let remaining = totalQ;

  // 逐轮把余量按 1/√R 分给未封顶支路；某支路达到能力上限后截流并从本轮集合移除，
  // 余量在剩余支路间重新分配。不能只跑固定两遍：多支路连续封顶会漏掉第三轮余量。
  while (remaining > 1e-9 && activeIndices.size > 0) {
    const round = [...activeIndices].map((i) => ({ i, w: 1 / Math.sqrt(branches[i].resistance) }));
    const roundWeightSum = round.reduce((s, r) => s + r.w, 0);
    let cappedAny = false;
    for (const { i, w } of round) {
      const cap = branches[i].capacityM3h;
      let q = (remaining * w) / roundWeightSum;
      if (cap < Number.POSITIVE_INFINITY && q > cap) {
        q = cap;
        activeIndices.delete(i);
        remaining -= cap;
        cappedAny = true;
      }
      flows[i] = q;
    }
    if (!cappedAny) {
      remaining = 0;
    }
  }

  if (remaining > 1e-9) {
    return {
      flows,
      status: 'unsolvable',
      errorCode: HYDRAULICS_ERRORS.UNSOLVABLE_SPLIT,
    };
  }

  return { flows, status: 'ok' };
}

/** 分段数：按边停留时间折成 N 段串联 CSTR（1–4 段）。 */
export function segmentCount(residenceMin: number): number {
  if (!Number.isFinite(residenceMin) || residenceMin <= 0) return HYDRAULICS_DEFAULTS.minSegments;
  const n = Math.round(residenceMin / HYDRAULICS_DEFAULTS.segmentTargetMin);
  return Math.min(HYDRAULICS_DEFAULTS.maxSegments, Math.max(HYDRAULICS_DEFAULTS.minSegments, n));
}

/** 保守组分顺序：COD / NH / NO3 / TP / SS */
export const TRANSPORT_COMPONENTS = ['cod', 'nh', 'no3', 'tp', 'ss'] as const;
export type TransportComponent = (typeof TRANSPORT_COMPONENTS)[number];

export interface HydraulicEdgeState {
  id: string;
  from: string;
  to: string;
  stream: StreamKind;
  trainId?: string;
  recycleKind?: 'ras' | 'internal' | 'was';
  flowM3h: number;
  volumeM3: number;
  residenceMin: number;
  velocityMps: number;
  resistance: number;
  headLossM: number;
  /** 泵曲线能力上限 m³/h；其余设备为 Infinity */
  capacityM3h: number;
  deviceKind: DeviceKind;
  status: EdgeStatus;
  valveOpen?: number;
  pumpHeadM?: number;
  pumpRpm?: number;
  geometry: EdgeGeometry;
  /** 示踪剂各段浓度 mg/L */
  tracerSegments: number[];
  /** 保守组分各段浓度（按 TRANSPORT_COMPONENTS 顺序） */
  componentSegments: number[][];
  /** 出口示踪剂浓度 mg/L */
  tracerOutlet: number;
}

export interface TracerRtd {
  active: boolean;
  injectedMassKg: number;
  history: { tMin: number; outletC: number }[];
  meanResidenceMin: number;
  varianceMin2: number;
  peakMin: number;
  peakC: number;
  retainedMassKg: number;
  dischargedMassKg: number;
}

export interface HydraulicError {
  code: HydraulicsErrorCode;
  message: string;
  edgeId?: string;
}

export interface HydraulicState {
  edges: HydraulicEdgeState[];
  errors: HydraulicError[];
  tracer: TracerRtd;
}

/** 由编译网络初始化水力学状态。 */
export function createHydraulics(net: CompiledNetwork, designFlowM3h: number): HydraulicState {
  const edges: HydraulicEdgeState[] = net.edges.map((e) => {
    const geo = e.geometry;
    const br = branchHydraulics(geo, designFlowM3h, designFlowM3h);
    const n = segmentCount(br.residenceMin);
    return {
      id: e.id,
      from: e.from,
      to: e.to,
      stream: e.stream,
      trainId: e.trainId,
      recycleKind: e.recycleKind,
      flowM3h: 0,
      volumeM3: br.volumeM3,
      residenceMin: br.residenceMin,
      velocityMps: 0,
      resistance: br.resistance,
      headLossM: 0,
      capacityM3h: br.capacityM3h,
      deviceKind: geo.deviceKind,
      status: 'no_flow' as EdgeStatus,
      valveOpen: geo.deviceKind === 'valve' ? geo.valveOpen : undefined,
      pumpHeadM: geo.deviceKind === 'pump' ? br.pumpHeadM : undefined,
      pumpRpm: geo.deviceKind === 'pump' ? geo.pumpRpm : undefined,
      geometry: geo,
      tracerSegments: Array.from({ length: n }, () => 0),
      componentSegments: Array.from({ length: n }, () => TRANSPORT_COMPONENTS.map(() => 0)),
      tracerOutlet: 0,
    };
  });

  return {
    edges,
    errors: [],
    tracer: {
      active: false,
      injectedMassKg: 0,
      history: [],
      meanResidenceMin: 0,
      varianceMin2: 0,
      peakMin: 0,
      peakC: 0,
      retainedMassKg: 0,
      dischargedMassKg: 0,
    },
  };
}

function edgeIndex(state: HydraulicState, edgeId: string): number {
  return state.edges.findIndex((e) => e.id === edgeId);
}

/** 示踪剂脉冲注入某条边（折算成该边起始段浓度 mg/L）。 */
export function injectTracer(state: HydraulicState, edgeId: string, massKg: number, volumeM3h: number): void {
  const i = edgeIndex(state, edgeId);
  if (i < 0) {
    state.errors.push({ code: HYDRAULICS_ERRORS.INVALID_GEOMETRY, message: `示踪剂注入未知边 ${edgeId}` });
    return;
  }
  if (!Number.isFinite(massKg) || massKg <= 0) {
    state.errors.push({ code: HYDRAULICS_ERRORS.INVALID_GEOMETRY, message: '示踪剂注入质量必须为正数', edgeId });
    return;
  }
  const edge = state.edges[i];
  const volume = Math.max(1, edge.volumeM3);
  // mg/L = g/m³；质量 kg → g = ·1000，浓度 g/m³ = mass·1000/volume
  const cMgL = (massKg * 1000) / volume;
  if (cMgL > HYDRAULICS_DEFAULTS.tracerMaxMgL) {
    state.errors.push({ code: HYDRAULICS_ERRORS.TRACER_OVERFLOW, message: '示踪剂浓度超出数值上限', edgeId });
    return;
  }
  edge.tracerSegments[0] = cMgL;
  state.tracer.active = true;
  state.tracer.injectedMassKg += massKg;
  void volumeM3h;
}

/**
 * 推进一条边的分段 CSTR 输运。
 * 各段按串联 CSTR 更新：C′ⱼ = (Cⱼ·Vₛ + Q·dt·C′ⱼ₋₁)/(Vₛ + Q·dt)；段容积 = 边容积/N。
 * 返回出口组分与出口示踪剂。
 */
function advanceEdge(
  edge: HydraulicEdgeState,
  dtMin: number,
  feedTracer: number,
  feedComponents: number[] | undefined,
): { tracerOutlet: number; componentsOutlet: number[] } {
  const qM3h = Math.max(0, edge.flowM3h);
  const volume = Math.max(1e-3, edge.volumeM3);
  const n = edge.tracerSegments.length;
  const segVolume = volume / n;
  const dtH = dtMin / 60;
  const inflowVol = qM3h * dtH;

  if (inflowVol <= 1e-9) {
    // 无流动：段内保持现状（停滞不是稀释）
    return { tracerOutlet: edge.tracerSegments[n - 1], componentsOutlet: edge.componentSegments[n - 1] ?? [] };
  }

  const tau = segVolume / inflowVol; // 段内名义停留时间（步长倍数）
  for (let j = 0; j < n; j++) {
    const upstreamTracer = j === 0 ? feedTracer : edge.tracerSegments[j - 1];
    edge.tracerSegments[j] = (edge.tracerSegments[j] + upstreamTracer / tau) / (1 + 1 / tau);
    const upstreamComp = j === 0 ? (feedComponents ?? []) : edge.componentSegments[j - 1];
    const curComp = edge.componentSegments[j];
    for (let k = 0; k < TRANSPORT_COMPONENTS.length; k++) {
      const up = upstreamComp[k] ?? 0;
      curComp[k] = (curComp[k] + up / tau) / (1 + 1 / tau);
    }
  }

  return {
    tracerOutlet: edge.tracerSegments[n - 1],
    componentsOutlet: [...edge.componentSegments[n - 1]],
  };
}

export interface HydraulicsStepInput {
  flows: Map<string, number>;
  dtMin: number;
  /** 当前仿真时刻 min（历史时间戳口径） */
  timeMin: number;
  /** 边 → 入口示踪剂浓度 mg/L */
  tracerFeed?: Map<string, number>;
  /** 边 → 入口保守组分（TRANSPORT_COMPONENTS 顺序） */
  componentFeed?: Map<string, number[]>;
  /** 记录出口示踪的边 id（出水方向） */
  outletEdgeIds?: string[];
}

/**
 * 每步更新：按实际流量刷新几何参数/状态码，推进分段 CSTR，记录示踪剂历史。
 * 不修改反应器物料平衡；物料平衡仍由网络引擎按流量加权混合（见 HYDRAULICS.md 边界）。
 */
export function stepHydraulics(state: HydraulicState, net: CompiledNetwork, input: HydraulicsStepInput): void {
  state.errors = [];
  const netEdgeById = new Map(net.edges.map((e) => [e.id, e]));

  for (const edge of state.edges) {
    const flow = Math.max(0, input.flows.get(edge.id) ?? 0);
    edge.flowM3h = flow;
    const netEdge = netEdgeById.get(edge.id);
    const geo = edge.geometry;
    const br = branchHydraulics(geo, flow, Math.max(1, flow));
    edge.volumeM3 = br.volumeM3;
    edge.residenceMin = br.residenceMin;
    edge.velocityMps = br.velocityMps;
    edge.resistance = br.resistance;
    edge.headLossM = br.headLossM;
    edge.status = br.status;
    edge.pumpHeadM = br.pumpHeadM;
    edge.capacityM3h = br.capacityM3h;

    if (br.status === 'pump_over_curve') {
      state.errors.push({
        code: HYDRAULICS_ERRORS.UNSOLVABLE_SPLIT,
        message: `泵 ${edge.id} 超出 H-Q 曲线能力`,
        edgeId: edge.id,
      });
    }
    if (netEdge?.stream === 'air' || netEdge?.stream === 'chemical') {
      edge.flowM3h = 0;
      edge.status = 'no_flow';
    }

    const feedTracer = input.tracerFeed?.get(edge.id) ?? 0;
    const feedComp = input.componentFeed?.get(edge.id);
    const out = advanceEdge(edge, input.dtMin, feedTracer, feedComp);
    edge.tracerOutlet = out.tracerOutlet;
  }

  // 示踪剂历史与排出质量：在出水边取浓度最大者；排出量按出口流量积分。
  if (state.tracer.active) {
    const outlets = (input.outletEdgeIds ?? [])
      .map((id) => state.edges.find((e) => e.id === id))
      .filter((e): e is HydraulicEdgeState => Boolean(e));
    const outletC = outlets.length > 0 ? Math.max(...outlets.map((e) => e.tracerOutlet)) : 0;
    const outletFlow = outlets.length > 0 ? outlets.reduce((s, e) => s + e.flowM3h, 0) : 0;
    state.tracer.history.push({ tMin: input.timeMin, outletC });
    if (outletC > state.tracer.peakC) {
      state.tracer.peakC = outletC;
      state.tracer.peakMin = input.timeMin;
    }
    // mg/L = g/m³；kg = g/1000；流量 m³/h × dtH
    state.tracer.dischargedMassKg += (outletC * outletFlow * (input.dtMin / 60)) / 1000;
  }

  // 留存质量按各段存量汇总
  let retained = 0;
  for (const edge of state.edges) {
    const segVol = Math.max(1e-3, edge.volumeM3) / Math.max(1, edge.tracerSegments.length);
    for (const c of edge.tracerSegments) retained += (Math.max(0, c) * segVol) / 1000;
  }
  state.tracer.retainedMassKg = retained;
}

/** 由示踪剂历史计算 RTD 矩：平均停留时间、方差（min）。 */
export function rtdMetrics(tracer: TracerRtd, dtMin: number): { meanResidenceMin: number; varianceMin2: number } {
  const hist = tracer.history;
  if (hist.length < 2) return { meanResidenceMin: 0, varianceMin2: 0 };
  let massMoment0 = 0;
  let massMoment1 = 0;
  let massMoment2 = 0;
  for (const point of hist) {
    const t = (point.tMin + 0.5) * dtMin;
    const c = Math.max(0, point.outletC);
    massMoment0 += c * dtMin;
    massMoment1 += c * t * dtMin;
    massMoment2 += c * t * t * dtMin;
  }
  if (massMoment0 <= 1e-9) return { meanResidenceMin: 0, varianceMin2: 0 };
  const mean = massMoment1 / massMoment0;
  const variance = massMoment2 / massMoment0 - mean * mean;
  return { meanResidenceMin: mean, varianceMin2: Math.max(0, variance) };
}

/** 示踪剂质量守恒账： retained（管段内存留）+ discharged（出口排出）= injected。 */
export function tracerMassBalance(state: HydraulicState): {
  retainedKg: number;
  dischargedKg: number;
  injectedKg: number;
  balanceResidualKg: number;
} {
  const { retainedMassKg: retained, dischargedMassKg: discharged, injectedMassKg: injected } = state.tracer;
  return {
    retainedKg: retained,
    dischargedKg: discharged,
    injectedKg: injected,
    balanceResidualKg: injected - retained - discharged,
  };
}

/** 用历史曲线刷新 RTD 矩（平均停留时间、方差），并写回 tracer 状态。 */
export function refreshRtdMetrics(state: HydraulicState, dtMin: number): void {
  const { meanResidenceMin, varianceMin2 } = rtdMetrics(state.tracer, dtMin);
  state.tracer.meanResidenceMin = meanResidenceMin;
  state.tracer.varianceMin2 = varianceMin2;
}

/** 深拷贝水力学状态（预测克隆用；段缓冲与示踪历史不能共享引用） */
export function cloneHydraulics(h: HydraulicState): HydraulicState {
  return {
    edges: h.edges.map((e) => ({
      ...e,
      geometry: { ...e.geometry },
      tracerSegments: [...e.tracerSegments],
      componentSegments: e.componentSegments.map((v) => [...v]),
    })),
    errors: h.errors.map((err) => ({ ...err })),
    tracer: { ...h.tracer, history: h.tracer.history.map((p) => ({ ...p })) },
  };
}

/** 快照投影（契约 §3：投影函数独立导出，不写进 snapshotView 匿名表达式）。 */
export interface HydraulicEdgeSnapshot {
  id: string;
  from: string;
  to: string;
  stream: StreamKind;
  flowM3h: number;
  volumeM3: number;
  residenceMin: number;
  velocityMps: number;
  headLossM: number;
  deviceKind: DeviceKind;
  status: EdgeStatus;
  valveOpen?: number;
  pumpHeadM?: number;
  tracerOutlet: number;
}

export interface HydraulicTrainSnapshot {
  id: string;
  clarifierId: string;
  feedFlowM3h: number;
  rasFlowM3h: number;
  wasFlowM3h: number;
}

export interface HydraulicSnapshot {
  edgeCount: number;
  edges: HydraulicEdgeSnapshot[];
  trains: HydraulicTrainSnapshot[];
  tracer: {
    active: boolean;
    meanResidenceMin: number;
    varianceMin2: number;
    peakMin: number;
    peakC: number;
    injectedMassKg: number;
    retainedMassKg: number;
  };
  errors: HydraulicError[];
}

/** 系列口径分流/回流诊断：按边的 trainId 聚合（快照与路由共用同一口径） */
export function hydraulicTrainView(state: HydraulicState): HydraulicTrainSnapshot[] {
  const byTrain = new Map<string, { clarifierId: string; feed: number; ras: number; was: number }>();
  for (const edge of state.edges) {
    if (!edge.trainId) continue;
    const entry = byTrain.get(edge.trainId) ?? { clarifierId: '', feed: 0, ras: 0, was: 0 };
    if (edge.recycleKind === 'ras') {
      entry.ras += edge.flowM3h;
      entry.clarifierId = edge.from;
    } else if (edge.recycleKind === 'was') {
      entry.was += edge.flowM3h;
    } else {
      entry.feed += edge.flowM3h;
    }
    byTrain.set(edge.trainId, entry);
  }
  return [...byTrain.entries()].map(([id, v]) => ({
    id,
    clarifierId: v.clarifierId,
    feedFlowM3h: round3(v.feed),
    rasFlowM3h: round3(v.ras),
    wasFlowM3h: round3(v.was),
  }));
}

export function hydraulicView(
  state: HydraulicState | undefined,
  trains?: HydraulicTrainSnapshot[],
): HydraulicSnapshot | undefined {
  if (!state) return undefined;
  const edges: HydraulicEdgeSnapshot[] = state.edges.map((e) => ({
    id: e.id,
    from: e.from,
    to: e.to,
    stream: e.stream,
    flowM3h: round3(e.flowM3h),
    volumeM3: round3(e.volumeM3),
    residenceMin: round3(e.residenceMin),
    velocityMps: round3(e.velocityMps),
    headLossM: round3(e.headLossM),
    deviceKind: e.deviceKind,
    status: e.status,
    valveOpen: e.valveOpen,
    pumpHeadM: e.pumpHeadM !== undefined ? round3(e.pumpHeadM) : undefined,
    tracerOutlet: round3(e.tracerOutlet),
  }));
  return {
    edgeCount: edges.length,
    edges,
    trains: trains ?? hydraulicTrainView(state),
    tracer: {
      active: state.tracer.active,
      meanResidenceMin: round3(state.tracer.meanResidenceMin),
      varianceMin2: round3(state.tracer.varianceMin2),
      peakMin: round3(state.tracer.peakMin),
      peakC: round3(state.tracer.peakC),
      injectedMassKg: round3(state.tracer.injectedMassKg),
      retainedMassKg: round3(state.tracer.retainedMassKg),
    },
    errors: state.errors.map((err) => ({ ...err })),
  };
}

function round3(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 1000) / 1000;
}
