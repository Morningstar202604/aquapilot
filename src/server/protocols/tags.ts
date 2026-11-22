/**
 * WP8 工业接口：标签映射表。
 *
 * 内部仿真量（反应器 DO/NH/流量/泵状态/控制量）↔ 三种工业地址：
 * - OPC UA 节点 ID：`ns=2;s=Aquapilot.Reactor1.DO` 风格；
 * - Modbus TCP 保持寄存器：4xxxx（1 基编号，偏移 = 寄存器号 - 40001）；
 * - MQTT topic：`aquapilot/<域>/<量>`。
 *
 * 本文件只做**映射与口径**，不包含任何网络栈：读内部值、量程缩放、
 * 读写策略、坏值判定都在这里收口，适配层与三种传输共用同一张表，
 * 避免 Modbus 一套量程、OPC UA 另一套量程。
 *
 * 边界（见 docs/INDUSTRIAL-PROTOCOLS.md）：
 * - 地址编号是仿真口径，不代表现场 PLC 的真实点表；现场点表属于现场验收门；
 * - 只读标签在适配层写请求一律拒绝（PROTOCOL_WRITE_DENIED），不在此放行；
 * - 内部值算不出来（NaN/Infinity）时解析为 null，由适配层打 bad 质量码。
 */
import type { ReactorState } from '../../sim/networkTypes';
import type { Role } from '../auth';

/** WP8 错误码（与 docs/INDUSTRIAL-INTERFACES.md 第 5 节一致） */
export const PROTOCOL_ERRORS = {
  DISCONNECTED: 'PROTOCOL_DISCONNECTED',
  TAG_UNKNOWN: 'PROTOCOL_TAG_UNKNOWN',
  WRITE_DENIED: 'PROTOCOL_WRITE_DENIED',
} as const;

export type ProtocolKind = 'opcua' | 'modbus' | 'mqtt';
export type AccessPolicy = 'read' | 'write';
export type TagDataType = 'float32' | 'int16' | 'bool';

/** 标签值：数值 / 布尔 / 字符串；null 表示内部量缺失或坏值 */
export type TagRawValue = number | boolean | string | null;

export interface TagAddress {
  /** OPC UA 节点 ID（语义层标识，不是二进制栈的 NodeId 编码） */
  opcua: string;
  /** Modbus 保持寄存器号（4xxxx，1 基） */
  modbusRegister: number;
  /** MQTT topic */
  mqtt: string;
}

export interface TagScale {
  /** 单位值 → 寄存器整数的倍率：raw = round(unit * rawPerUnit) */
  rawPerUnit: number;
  /** 工程量程下限（单位值口径） */
  unitMin: number;
  /** 工程量程上限（单位值口径） */
  unitMax: number;
}

export type TagSourceKind = 'reactor' | 'influent' | 'effluent' | 'control' | 'energy' | 'derived';

export interface TagSource {
  kind: TagSourceKind;
  /** 状态对象上的字段名；derived 时为派生量名称 */
  field: string;
  /** reactor 类标签取哪一类池；缺省取第一座好氧池 */
  reactorKind?: ReactorState['kind'];
}

/**
 * 适配层依赖的最小状态视图。
 *
 * 只声明标签解析真正用到的字段，不绑定 NetworkSimState 的完整形状：
 * 引擎内部结构调整（WP2/WP3/WP4）不会直接冲击协议层；NetworkSimState
 * 结构上满足本接口，生产接线时直接传入引擎状态即可。
 */
export interface ProtocolStateView {
  timeMin: number;
  reactors: {
    id: string;
    kind: ReactorState['kind'];
    doLevel: number;
    nh: number;
    cod: number;
    no3: number;
    tp: number;
    temperature: number;
    alkalinity: number;
  }[];
  influent: { flow: number; cod: number; nh: number; tp: number };
  effluent: { flow: number; nh: number; tp: number; tn: number; ph: number; temperature: number };
  controls: { rasRatio: number } & Record<string, number>;
  energy: { blowerKw: number; pumpKw: number; totalKw: number };
}

export interface TagDef {
  /** 内部标签 ID（审计与路由使用的稳定主键） */
  id: string;
  label: string;
  dataType: TagDataType;
  unit: string;
  access: AccessPolicy;
  scale: TagScale;
  source: TagSource;
  address: TagAddress;
  description: string;
}

/** Modbus 保持寄存器基址（40001 对应偏移 0） */
export const MODBUS_HOLDING_BASE = 40001;

/**
 * 标签表。新增现场量时先在此登记地址、量程与读写策略，适配层不接受
 * 表外地址（返回 PROTOCOL_TAG_UNKNOWN）。
 */
export const TAG_DEFINITIONS: readonly TagDef[] = [
  // ---- 反应器（第一座好氧池）测量值，只读 ----
  {
    id: 'reactor1.do',
    label: '好氧池溶解氧',
    dataType: 'float32',
    unit: 'mg/L',
    access: 'read',
    scale: { rawPerUnit: 100, unitMin: 0, unitMax: 12 },
    source: { kind: 'reactor', field: 'doLevel', reactorKind: 'aerobic' },
    address: { opcua: 'ns=2;s=Aquapilot.Reactor1.DO', modbusRegister: 40001, mqtt: 'aquapilot/reactor1/do' },
    description: '第一座好氧池瞬时溶解氧浓度',
  },
  {
    id: 'reactor1.nh',
    label: '好氧池氨氮',
    dataType: 'float32',
    unit: 'mg/L',
    access: 'read',
    scale: { rawPerUnit: 100, unitMin: 0, unitMax: 50 },
    source: { kind: 'reactor', field: 'nh', reactorKind: 'aerobic' },
    address: { opcua: 'ns=2;s=Aquapilot.Reactor1.NH', modbusRegister: 40002, mqtt: 'aquapilot/reactor1/nh' },
    description: '第一座好氧池氨氮（NH₄-N）浓度',
  },
  {
    id: 'reactor1.cod',
    label: '好氧池 COD',
    dataType: 'float32',
    unit: 'mg/L',
    access: 'read',
    scale: { rawPerUnit: 10, unitMin: 0, unitMax: 1000 },
    source: { kind: 'reactor', field: 'cod', reactorKind: 'aerobic' },
    address: { opcua: 'ns=2;s=Aquapilot.Reactor1.COD', modbusRegister: 40003, mqtt: 'aquapilot/reactor1/cod' },
    description: '第一座好氧池混合液 COD',
  },
  {
    id: 'reactor1.no3',
    label: '好氧池硝态氮',
    dataType: 'float32',
    unit: 'mg/L',
    access: 'read',
    scale: { rawPerUnit: 100, unitMin: 0, unitMax: 50 },
    source: { kind: 'reactor', field: 'no3', reactorKind: 'aerobic' },
    address: { opcua: 'ns=2;s=Aquapilot.Reactor1.NO3', modbusRegister: 40004, mqtt: 'aquapilot/reactor1/no3' },
    description: '第一座好氧池硝态氮（NO₃-N）浓度',
  },
  {
    id: 'reactor1.tp',
    label: '好氧池总磷',
    dataType: 'float32',
    unit: 'mg/L',
    access: 'read',
    scale: { rawPerUnit: 100, unitMin: 0, unitMax: 20 },
    source: { kind: 'reactor', field: 'tp', reactorKind: 'aerobic' },
    address: { opcua: 'ns=2;s=Aquapilot.Reactor1.TP', modbusRegister: 40005, mqtt: 'aquapilot/reactor1/tp' },
    description: '第一座好氧池总磷浓度',
  },
  {
    id: 'reactor1.temperature',
    label: '好氧池水温',
    dataType: 'float32',
    unit: '℃',
    access: 'read',
    scale: { rawPerUnit: 10, unitMin: 0, unitMax: 40 },
    source: { kind: 'reactor', field: 'temperature', reactorKind: 'aerobic' },
    address: {
      opcua: 'ns=2;s=Aquapilot.Reactor1.Temperature',
      modbusRegister: 40006,
      mqtt: 'aquapilot/reactor1/temperature',
    },
    description: '第一座好氧池水温',
  },
  {
    id: 'reactor1.alkalinity',
    label: '好氧池碱度',
    dataType: 'float32',
    unit: 'mg/L',
    access: 'read',
    scale: { rawPerUnit: 1, unitMin: 0, unitMax: 1000 },
    source: { kind: 'reactor', field: 'alkalinity', reactorKind: 'aerobic' },
    address: {
      opcua: 'ns=2;s=Aquapilot.Reactor1.Alkalinity',
      modbusRegister: 40007,
      mqtt: 'aquapilot/reactor1/alkalinity',
    },
    description: '第一座好氧池碱度（以 CaCO₃ 计）',
  },
  // ---- 进水测量值，只读 ----
  {
    id: 'influent.flow',
    label: '进水流量',
    dataType: 'float32',
    unit: 'm³/h',
    access: 'read',
    scale: { rawPerUnit: 1, unitMin: 0, unitMax: 10000 },
    source: { kind: 'influent', field: 'flow' },
    address: { opcua: 'ns=2;s=Aquapilot.Influent.Flow', modbusRegister: 40008, mqtt: 'aquapilot/influent/flow' },
    description: '进厂瞬时进水流量',
  },
  {
    id: 'influent.cod',
    label: '进水 COD',
    dataType: 'float32',
    unit: 'mg/L',
    access: 'read',
    scale: { rawPerUnit: 1, unitMin: 0, unitMax: 2000 },
    source: { kind: 'influent', field: 'cod' },
    address: { opcua: 'ns=2;s=Aquapilot.Influent.COD', modbusRegister: 40009, mqtt: 'aquapilot/influent/cod' },
    description: '进水 COD 浓度',
  },
  {
    id: 'influent.nh',
    label: '进水氨氮',
    dataType: 'float32',
    unit: 'mg/L',
    access: 'read',
    scale: { rawPerUnit: 10, unitMin: 0, unitMax: 200 },
    source: { kind: 'influent', field: 'nh' },
    address: { opcua: 'ns=2;s=Aquapilot.Influent.NH', modbusRegister: 40010, mqtt: 'aquapilot/influent/nh' },
    description: '进水氨氮（NH₄-N）浓度',
  },
  {
    id: 'influent.tp',
    label: '进水总磷',
    dataType: 'float32',
    unit: 'mg/L',
    access: 'read',
    scale: { rawPerUnit: 10, unitMin: 0, unitMax: 50 },
    source: { kind: 'influent', field: 'tp' },
    address: { opcua: 'ns=2;s=Aquapilot.Influent.TP', modbusRegister: 40011, mqtt: 'aquapilot/influent/tp' },
    description: '进水总磷浓度',
  },
  // ---- 出水测量值，只读 ----
  {
    id: 'effluent.flow',
    label: '出水流量',
    dataType: 'float32',
    unit: 'm³/h',
    access: 'read',
    scale: { rawPerUnit: 1, unitMin: 0, unitMax: 10000 },
    source: { kind: 'effluent', field: 'flow' },
    address: { opcua: 'ns=2;s=Aquapilot.Effluent.Flow', modbusRegister: 40012, mqtt: 'aquapilot/effluent/flow' },
    description: '出厂瞬时出水流量',
  },
  {
    id: 'effluent.nh',
    label: '出水氨氮',
    dataType: 'float32',
    unit: 'mg/L',
    access: 'read',
    scale: { rawPerUnit: 10, unitMin: 0, unitMax: 50 },
    source: { kind: 'effluent', field: 'nh' },
    address: { opcua: 'ns=2;s=Aquapilot.Effluent.NH', modbusRegister: 40013, mqtt: 'aquapilot/effluent/nh' },
    description: '出水氨氮（NH₄-N）浓度',
  },
  {
    id: 'effluent.tp',
    label: '出水总磷',
    dataType: 'float32',
    unit: 'mg/L',
    access: 'read',
    scale: { rawPerUnit: 100, unitMin: 0, unitMax: 10 },
    source: { kind: 'effluent', field: 'tp' },
    address: { opcua: 'ns=2;s=Aquapilot.Effluent.TP', modbusRegister: 40014, mqtt: 'aquapilot/effluent/tp' },
    description: '出水总磷浓度',
  },
  {
    id: 'effluent.tn',
    label: '出水总氮',
    dataType: 'float32',
    unit: 'mg/L',
    access: 'read',
    scale: { rawPerUnit: 10, unitMin: 0, unitMax: 100 },
    source: { kind: 'effluent', field: 'tn' },
    address: { opcua: 'ns=2;s=Aquapilot.Effluent.TN', modbusRegister: 40015, mqtt: 'aquapilot/effluent/tn' },
    description: '出水总氮浓度',
  },
  {
    id: 'effluent.ph',
    label: '出水 pH',
    dataType: 'float32',
    unit: '-',
    access: 'read',
    scale: { rawPerUnit: 100, unitMin: 0, unitMax: 14 },
    source: { kind: 'effluent', field: 'ph' },
    address: { opcua: 'ns=2;s=Aquapilot.Effluent.pH', modbusRegister: 40016, mqtt: 'aquapilot/effluent/ph' },
    description: '出水 pH（无量纲）',
  },
  {
    id: 'effluent.temperature',
    label: '出水水温',
    dataType: 'float32',
    unit: '℃',
    access: 'read',
    scale: { rawPerUnit: 10, unitMin: 0, unitMax: 40 },
    source: { kind: 'effluent', field: 'temperature' },
    address: {
      opcua: 'ns=2;s=Aquapilot.Effluent.Temperature',
      modbusRegister: 40017,
      mqtt: 'aquapilot/effluent/temperature',
    },
    description: '出水水温',
  },
  // ---- 能耗，只读 ----
  {
    id: 'energy.blowerKw',
    label: '鼓风机功率',
    dataType: 'float32',
    unit: 'kW',
    access: 'read',
    scale: { rawPerUnit: 1, unitMin: 0, unitMax: 5000 },
    source: { kind: 'energy', field: 'blowerKw' },
    address: { opcua: 'ns=2;s=Aquapilot.Energy.BlowerKw', modbusRegister: 40018, mqtt: 'aquapilot/energy/blowerKw' },
    description: '曝气鼓风机瞬时功率',
  },
  {
    id: 'energy.pumpKw',
    label: '回流泵功率',
    dataType: 'float32',
    unit: 'kW',
    access: 'read',
    scale: { rawPerUnit: 1, unitMin: 0, unitMax: 2000 },
    source: { kind: 'energy', field: 'pumpKw' },
    address: { opcua: 'ns=2;s=Aquapilot.Energy.PumpKw', modbusRegister: 40019, mqtt: 'aquapilot/energy/pumpKw' },
    description: '回流/进水泵瞬时功率',
  },
  {
    id: 'energy.totalKw',
    label: '全厂瞬时功率',
    dataType: 'float32',
    unit: 'kW',
    access: 'read',
    scale: { rawPerUnit: 1, unitMin: 0, unitMax: 10000 },
    source: { kind: 'energy', field: 'totalKw' },
    address: { opcua: 'ns=2;s=Aquapilot.Energy.TotalKw', modbusRegister: 40020, mqtt: 'aquapilot/energy/totalKw' },
    description: '全厂设备瞬时有功功率',
  },
  // ---- 派生状态，只读 ----
  {
    id: 'pump.rasRunning',
    label: '回流泵运行状态',
    dataType: 'bool',
    unit: '-',
    access: 'read',
    scale: { rawPerUnit: 1, unitMin: 0, unitMax: 1 },
    source: { kind: 'derived', field: 'rasRunning' },
    address: { opcua: 'ns=2;s=Aquapilot.Pump.RasRunning', modbusRegister: 40021, mqtt: 'aquapilot/pump/rasRunning' },
    description: '回流污泥泵是否运行（回流比大于 0 即视为运行）',
  },
  // ---- 控制量，可写（白名单） ----
  {
    id: 'control.doSetpoint',
    label: 'DO 设定值',
    dataType: 'float32',
    unit: 'mg/L',
    access: 'write',
    scale: { rawPerUnit: 100, unitMin: 0, unitMax: 4 },
    source: { kind: 'control', field: 'doSetpoint' },
    address: {
      opcua: 'ns=2;s=Aquapilot.Control.DoSetpoint',
      modbusRegister: 40022,
      mqtt: 'aquapilot/control/doSetpoint',
    },
    description: '好氧池溶解氧设定值',
  },
  {
    id: 'control.internalRecirc',
    label: '内回流比',
    dataType: 'float32',
    unit: '-',
    access: 'write',
    scale: { rawPerUnit: 100, unitMin: 0, unitMax: 4 },
    source: { kind: 'control', field: 'internalRecirc' },
    address: {
      opcua: 'ns=2;s=Aquapilot.Control.InternalRecirc',
      modbusRegister: 40023,
      mqtt: 'aquapilot/control/internalRecirc',
    },
    description: '混合液内回流比（倍数）',
  },
  {
    id: 'control.rasRatio',
    label: '外回流比',
    dataType: 'float32',
    unit: '-',
    access: 'write',
    scale: { rawPerUnit: 100, unitMin: 0, unitMax: 2 },
    source: { kind: 'control', field: 'rasRatio' },
    address: { opcua: 'ns=2;s=Aquapilot.Control.RasRatio', modbusRegister: 40024, mqtt: 'aquapilot/control/rasRatio' },
    description: '回流污泥回流比（倍数）',
  },
  {
    id: 'control.wasRatio',
    label: '剩余污泥排放比',
    dataType: 'float32',
    unit: '-',
    access: 'write',
    scale: { rawPerUnit: 10000, unitMin: 0, unitMax: 0.05 },
    source: { kind: 'control', field: 'wasRatio' },
    address: { opcua: 'ns=2;s=Aquapilot.Control.WasRatio', modbusRegister: 40025, mqtt: 'aquapilot/control/wasRatio' },
    description: '剩余污泥排放比例',
  },
  {
    id: 'control.pacDose',
    label: 'PAC 投加量',
    dataType: 'float32',
    unit: 'kg/h',
    access: 'write',
    scale: { rawPerUnit: 1, unitMin: 0, unitMax: 100 },
    source: { kind: 'control', field: 'pacDose' },
    address: { opcua: 'ns=2;s=Aquapilot.Control.PacDose', modbusRegister: 40026, mqtt: 'aquapilot/control/pacDose' },
    description: '化学除磷 PAC 瞬时投加量',
  },
  {
    id: 'control.carbonDose',
    label: '碳源投加量',
    dataType: 'float32',
    unit: 'kg/h',
    access: 'write',
    scale: { rawPerUnit: 1, unitMin: 0, unitMax: 100 },
    source: { kind: 'control', field: 'carbonDose' },
    address: {
      opcua: 'ns=2;s=Aquapilot.Control.CarbonDose',
      modbusRegister: 40027,
      mqtt: 'aquapilot/control/carbonDose',
    },
    description: '外加碳源瞬时投加量',
  },
  {
    id: 'control.stepFeed',
    label: '多点进水比例',
    dataType: 'float32',
    unit: '-',
    access: 'write',
    scale: { rawPerUnit: 1000, unitMin: 0, unitMax: 0.5 },
    source: { kind: 'control', field: 'stepFeed' },
    address: { opcua: 'ns=2;s=Aquapilot.Control.StepFeed', modbusRegister: 40028, mqtt: 'aquapilot/control/stepFeed' },
    description: '直接进入缺氧池的原水比例',
  },
];

const BY_ID = new Map(TAG_DEFINITIONS.map((t) => [t.id, t]));
const BY_OPCUA = new Map(TAG_DEFINITIONS.map((t) => [t.address.opcua, t]));
const BY_MODBUS = new Map(TAG_DEFINITIONS.map((t) => [t.address.modbusRegister, t]));
const BY_MQTT = new Map(TAG_DEFINITIONS.map((t) => [t.address.mqtt, t]));

export function tagById(id: string): TagDef | undefined {
  return BY_ID.get(id);
}

export function tagByOpcua(nodeId: string): TagDef | undefined {
  return BY_OPCUA.get(nodeId);
}

export function tagByModbus(register: number): TagDef | undefined {
  return BY_MODBUS.get(register);
}

export function tagByMqtt(topic: string): TagDef | undefined {
  return BY_MQTT.get(topic);
}

/** 按协议地址查找标签；找不到返回 undefined（适配层映射为 PROTOCOL_TAG_UNKNOWN） */
export function tagByAddress(protocol: ProtocolKind, address: string): TagDef | undefined {
  switch (protocol) {
    case 'opcua':
      return tagByOpcua(address);
    case 'modbus':
      return tagByModbus(Number(address));
    case 'mqtt':
      return tagByMqtt(address);
  }
}

function firstReactor(
  state: ProtocolStateView,
  kind?: ReactorState['kind'],
): ProtocolStateView['reactors'][number] | undefined {
  if (kind) return state.reactors.find((r) => r.kind === kind) ?? state.reactors[0];
  return state.reactors.find((r) => r.kind === 'aerobic') ?? state.reactors[0];
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 从内部状态解析标签的当前工程值。
 * 返回 null 表示内部量缺失/非有限值，适配层据此打 bad 质量码，
 * 不允许把 NaN 序列化给现场。
 */
export function readInternalValue(state: ProtocolStateView, tag: TagDef): TagRawValue {
  const { source } = tag;
  switch (source.kind) {
    case 'reactor': {
      const reactor = firstReactor(state, source.reactorKind);
      if (!reactor) return null;
      const v = (reactor as unknown as Record<string, unknown>)[source.field];
      return isFiniteNumber(v) ? v : null;
    }
    case 'influent': {
      const v = (state.influent as unknown as Record<string, unknown>)[source.field];
      return isFiniteNumber(v) ? v : null;
    }
    case 'effluent': {
      const v = (state.effluent as unknown as Record<string, unknown>)[source.field];
      return isFiniteNumber(v) ? v : null;
    }
    case 'energy': {
      const v = (state.energy as unknown as Record<string, unknown>)[source.field];
      return isFiniteNumber(v) ? v : null;
    }
    case 'control': {
      const v = (state.controls as unknown as Record<string, unknown>)[source.field];
      return isFiniteNumber(v) ? v : null;
    }
    case 'derived': {
      if (source.field === 'rasRunning') return state.controls.rasRatio > 0;
      return null;
    }
  }
}

/** 工程值是否落在标签量程内（布尔/字符串标签不做量程钳制） */
export function inRange(tag: TagDef, value: number | boolean | string): boolean {
  if (typeof value !== 'number') return true;
  return Number.isFinite(value) && value >= tag.scale.unitMin && value <= tag.scale.unitMax;
}

/** 工程值 → Modbus 寄存器整数；超量程或非有限值返回 null */
export function toModbusRaw(tag: TagDef, value: TagRawValue): number | null {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (!inRange(tag, value)) return null;
  const raw = Math.round(value * tag.scale.rawPerUnit);
  if (raw < -32768 || raw > 32767) return null;
  return raw;
}

/** Modbus 寄存器整数 → 工程值 */
export function fromModbusRaw(tag: TagDef, raw: number): number {
  return raw / tag.scale.rawPerUnit;
}

/** 寄存器号 → 数组偏移（40001 → 0） */
export function modbusOffset(register: number): number {
  return register - MODBUS_HOLDING_BASE;
}

/**
 * 把一次合法写指令落到内部控制量上。
 * 调用方必须已经通过白名单、鉴权与量程校验；本函数只做字段赋值。
 */
export function applyControlWrite(state: ProtocolStateView, tag: TagDef, value: number): void {
  if (tag.source.kind !== 'control') return;
  (state.controls as unknown as Record<string, number>)[tag.source.field] = value;
}

/** 写操作所需最低角色（与 WebSocket 控制消息口径一致：operator 起步） */
export const WRITE_REQUIRED_ROLE: Role = 'operator';
