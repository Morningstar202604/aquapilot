/**
 * WP4 第一阶段：控制层纯模型（PID 回路 + 联锁矩阵 + ESD + 指令审计）。
 *
 * 分层口径：
 *   - 仪表读数（instruments.ts）是控制器唯一可见的过程量；真值不进本层；
 *   - PID 只算回路输出，联锁/ESD 可以覆盖输出并锁存；
 *   - 所有被拒绝、被限幅、被覆盖的指令进审计队列，第二阶段给 WP8 写入边界复用。
 *
 * 本阶段不接引擎：回路、联锁条件、ESD 状态都是普通 JSON 对象，步进由
 * 集成方在引擎步内调用；第二阶段接线点见文件末尾导出函数签名。
 */

import type { EsdState } from './assets';
import type { ActuatorState } from './actuators';

export const INTERLOCK_TRIPPED = 'INTERLOCK_TRIPPED';
export const ESD_ACTIVE = 'ESD_ACTIVE';

// ---------------------------------------------------------------------------
// PID
// ---------------------------------------------------------------------------

export interface PidParams {
  kp: number;
  ki: number;
  kd: number;
  outMin: number;
  outMax: number;
  /** 积分项限幅，防止长期饱和后积分发散 */
  integralLimit: number;
  /** 微分滤波时间常数，min；缺省 0.25 */
  dFilterTauMin: number;
}

export interface PidState {
  mode: 'manual' | 'auto';
  setpoint: number;
  manualOutput: number;
  integral: number;
  lastError: number;
  dFiltered: number;
  lastMeasurement: number | null;
}

export interface PidStepResult {
  output: number;
  integral: number;
  error: number;
  derivative: number;
  saturated: boolean;
}

function clamp(v: number, a: number, b: number): number {
  return Math.min(b, Math.max(a, v));
}

function createPid(setpoint: number, manualOutput: number, outMin: number, outMax: number): PidState {
  return {
    mode: 'manual',
    setpoint,
    manualOutput: clamp(manualOutput, outMin, outMax),
    integral: 0,
    lastError: 0,
    dFiltered: 0,
    lastMeasurement: null,
  };
}

/**
 * 位置式 PID 步进。
 *
 * - 微分基于测量值（避免设定值阶跃造成微分冲击），一阶滤波；
 * - 抗积分饱和：输出已顶到上限且误差仍在推高饱和（或下限且误差仍为负）时，
 *   积分项保持不继续累计；
 * - 手动模式下输出跟随 manualOutput，积分不推进。
 */
export function stepPid(pid: PidState, params: PidParams, measurement: number, dtMin: number): PidStepResult {
  const dt = Math.max(1e-6, dtMin);
  const error = pid.setpoint - measurement;

  if (pid.mode === 'manual') {
    return {
      output: clamp(pid.manualOutput, params.outMin, params.outMax),
      integral: pid.integral,
      error,
      derivative: 0,
      saturated: false,
    };
  }

  // 微分（基于测量）+ 滤波
  let derivative = 0;
  if (pid.lastMeasurement !== null) {
    derivative = -(measurement - pid.lastMeasurement) / dt;
  }
  const tau = Math.max(1e-3, params.dFilterTauMin);
  const alpha = 1 - Math.exp(-dt / tau);
  pid.dFiltered += (derivative - pid.dFiltered) * alpha;

  const candidate = clamp(pid.integral + params.ki * error * dt, -params.integralLimit, params.integralLimit);
  const unsat = params.kp * error + params.ki * candidate + params.kd * pid.dFiltered;

  // 条件积分：饱和方向与误差方向一致时冻结积分
  let newIntegral = pid.integral;
  let saturated = false;
  if (unsat > params.outMax && error > 0) {
    saturated = true;
  } else if (unsat < params.outMin && error < 0) {
    saturated = true;
  } else {
    newIntegral = candidate;
  }

  const output = clamp(
    params.kp * error + params.ki * newIntegral + params.kd * pid.dFiltered,
    params.outMin,
    params.outMax,
  );

  pid.integral = newIntegral;
  pid.lastError = error;
  pid.lastMeasurement = measurement;

  return { output, integral: pid.integral, error, derivative: pid.dFiltered, saturated };
}

/**
 * 手动/自动切换。
 * 手动 → 自动时把积分锚定到当前手动输出，使输出无突跳（无扰切换）。
 */
export function switchPidMode(pid: PidState, params: PidParams, mode: 'manual' | 'auto'): void {
  if (mode === pid.mode) return;
  if (mode === 'auto') {
    const error = pid.lastMeasurement === null ? 0 : pid.setpoint - pid.lastMeasurement;
    pid.integral =
      params.ki > 0
        ? clamp((pid.manualOutput - params.kp * error) / params.ki, -params.integralLimit, params.integralLimit)
        : 0;
  } else {
    pid.manualOutput = clamp(pid.manualOutput, params.outMin, params.outMax);
  }
  pid.mode = mode;
}

// ---------------------------------------------------------------------------
// 回路、联锁、ESD
// ---------------------------------------------------------------------------

export type LoopKey = 'do' | 'ras' | 'was';

export interface ControlLoop {
  key: LoopKey;
  pid: PidState;
  params: PidParams;
  /** 对应执行机构/测点引用，第二阶段接线用 */
  actuatorRef: string;
  unitId: string;
}

export type InterlockMetric = 'doLow' | 'nhHigh' | 'blanketHigh' | 'fanFault' | 'levelHigh' | 'esd';
export type InterlockAction = 'fanMax' | 'rasMax' | 'stopInflow' | 'trip';

export interface InterlockCondition {
  id: string;
  metric: InterlockMetric;
  threshold: number;
  /** 回差：动作阈值与复位阈值之差（同变量单位） */
  hysteresis: number;
  action: InterlockAction;
  label: string;
}

export interface InterlockState {
  conditionId: string;
  tripped: boolean;
  /** 锁存：跳闸后即使条件恢复，也必须显式复位 */
  latched: boolean;
  /** 条件已退回到回差之外，允许复位 */
  armed: boolean;
  tripAtMin: number | null;
  resetAtMin: number | null;
}

export interface InterlockInputs {
  do: number;
  nh: number;
  blanket: number;
  level: number;
  fanFault: boolean;
  esd: boolean;
}

export interface EsdControlState {
  active: boolean;
  latched: boolean;
  unitId: string | null;
  triggeredAtMin: number | null;
  resetAtMin: number | null;
}

export interface CommandAuditEntry {
  atMin: number;
  loop: string;
  requested: number;
  actual: number;
  status: 'accepted' | 'clamped' | 'rejected';
  code: string | null;
  reason: string;
}

export interface ControlLayerState {
  timeMin: number;
  loops: Record<LoopKey, ControlLoop>;
  conditions: InterlockCondition[];
  interlocks: InterlockState[];
  esd: EsdControlState;
  audit: CommandAuditEntry[];
  outputs: Record<LoopKey, number>;
  inflowStopped: boolean;
  /**
   * 联锁是否接入物理回路。默认 false：联锁条件照常求值并记录状态，但不覆盖
   * PID 输出、不改变执行机构/回流/进水，保证既有数值基线零扰动；显式启用后
   * 跳闸、fanMax/rasMax/stopInflow 才作用到物理量（见 `enableInterlocks`）。
   */
  interlocksEnabled: boolean;
  /** 执行机构实例（风机/泵/阀），引擎步进时复用；键为执行机构 id */
  actuators?: Record<string, ActuatorState>;
}

const DEFAULT_CONDITIONS: InterlockCondition[] = [
  {
    id: 'do-low',
    metric: 'doLow',
    threshold: 1.0,
    hysteresis: 0.3,
    action: 'fanMax',
    label: 'DO 低低联锁，鼓风机拉满',
  },
  { id: 'nh-high', metric: 'nhHigh', threshold: 30, hysteresis: 3, action: 'fanMax', label: '氨氮高联锁，加大曝气' },
  {
    id: 'blanket-high',
    metric: 'blanketHigh',
    threshold: 3.5,
    hysteresis: 0.3,
    action: 'rasMax',
    label: '二沉池泥位高，回流拉满',
  },
  { id: 'fan-fault', metric: 'fanFault', threshold: 0, hysteresis: 0, action: 'trip', label: '风机故障跳闸' },
  {
    id: 'level-high',
    metric: 'levelHigh',
    threshold: 5.5,
    hysteresis: 0.3,
    action: 'stopInflow',
    label: '液位高，停止进水',
  },
  { id: 'esd', metric: 'esd', threshold: 0, hysteresis: 0, action: 'trip', label: '全厂/单元 ESD' },
];

const LOOP_DEFAULTS: Record<
  LoopKey,
  {
    setpoint: number;
    outMin: number;
    outMax: number;
    params: Omit<PidParams, 'outMin' | 'outMax'>;
    actuatorRef: string;
    unitId: string;
  }
> = {
  do: {
    setpoint: 2.0,
    outMin: 0,
    outMax: 1,
    params: { kp: 0.6, ki: 0.15, kd: 0.05, integralLimit: 10, dFilterTauMin: 0.25 },
    actuatorRef: 'blower',
    unitId: 'aerobic',
  },
  ras: {
    setpoint: 0.8,
    outMin: 0.3,
    outMax: 1.5,
    params: { kp: 0.5, ki: 0.1, kd: 0, integralLimit: 5, dFilterTauMin: 0.5 },
    actuatorRef: 'ras-pump',
    unitId: 'clarifier',
  },
  was: {
    setpoint: 0.0085,
    outMin: 0.002,
    outMax: 0.03,
    params: { kp: 0.4, ki: 0.08, kd: 0, integralLimit: 0.05, dFilterTauMin: 0.5 },
    actuatorRef: 'was-pump',
    unitId: 'clarifier',
  },
};

export interface ControlLayerOptions {
  setpoints?: Partial<Record<LoopKey, number>>;
  /** 回路初始手动输出（通常来自 controls 直通）；限幅到回路范围 */
  initialOutputs?: Partial<Record<LoopKey, number>>;
}

export function createControlLayer(opts: ControlLayerOptions = {}): ControlLayerState {
  const loops = {} as Record<LoopKey, ControlLoop>;
  const outputs = {} as Record<LoopKey, number>;

  for (const key of Object.keys(LOOP_DEFAULTS) as LoopKey[]) {
    const d = LOOP_DEFAULTS[key];
    const setpoint = opts.setpoints?.[key] ?? d.setpoint;
    const initial = clamp(opts.initialOutputs?.[key] ?? d.outMin, d.outMin, d.outMax);
    loops[key] = {
      key,
      pid: createPid(setpoint, initial, d.outMin, d.outMax),
      params: { ...d.params, outMin: d.outMin, outMax: d.outMax },
      actuatorRef: d.actuatorRef,
      unitId: d.unitId,
    };
    outputs[key] = initial;
  }

  return {
    timeMin: 0,
    loops,
    conditions: DEFAULT_CONDITIONS.map((c) => ({ ...c })),
    interlocks: DEFAULT_CONDITIONS.map((c) => ({
      conditionId: c.id,
      tripped: false,
      latched: false,
      armed: true,
      tripAtMin: null,
      resetAtMin: null,
    })),
    esd: { active: false, latched: false, unitId: null, triggeredAtMin: null, resetAtMin: null },
    audit: [],
    outputs,
    inflowStopped: false,
    interlocksEnabled: false,
  };
}

/** 启用/停用联锁对物理回路的覆盖；停用条件下联锁状态仍求值留痕，但不动作。 */
export function enableInterlocks(layer: ControlLayerState, enabled: boolean): void {
  layer.interlocksEnabled = enabled;
}

function conditionActive(cond: InterlockCondition, inputs: InterlockInputs): boolean {
  switch (cond.metric) {
    case 'doLow':
      return inputs.do < cond.threshold;
    case 'nhHigh':
      return inputs.nh > cond.threshold;
    case 'blanketHigh':
      return inputs.blanket > cond.threshold;
    case 'levelHigh':
      return inputs.level > cond.threshold;
    case 'fanFault':
      return inputs.fanFault;
    case 'esd':
      return inputs.esd;
  }
}

function conditionCleared(cond: InterlockCondition, inputs: InterlockInputs): boolean {
  switch (cond.metric) {
    case 'doLow':
      return inputs.do >= cond.threshold + cond.hysteresis;
    case 'nhHigh':
      return inputs.nh <= cond.threshold - cond.hysteresis;
    case 'blanketHigh':
      return inputs.blanket <= cond.threshold - cond.hysteresis;
    case 'levelHigh':
      return inputs.level <= cond.threshold - cond.hysteresis;
    // 布尔型故障（风机故障/ESD）不允许靠信号自然恢复，必须外部复位
    case 'fanFault':
    case 'esd':
      return false;
  }
}

function pushAudit(layer: ControlLayerState, entry: CommandAuditEntry): void {
  layer.audit.push(entry);
  if (layer.audit.length > 200) layer.audit.shift();
}

function trippedAction(layer: ControlLayerState, action: InterlockAction): boolean {
  return layer.interlocks.some(
    (s) => s.latched && s.tripped && layer.conditions.find((c) => c.id === s.conditionId)?.action === action,
  );
}

/** 某联锁动作当前是否处于跳闸覆盖状态（引擎路由回流/曝气覆盖用）。 */
export function interlockActive(layer: ControlLayerState, action: InterlockAction): boolean {
  if (!layer.interlocksEnabled) return false;
  return trippedAction(layer, action);
}

/**
 * 求值联锁矩阵。条件触发即锁存；恢复进入回差之外只置 armed，不自动解除。
 */
export function evaluateInterlocks(layer: ControlLayerState, inputs: InterlockInputs, dtMin: number): void {
  const now = layer.timeMin + Math.max(1e-6, dtMin);
  layer.timeMin = now;

  for (const state of layer.interlocks) {
    const cond = layer.conditions.find((c) => c.id === state.conditionId);
    if (!cond) continue;

    const active = conditionActive(cond, inputs);
    if (!state.tripped && active) {
      state.tripped = true;
      state.latched = true;
      state.armed = false;
      state.tripAtMin = now;
      state.resetAtMin = null;
      pushAudit(layer, {
        atMin: now,
        loop: cond.action,
        requested: cond.threshold,
        actual: 1,
        status: 'rejected',
        code: INTERLOCK_TRIPPED,
        reason: `联锁 ${cond.label} 动作（${cond.metric}）`,
      });
    } else if (state.tripped && !active) {
      state.armed = conditionCleared(cond, inputs);
    }
  }

  layer.inflowStopped = interlockActive(layer, 'stopInflow');
}

/** 显式复位一条联锁；条件未退回回差之外时拒绝复位并留审计。 */
export function resetInterlock(layer: ControlLayerState, conditionId: string): boolean {
  const state = layer.interlocks.find((s) => s.conditionId === conditionId);
  const cond = layer.conditions.find((c) => c.id === conditionId);
  if (!state || !cond || !state.latched) return true;

  if (!state.armed) {
    pushAudit(layer, {
      atMin: layer.timeMin,
      loop: conditionId,
      requested: 0,
      actual: 1,
      status: 'rejected',
      code: INTERLOCK_TRIPPED,
      reason: '联锁条件尚未恢复到回差之外，禁止复位',
    });
    return false;
  }

  state.tripped = false;
  state.latched = false;
  state.armed = true;
  state.resetAtMin = layer.timeMin;
  layer.inflowStopped = interlockActive(layer, 'stopInflow');
  return true;
}

/** 触发 ESD：全部输出进安全位（下限），锁存，拒绝手动指令。 */
export function triggerEsd(layer: ControlLayerState, unitId: string | null = null): void {
  layer.esd.active = true;
  layer.esd.latched = true;
  layer.esd.unitId = unitId ?? null;
  layer.esd.triggeredAtMin = layer.timeMin;
  layer.esd.resetAtMin = null;
  for (const key of Object.keys(layer.outputs) as LoopKey[]) {
    layer.outputs[key] = layer.loops[key].params.outMin;
  }
}

/** 从资产模块同步 ESD 状态（只读映射，不反向写资产）。 */
export function applyEsdState(layer: ControlLayerState, esd: Pick<EsdState, 'active' | 'unitId'>): void {
  if (esd.active && !layer.esd.active) {
    triggerEsd(layer, esd.unitId);
  } else if (!esd.active && layer.esd.latched && layer.esd.active) {
    // 资产侧已复位；控制层仍需显式 resetEsd 才解除，避免双端状态不一致
  }
}

/** 显式复位 ESD。 */
export function resetEsd(layer: ControlLayerState): void {
  if (!layer.esd.active) return;
  layer.esd.active = false;
  layer.esd.latched = false;
  layer.esd.resetAtMin = layer.timeMin;
  layer.esd.unitId = null;
}

export interface LoopStepResult {
  loop: LoopKey;
  /** PID 未覆盖时的原始输出 */
  requested: number;
  /** 最终输出（联锁/ESD 覆盖后） */
  output: number;
  source: 'pid' | 'interlock' | 'esd';
  saturated: boolean;
  integral: number;
}

/**
 * 推进一步回路。联锁动作与 ESD 优先级高于 PID：
 * - ESD：输出安全位（下限）；
 * - fanMax：DO 回路拉到上限；rasMax：RAS 回路拉到上限；
 * - trip：全部输出安全位。
 */
export function stepLoop(layer: ControlLayerState, key: LoopKey, measurement: number, dtMin: number): LoopStepResult {
  const loop = layer.loops[key];
  const dt = Math.max(1e-6, dtMin);
  layer.timeMin += dt;

  const pidResult = stepPid(loop.pid, loop.params, measurement, dt);
  let output = pidResult.output;
  let source: LoopStepResult['source'] = 'pid';

  if (layer.esd.active) {
    output = loop.params.outMin;
    source = 'esd';
  } else if (interlockActive(layer, 'trip')) {
    output = loop.params.outMin;
    source = 'interlock';
  } else if (key === 'do' && interlockActive(layer, 'fanMax')) {
    output = loop.params.outMax;
    source = 'interlock';
  } else if (key === 'ras' && interlockActive(layer, 'rasMax')) {
    output = loop.params.outMax;
    source = 'interlock';
  }

  layer.outputs[key] = output;

  if (source !== 'pid') {
    pushAudit(layer, {
      atMin: layer.timeMin,
      loop: key,
      requested: pidResult.output,
      actual: output,
      status: 'clamped',
      code: INTERLOCK_TRIPPED,
      reason: source === 'esd' ? 'ESD 安全位覆盖' : '联锁动作覆盖回路输出',
    });
  }

  return {
    loop: key,
    requested: pidResult.output,
    output,
    source,
    saturated: pidResult.saturated,
    integral: pidResult.integral,
  };
}

/**
 * 手动下发指令。ESD 或联锁跳闸期间拒绝，并留审计；否则切手动并设定输出。
 */
export function setManualOutput(layer: ControlLayerState, key: LoopKey, value: number): boolean {
  const loop = layer.loops[key];
  const blocked = layer.esd.active || interlockActive(layer, 'trip');

  if (blocked) {
    pushAudit(layer, {
      atMin: layer.timeMin,
      loop: key,
      requested: Number.isFinite(value) ? value : NaN,
      actual: layer.outputs[key],
      status: 'rejected',
      code: layer.esd.active ? ESD_ACTIVE : INTERLOCK_TRIPPED,
      reason: layer.esd.active ? 'ESD 期间禁止手动指令' : '联锁跳闸期间禁止手动指令',
    });
    return false;
  }

  if (!Number.isFinite(value) || value < loop.params.outMin || value > loop.params.outMax) {
    pushAudit(layer, {
      atMin: layer.timeMin,
      loop: key,
      requested: Number.isFinite(value) ? value : NaN,
      actual: layer.outputs[key],
      status: 'rejected',
      code: INTERLOCK_TRIPPED,
      reason: '指令越界或非有限值',
    });
    return false;
  }

  switchPidMode(loop.pid, loop.params, 'manual');
  loop.pid.manualOutput = value;
  layer.outputs[key] = value;
  pushAudit(layer, {
    atMin: layer.timeMin,
    loop: key,
    requested: value,
    actual: value,
    status: 'accepted',
    code: null,
    reason: '手动设定输出',
  });
  return true;
}

/** 序列化视图（可进 snapshot/API）。 */
export function controlLayerView(layer: ControlLayerState): Record<string, unknown> {
  return {
    timeMin: layer.timeMin,
    outputs: { ...layer.outputs },
    inflowStopped: layer.inflowStopped,
    interlocksEnabled: layer.interlocksEnabled,
    esd: { ...layer.esd },
    loops: Object.fromEntries(
      (Object.keys(layer.loops) as LoopKey[]).map((key) => [
        key,
        {
          mode: layer.loops[key].pid.mode,
          setpoint: layer.loops[key].pid.setpoint,
          integral: layer.loops[key].pid.integral,
          manualOutput: layer.loops[key].pid.manualOutput,
        },
      ]),
    ),
    interlocks: layer.interlocks.map((s) => ({ ...s })),
    audit: layer.audit.map((a) => ({ ...a })),
  };
}
