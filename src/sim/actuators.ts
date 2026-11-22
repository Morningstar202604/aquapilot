/**
 * WP4 第一阶段：执行机构纯模型（阀门 / 泵-VFD / 风机）。
 *
 * 指令链路：控制器请求 → 可用性折减 → 越界/速率/死区校验 → 实际位置。
 * 任何非法指令（NaN、越界、超速率、设备不可用）都必须显式返回
 * rejected/clamped 与错误码，不允许静默通过。
 *
 * 可用性因子 0–1 来自资产模块（`capacityFactorFor`）：第二阶段接线时由
 * 集成方传入；本阶段默认 1（子系统未启用，不拖累引擎）。
 *
 * 单位：阀门开度 %；泵/风机为 0–1 负荷比例；功率 kW。时间 min。
 */

export const ACTUATOR_SATURATED = 'ACTUATOR_SATURATED';
export const ACTUATOR_UNAVAILABLE = 'ACTUATOR_UNAVAILABLE';
export const ACTUATOR_INVALID_INPUT = 'ACTUATOR_INVALID_INPUT';

export type ActuatorKind = 'valve' | 'pump' | 'fan';
export type FailMode = 'fail-open' | 'fail-closed' | 'lock';

export interface ActuatorSpec {
  id: string;
  kind: ActuatorKind;
  unitId: string;
  /** 指令/位置下限 */
  min: number;
  /** 指令/位置上限 */
  max: number;
  /** 速率限制：每分钟最大变化量（同指令单位） */
  rateLimitPerMin: number;
  /** 死区：请求与当前位置偏差小于此值时不动作 */
  deadband: number;
  failMode: FailMode;
  unit: '%' | 'ratio';
  /** 额定功率，kW（泵按相似定律折算；风机按负荷近似） */
  ratedPowerKw: number;
  /** 风机喘振下限（0–1）：运行中低于该比例必须拉回下限或停机 */
  surgeFloor?: number;
}

export interface ActuatorState {
  spec: ActuatorSpec;
  /** 实际位置（开度 % / 负荷比例） */
  position: number;
  /** 当前可用性因子 0–1（故障/检修/ESD 折减） */
  availability: number;
  atMin: number;
}

export type CommandStatus = 'accepted' | 'clamped' | 'rejected';

export interface ActuatorCommandResult {
  actuatorId: string;
  kind: ActuatorKind;
  requested: number;
  actual: number;
  status: CommandStatus;
  code: string | null;
  reason: string;
  atMin: number;
}

interface FactoryOpts {
  min?: number;
  max?: number;
  rateLimitPerMin?: number;
  deadband?: number;
  failMode?: FailMode;
  ratedPowerKw?: number;
  surgeFloor?: number;
  initial?: number;
  availability?: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function baseSpec(kind: ActuatorKind, id: string, unitId: string, opts: FactoryOpts): ActuatorSpec {
  const ratio = kind !== 'valve';
  return {
    id,
    kind,
    unitId,
    min: opts.min ?? 0,
    max: opts.max ?? (ratio ? 1 : 100),
    rateLimitPerMin: opts.rateLimitPerMin ?? (ratio ? 0.2 : 20),
    deadband: opts.deadband ?? (ratio ? 0.01 : 0.5),
    failMode: opts.failMode ?? 'fail-closed',
    unit: ratio ? 'ratio' : '%',
    ratedPowerKw: opts.ratedPowerKw ?? 0,
    surgeFloor: opts.surgeFloor,
  };
}

export function createValve(id: string, unitId: string, opts: FactoryOpts = {}): ActuatorState {
  const spec = baseSpec('valve', id, unitId, opts);
  return { spec, position: opts.initial ?? spec.min, availability: opts.availability ?? 1, atMin: 0 };
}

export function createPump(id: string, unitId: string, opts: FactoryOpts = {}): ActuatorState {
  const spec = baseSpec('pump', id, unitId, opts);
  return { spec, position: opts.initial ?? spec.min, availability: opts.availability ?? 1, atMin: 0 };
}

export function createFan(id: string, unitId: string, opts: FactoryOpts = {}): ActuatorState {
  const spec = baseSpec('fan', id, unitId, { ...opts, surgeFloor: opts.surgeFloor ?? 0.25 });
  return { spec, position: opts.initial ?? spec.min, availability: opts.availability ?? 1, atMin: 0 };
}

/**
 * 下发一条指令。
 *
 * @param state        执行机构状态（就地推进位置）
 * @param request      控制器请求值
 * @param dtMin        步长 min
 * @param availability 可选覆盖可用性因子（来自资产模块）；不传用 state.availability
 */
export function commandActuator(
  state: ActuatorState,
  request: number,
  dtMin: number,
  availability?: number,
): ActuatorCommandResult {
  const { spec } = state;
  const now = state.atMin + Math.max(1e-6, dtMin);
  const factor = availability === undefined ? state.availability : clamp01(availability);
  state.availability = factor;

  const reject = (code: string, reason: string): ActuatorCommandResult => ({
    actuatorId: spec.id,
    kind: spec.kind,
    requested: Number.isFinite(request) ? request : NaN,
    actual: state.position,
    status: 'rejected',
    code,
    reason,
    atMin: now,
  });

  if (!Number.isFinite(request)) {
    return reject(ACTUATOR_INVALID_INPUT, '指令不是有限数值（NaN/Infinity），拒绝执行');
  }

  if (factor <= 0.02) {
    return reject(ACTUATOR_UNAVAILABLE, '设备不可用（故障/检修/ESD 或可用性因子为 0），指令拒绝');
  }

  const effMax = spec.min + (spec.max - spec.min) * factor;

  // 越界：钳到有效边界并标记饱和，不静默丢指令
  let target = request;
  let status: CommandStatus = 'accepted';
  let code: string | null = null;
  let reason = '指令执行';

  if (target < spec.min) {
    target = spec.min;
    status = 'clamped';
    code = ACTUATOR_SATURATED;
    reason = '请求低于行程下限，已钳位到下限';
  } else if (target > effMax) {
    target = effMax;
    status = 'clamped';
    code = ACTUATOR_SATURATED;
    reason = '请求超出可用性折减后的上限，已钳位';
  }

  // 死区：偏差太小不动
  if (status === 'accepted' && Math.abs(target - state.position) <= spec.deadband) {
    return {
      actuatorId: spec.id,
      kind: spec.kind,
      requested: request,
      actual: state.position,
      status: 'accepted',
      code: null,
      reason: '请求在死区内，保持当前位置',
      atMin: now,
    };
  }

  // 速率限制：执行机构不能一步跨完行程
  const maxDelta = spec.rateLimitPerMin * Math.max(1e-6, dtMin);
  const delta = target - state.position;
  if (Math.abs(delta) > maxDelta) {
    target = state.position + Math.sign(delta) * maxDelta;
    status = 'clamped';
    code = ACTUATOR_SATURATED;
    reason = '指令变化超过执行机构速率限制，已按速率爬坡';
  }

  // 风机喘振下限：运行中低于下限必须拉回下限（停机位 0 除外）
  if (spec.kind === 'fan' && spec.surgeFloor !== undefined && target > 0 && target < spec.surgeFloor) {
    target = spec.surgeFloor;
    status = status === 'accepted' ? 'clamped' : status;
    code = code ?? ACTUATOR_SATURATED;
    reason = reason === '指令执行' ? '低于风机喘振下限，已拉回下限' : reason;
  }

  target = Math.min(effMax, Math.max(spec.min, target));
  state.position = target;
  state.atMin = now;

  return {
    actuatorId: spec.id,
    kind: spec.kind,
    requested: request,
    actual: state.position,
    status,
    code,
    reason,
    atMin: now,
  };
}

/** 泵轴功率：相似定律近似 P ∝ n³（转速比例的三次方） */
export function pumpPowerKw(state: ActuatorState, speedRatio: number): number {
  const ratio = clamp01(speedRatio);
  return state.spec.ratedPowerKw * ratio * ratio * ratio;
}

/** 风机轴功率近似：负荷比例平方（风机管路特性介于泵的三次方与恒速之间） */
export function fanPowerKw(state: ActuatorState, airflowRatio: number): number {
  const ratio = clamp01(airflowRatio);
  return state.spec.ratedPowerKw * ratio * ratio;
}

/**
 * 故障/气源失效时进安全位：
 * - fail-open  → 上限（阀全开）
 * - fail-closed → 下限（阀全关/泵停）
 * - lock       → 保持当前位置
 */
export function failSafePosition(state: ActuatorState): number {
  const { spec } = state;
  if (spec.failMode === 'fail-open') return spec.max;
  if (spec.failMode === 'fail-closed') return spec.min;
  return state.position;
}

/** 序列化视图（可进 snapshot/API，不含闭包） */
export function actuatorView(state: ActuatorState): Record<string, unknown> {
  return {
    spec: state.spec,
    position: state.position,
    availability: state.availability,
    atMin: state.atMin,
  };
}
