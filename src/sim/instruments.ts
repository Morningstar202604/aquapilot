/**
 * WP4 第一阶段：仪表（传感器链）纯模型。
 *
 * 测量链（每台仪表独立步进，真值只作为本函数输入，控制层拿不到真值）：
 *
 *   真值 → 死时间 FIFO → 一阶滞后（τ）→  seeded 噪声 → 漂移/偏置 → 量程与质量码判定
 *
 * 本阶段不接引擎：`measure` 由集成方在第二阶段把反应器/二沉池真值按
 * `sensorId` 传入；状态全部是可 JSON 序列化的普通对象，随机数状态以
 * uint32 留在注册表内，同 seed 可复现。
 *
 * 单位口径与 docs/INDUSTRIAL-INTERFACES.md 第 2 节一致：浓度 mg/L、流量
 * m³/h、液位 m、时间 min。仪表精度/漂移率/死时间的默认值是工程假设，
 * 现场必须以仪表台账替换（见 docs/INSTRUMENTATION.md）。
 */

import type { ProcessTopology, UnitSpec } from '../model/topology';

export const SENSOR_OUT_OF_RANGE = 'SENSOR_OUT_OF_RANGE';
export const SENSOR_FAULT_ACTIVE = 'SENSOR_FAULT_ACTIVE';

export type InstrumentVariable =
  'do' | 'nh' | 'no3' | 'mlss' | 'flow' | 'level' | 'ph' | 'temperature' | 'pressure' | 'tp' | 'tn';

export type InstrumentQuality = 'good' | 'uncertain' | 'bad';

export type InstrumentFaultMode = 'none' | 'stuck' | 'drift' | 'dropout' | 'spike' | 'out-of-range';

export interface InstrumentSpec {
  id: string;
  unitId: string;
  variable: InstrumentVariable;
  /** 量程下限（与变量同单位） */
  min: number;
  /** 量程上限 */
  max: number;
  /** 一阶滞后时间常数，min */
  tauMin: number;
  /** 死时间，min；阶跃后这段时间内读数保持旧值 */
  deadTimeMin: number;
  /** 噪声标准差（同变量单位） */
  noiseStd: number;
  /** 漂移率（同变量单位 / 天） */
  driftPerDay: number;
  fault: InstrumentFaultMode;
}

export interface InstrumentReading {
  sensorId: string;
  unitId: string;
  variable: InstrumentVariable;
  /** bad/dropout 时为 null；不输出 NaN/Infinity */
  measured: number | null;
  quality: InstrumentQuality;
  /** 人可读原因，错误码前缀见 code */
  reason: string;
  code: string | null;
  atMin: number;
}

interface DelayedSample {
  atMin: number;
  value: number;
}

interface InstrumentInternal {
  spec: InstrumentSpec;
  /** 一阶滞后当前值；首次测量前为 null，直接跟随首个延迟样本 */
  lagValue: number | null;
  /** 死时间队列：按到期时刻排序 */
  delayQueue: DelayedSample[];
  /** 累计漂移偏置（同变量单位） */
  driftOffset: number;
  /** stuck 模式下锁定的冻结值 */
  stuckValue: number | null;
  /** 该仪表独立的 PRNG 状态（uint32，可序列化） */
  rngState: number;
  stepCount: number;
}

export interface InstrumentRegistry {
  seed: number;
  timeMin: number;
  instruments: InstrumentInternal[];
}

interface VariableDefault {
  min: number;
  max: number;
  tauMin: number;
  deadTimeMin: number;
  noiseStd: number;
  driftPerDay: number;
}

/**
 * 各变量默认仪表参数（工程假设，非现场标定值）。
 * 数值量级参照市政污水厂常见在线仪表：DO 膜式探头响应秒级到分钟级，
 * MLSS/氨氮仪表响应更慢；漂移率取仪表厂商典型年漂移折算到天。
 */
const VARIABLE_DEFAULTS: Record<InstrumentVariable, VariableDefault> = {
  do: { min: 0, max: 12, tauMin: 0.5, deadTimeMin: 0.3, noiseStd: 0.08, driftPerDay: 0.05 },
  nh: { min: 0, max: 60, tauMin: 2, deadTimeMin: 1, noiseStd: 0.3, driftPerDay: 0.2 },
  no3: { min: 0, max: 30, tauMin: 2, deadTimeMin: 1, noiseStd: 0.2, driftPerDay: 0.15 },
  mlss: { min: 0, max: 8000, tauMin: 5, deadTimeMin: 2, noiseStd: 200, driftPerDay: 120 },
  flow: { min: 0, max: 5000, tauMin: 1, deadTimeMin: 0.5, noiseStd: 30, driftPerDay: 20 },
  level: { min: 0, max: 6, tauMin: 1, deadTimeMin: 0.5, noiseStd: 0.05, driftPerDay: 0.01 },
  ph: { min: 4, max: 10, tauMin: 2, deadTimeMin: 1, noiseStd: 0.05, driftPerDay: 0.02 },
  temperature: { min: 0, max: 40, tauMin: 5, deadTimeMin: 1, noiseStd: 0.1, driftPerDay: 0.05 },
  pressure: { min: 0, max: 1, tauMin: 1, deadTimeMin: 0.5, noiseStd: 0.02, driftPerDay: 0.005 },
  tp: { min: 0, max: 20, tauMin: 3, deadTimeMin: 1, noiseStd: 0.1, driftPerDay: 0.05 },
  tn: { min: 0, max: 60, tauMin: 3, deadTimeMin: 1, noiseStd: 0.3, driftPerDay: 0.2 },
};

/** 拓扑单元类型 → 挂哪些测点；第二阶段引擎接线时按此取真值 */
/**
 * 只登记引擎真的会给出真值的测点。
 *
 * 之前按单元类型“能测什么”全量派生，结果筛网/沉砂/初沉/消毒/加药这些单元
 * 也被挂上流量/MLSS/pH 测点，而引擎没有对应真值，读数只能落成 `bad
 * signal_lost`——一屏 38 个点里 13 个“异常”，看起来像全厂仪表故障。测点表
 * 应当与模型能力一致：没有真值的变量不注册，需要时再补物理量。
 */
const KIND_VARIABLES: Record<string, InstrumentVariable[]> = {
  inlet: ['flow', 'ph', 'temperature'],
  anaerobic: ['nh'],
  anoxic: ['nh', 'no3'],
  aerobic: ['do', 'nh', 'no3', 'mlss'],
  clarifier: ['level', 'mlss'],
  blower: ['pressure', 'flow'],
  outlet: ['flow', 'nh', 'tn'],
};

export interface RegistryOptions {
  seed?: number;
  /** 按 sensorId 注入故障模式 */
  faults?: Record<string, InstrumentFaultMode>;
  /** 按 sensorId 覆盖规格字段（量程、τ、死时间、噪声、漂移率） */
  overrides?: Record<string, Partial<InstrumentSpec>>;
  /**
   * 理想仪表：τ=0、死时间 0、噪声 0、无漂移，测量值与真值逐位一致。
   * 引擎默认开启，保证既有数值基线不被仪表链扰动；故障/偏差在测试里单独注入。
   */
  ideal?: boolean;
}

function hashString(text: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function nextUniform(state: number): { value: number; state: number } {
  const a = (state + 0x6d2b79f5) >>> 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, state: a };
}

/** Box-Muller 正态采样；两次消耗 PRNG 状态 */
function nextNormal(state: number): { value: number; state: number } {
  const u1 = nextUniform(state);
  const u2 = nextUniform(u1.state);
  const z = Math.sqrt(-2 * Math.log(Math.max(u1.value, 1e-9))) * Math.cos(2 * Math.PI * u2.value);
  return { value: z, state: u2.state };
}

function makeSpec(unit: UnitSpec, variable: InstrumentVariable, fault: InstrumentFaultMode): InstrumentSpec {
  const d = VARIABLE_DEFAULTS[variable];
  return {
    id: `${unit.id}:${variable}`,
    unitId: unit.id,
    variable,
    min: d.min,
    max: d.max,
    tauMin: d.tauMin,
    deadTimeMin: d.deadTimeMin,
    noiseStd: d.noiseStd,
    driftPerDay: d.driftPerDay,
    fault,
  };
}

/** 手动登记一台仪表（测试与第二阶段接线均可复用） */
export function addInstrument(registry: InstrumentRegistry, spec: InstrumentSpec): void {
  registry.instruments.push({
    spec,
    lagValue: null,
    delayQueue: [],
    driftOffset: 0,
    stuckValue: null,
    rngState: (registry.seed ^ hashString(spec.id)) >>> 0,
    stepCount: 0,
  });
}

/**
 * 按拓扑派生测点注册表。
 *
 * topo 为 null（CLI/裸测试）时返回空注册表，再用 `addInstrument` 补测点。
 */
export function createInstrumentRegistry(topo: ProcessTopology | null, opts: RegistryOptions = {}): InstrumentRegistry {
  const seed = opts.seed ?? 1;
  const registry: InstrumentRegistry = { seed, timeMin: 0, instruments: [] };
  if (!topo) return registry;

  for (const unit of topo.units) {
    const variables = KIND_VARIABLES[unit.kind] ?? [];
    for (const variable of variables) {
      const fault = opts.faults?.[`${unit.id}:${variable}`] ?? 'none';
      const spec = makeSpec(unit, variable, fault);
      if (opts.ideal) {
        spec.tauMin = 0;
        spec.deadTimeMin = 0;
        spec.noiseStd = 0;
        spec.driftPerDay = 0;
      }
      const override = opts.overrides?.[spec.id];
      const merged: InstrumentSpec = override
        ? { ...spec, ...override, id: spec.id, unitId: spec.unitId, variable: spec.variable }
        : spec;
      addInstrument(registry, merged);
    }
  }
  return registry;
}

function delayUpTo(queue: DelayedSample[], now: number): { delayed: number | null; remaining: DelayedSample[] } {
  const remaining: DelayedSample[] = [];
  let delayed: number | null = null;
  for (const sample of queue) {
    if (sample.atMin <= now) {
      delayed = sample.value;
    } else {
      remaining.push(sample);
    }
  }
  return { delayed, remaining };
}

/**
 * 推进一步测量。
 *
 * @param registry 仪表注册表（状态跨步保留，就地推进）
 * @param truth    按 sensorId 给真值；缺键的测点判 bad（signal_lost），不补默认值
 * @param dtMin    步长，min；必须 > 0
 * @returns        本步读数数组；控制层/报警只能读这里的 measured 与 quality
 */
export function measure(
  registry: InstrumentRegistry,
  truth: Record<string, number>,
  dtMin: number,
): InstrumentReading[] {
  const dt = Math.max(1e-6, dtMin);
  const now = registry.timeMin + dt;
  const readings: InstrumentReading[] = [];

  for (const inst of registry.instruments) {
    const { spec } = inst;
    inst.stepCount += 1;
    const rawTruth = truth[spec.id];

    if (rawTruth === undefined || !Number.isFinite(rawTruth)) {
      readings.push({
        sensorId: spec.id,
        unitId: spec.unitId,
        variable: spec.variable,
        measured: null,
        quality: 'bad',
        reason: '真值信号缺失或非有限值，仪表判掉线',
        code: SENSOR_FAULT_ACTIVE,
        atMin: now,
      });
      registry.timeMin = now;
      continue;
    }

    // 1) 死时间 FIFO：真值先入队，到期才进入滞后环节
    inst.delayQueue.push({ atMin: now + spec.deadTimeMin, value: rawTruth });
    const { delayed, remaining } = delayUpTo(inst.delayQueue, now);
    inst.delayQueue = remaining;
    // 队列里的新样本还在死时间内：保持上一滞后值；首步没有旧值才用真值
    const delayedValue = delayed ?? inst.lagValue ?? rawTruth;

    // 2) 故障注入
    let base = delayedValue;
    let quality: InstrumentQuality = 'good';
    let reason = '测量正常';
    let code: string | null = null;

    if (spec.fault === 'dropout') {
      readings.push({
        sensorId: spec.id,
        unitId: spec.unitId,
        variable: spec.variable,
        measured: null,
        quality: 'bad',
        reason: '仪表掉线（dropout），输出 null',
        code: SENSOR_FAULT_ACTIVE,
        atMin: now,
      });
      registry.timeMin = now;
      continue;
    }

    if (spec.fault === 'stuck') {
      if (inst.stuckValue === null) inst.stuckValue = delayedValue;
      readings.push({
        sensorId: spec.id,
        unitId: spec.unitId,
        variable: spec.variable,
        measured: inst.stuckValue,
        quality: 'bad',
        reason: '探头卡死（stuck），读数冻结在锁定值',
        code: SENSOR_FAULT_ACTIVE,
        atMin: now,
      });
      registry.timeMin = now;
      continue;
    }

    if (spec.fault === 'out-of-range') {
      base = rawTruth >= (spec.min + spec.max) / 2 ? spec.max * 1.2 : spec.min * 0.8;
      quality = 'bad';
      reason = '仪表注入超量程故障';
      code = SENSOR_FAULT_ACTIVE;
    }

    if (spec.fault === 'drift') {
      inst.driftOffset += spec.driftPerDay * (dt / 1440);
    }

    // 3) 一阶滞后
    if (inst.lagValue === null) {
      inst.lagValue = delayedValue;
    } else if (spec.tauMin > 0) {
      const alpha = 1 - Math.exp(-dt / spec.tauMin);
      inst.lagValue += (delayedValue - inst.lagValue) * alpha;
    } else {
      inst.lagValue = delayedValue;
    }

    let measured = inst.lagValue + inst.driftOffset;
    if (spec.fault === 'out-of-range') measured = base;

    // 4) seeded 噪声；spike 为单点跳变，下一帧恢复正常链
    const noise = nextNormal(inst.rngState);
    inst.rngState = noise.state;
    measured += noise.value * spec.noiseStd;

    if (spec.fault === 'spike') {
      const spikeDir = noise.value >= 0 ? 1 : -1;
      const magnitude = Math.max(spec.noiseStd * 3, (spec.max - spec.min) * 0.1);
      measured = delayedValue + spikeDir * magnitude;
      quality = 'uncertain';
      reason = '单点跳变（spike），本帧数据待确认';
      code = SENSOR_FAULT_ACTIVE;
    }

    // 5) 量程与质量码判定
    if (measured < spec.min || measured > spec.max) {
      if (quality === 'good') {
        quality = 'uncertain';
        reason = '测量值超出仪表量程';
      }
      code = code ?? SENSOR_OUT_OF_RANGE;
    }

    if (!Number.isFinite(measured)) {
      readings.push({
        sensorId: spec.id,
        unitId: spec.unitId,
        variable: spec.variable,
        measured: null,
        quality: 'bad',
        reason: '测量值非有限值',
        code: SENSOR_FAULT_ACTIVE,
        atMin: now,
      });
      registry.timeMin = now;
      continue;
    }

    readings.push({
      sensorId: spec.id,
      unitId: spec.unitId,
      variable: spec.variable,
      measured,
      quality,
      reason,
      code,
      atMin: now,
    });
  }

  registry.timeMin = now;
  return readings;
}

/** 当前注册表的序列化视图（不含随机闭包，可进 snapshot/API） */
export function instrumentView(registry: InstrumentRegistry): {
  seed: number;
  timeMin: number;
  instruments: { spec: InstrumentSpec; driftOffset: number; stepCount: number }[];
} {
  return {
    seed: registry.seed,
    timeMin: registry.timeMin,
    instruments: registry.instruments.map((inst) => ({
      spec: inst.spec,
      driftOffset: inst.driftOffset,
      stepCount: inst.stepCount,
    })),
  };
}

// ---------------------------------------------------------------------------
// 引擎层包装（WP4 第二阶段）
// ---------------------------------------------------------------------------

/**
 * 挂在 NetworkSimState 上的仪表子系统状态。
 * - registry：跨步保留的测量链状态；
 * - readings：本步读数（控制层/告警/快照只读这里）；
 * - truth：本步真值对照，仅供 `/api/instruments` 诊断差值，不进控制回路。
 */
export interface InstrumentationState {
  registry: InstrumentRegistry;
  readings: InstrumentReading[];
  truth: Record<string, number>;
}

/** 初始化仪表子系统；默认理想仪表（测量值与真值逐位一致，基线零扰动）。 */
export function createInstrumentationState(
  topo: ProcessTopology | null,
  opts: RegistryOptions = {},
): InstrumentationState {
  return {
    registry: createInstrumentRegistry(topo, { ideal: true, ...opts }),
    readings: [],
    truth: {},
  };
}

/** 取某测点本步读数；不存在返回 undefined。 */
export function readingOf(state: InstrumentationState, sensorId: string): InstrumentReading | undefined {
  return state.readings.find((r) => r.sensorId === sensorId);
}

/**
 * 取某测点测量值。读数缺失、掉线或 bad 时回退到 `fallback`（通常传真值），
 * 避免坏探头直接把控制器拖成 NaN；uncertain 仍返回测量值（由调用方降权）。
 */
export function measuredValue(state: InstrumentationState, sensorId: string, fallback: number): number {
  const r = readingOf(state, sensorId);
  if (!r || r.measured === null || r.quality === 'bad') return fallback;
  return r.measured;
}

export interface InstrumentViewEntry {
  sensorId: string;
  unitId: string;
  variable: InstrumentVariable;
  measured: number | null;
  truth: number | null;
  quality: InstrumentQuality;
  reason: string;
  code: string | null;
  fault: InstrumentFaultMode;
  atMin: number;
}

/** 快照/路由投影：测点测量值、真值对照、质量码与故障模式。 */
export function instrumentationView(state: InstrumentationState): {
  timeMin: number;
  count: number;
  readings: InstrumentViewEntry[];
} {
  return {
    timeMin: state.registry.timeMin,
    count: state.readings.length,
    readings: state.readings.map((r) => {
      const spec = state.registry.instruments.find((i) => i.spec.id === r.sensorId)?.spec;
      return {
        sensorId: r.sensorId,
        unitId: r.unitId,
        variable: r.variable,
        measured: r.measured,
        truth: state.truth[r.sensorId] ?? null,
        quality: r.quality,
        reason: r.reason,
        code: r.code,
        fault: spec?.fault ?? 'none',
        atMin: r.atMin,
      };
    }),
  };
}
