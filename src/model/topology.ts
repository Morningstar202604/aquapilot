/**
 * 工艺拓扑：界面、引擎、告警共享的唯一数据源。
 *
 * 设计原则：节点描述"单元"，边描述"物流"。两者都不含坐标与样式——
 * 布局是独立的一层，这样同一份工艺可以被渲染成工艺图、P&ID、拓扑摘要，
 * 也可以被编译成仿真求解顺序。坐标一旦写进模型，模型就只是画了。
 */

export type UnitKind =
  | 'inlet'
  | 'screening'
  | 'grit'
  | 'primary'
  | 'anaerobic'
  | 'anoxic'
  | 'aerobic'
  | 'clarifier'
  | 'disinfection'
  | 'outlet'
  | 'storage'
  | 'thickener'
  | 'dewatering'
  | 'blower'
  | 'chemical'
  | 'pump'
  | 'splitter';

export type StreamKind =
  | 'influent'
  | 'mixed_liquor'
  | 'return_activated_sludge'
  | 'waste_sludge'
  | 'internal_recycle'
  | 'effluent'
  | 'air'
  | 'chemical'
  | 'sludge_cake';

export interface Port {
  id: string;
  kind: 'in' | 'out';
  stream: StreamKind;
  /** 顺序，用于同一端口的多个出口（如分流器） */
  order?: number;
}

export interface UnitSpec {
  id: string;
  kind: UnitKind;
  name: string;
  /** 工艺角色，界面上的短标签 */
  role: string;
  volume?: number;
  area?: number;
  depth?: number;
  ports: Port[];
  /** 该单元参与质量平衡的状态变量组 */
  states?: string[];
  /** 允许的人工干预（决定面板显示哪些控件） */
  interventions?: InterventionKey[];
  meta?: Record<string, string | number>;
}

export type InterventionKey =
  | 'doSetpoint'
  | 'internalRecirc'
  | 'rasRatio'
  | 'wasRatio'
  | 'pacDose'
  | 'carbonDose'
  | 'alkDose'
  | 'stormStore'
  | 'aerationOn'
  | 'pumpSpeed';

export interface Connection {
  id: string;
  from: { unit: string; port: string };
  to: { unit: string; port: string };
  stream: StreamKind;
  /** 流量由控制变量驱动的表达式名（引擎侧解析） */
  flowRef?: string;
  /** 逻辑上是否为"回流"（用于界面反向绘制） */
  recycle?: boolean;
}

export interface ProcessTopology {
  id: string;
  name: string;
  units: UnitSpec[];
  connections: Connection[];
  /** 求解要求：串联顺序（引擎按此顺序推进 CSTR） */
  train: string[];
}

const P = (id: string, kind: 'in' | 'out', stream: StreamKind, order = 0): Port => ({ id, kind, stream, order });

export const PLANT_TOPOLOGY: ProcessTopology = {
  id: 'cc-wwtp-03-a2o',
  name: '澄川 A²/O 再生水厂',
  train: ['anaerobic', 'anoxic', 'aerobic1', 'aerobic2', 'aerobic3'],
  units: [
    {
      id: 'inlet',
      kind: 'inlet',
      name: '进水渠',
      role: '来水计量',
      ports: [P('out', 'out', 'influent')],
      states: ['flow', 'cod', 'nh', 'tp', 'ss', 'temperature'],
      meta: { 计量: '电磁流量计 DN1200' },
    },
    {
      id: 'screening',
      kind: 'screening',
      name: '粗格栅 · 提升泵房',
      role: '拦截 · 提升',
      ports: [P('in', 'in', 'influent'), P('out', 'out', 'influent')],
      states: ['ss'],
      interventions: ['pumpSpeed'],
      meta: { 栅距: '20 mm', 提升泵: '3 用 1 备' },
    },
    {
      id: 'grit',
      kind: 'grit',
      name: '细格栅 · 曝气沉砂池',
      role: '除砂 · 除油脂',
      ports: [P('in', 'in', 'influent'), P('out', 'out', 'influent')],
      states: ['ss'],
      meta: { 停留时间: '3 min' },
    },
    {
      id: 'primary',
      kind: 'primary',
      name: '初沉池',
      role: '去除悬浮物',
      volume: 2400,
      area: 900,
      depth: 3.2,
      ports: [P('in', 'in', 'influent'), P('out', 'out', 'influent'), P('sludge', 'out', 'waste_sludge')],
      states: ['ss', 'cod'],
      meta: { 表面负荷: '1.8 m³/m²·h' },
    },
    {
      id: 'stormstore',
      kind: 'storage',
      name: '雨水调蓄池',
      role: '削峰 · 分流',
      volume: 16000,
      ports: [P('in', 'in', 'influent'), P('out', 'out', 'influent')],
      states: ['volume'],
      interventions: ['stormStore'],
      meta: { 容量: '16 000 m³', 回流率: '≤320 m³/h', 接入点: '进水总管旁通' },
    },
    {
      id: 'anaerobic',
      kind: 'anaerobic',
      name: '厌氧池',
      role: '释磷 · 水解酸化',
      volume: 3000,
      ports: [P('in', 'in', 'influent'), P('ras', 'in', 'return_activated_sludge'), P('out', 'out', 'mixed_liquor')],
      states: ['cod', 'nh', 'no3', 'tp', 'do', 'mlss', 'alk'],
      meta: { 溶解氧: '<0.2 mg/L', 搅拌: '潜水搅拌器 ×4' },
    },
    {
      id: 'anoxic',
      kind: 'anoxic',
      name: '缺氧池',
      role: '反硝化 · 脱氮',
      volume: 4500,
      ports: [P('in', 'in', 'mixed_liquor'), P('ir', 'in', 'internal_recycle'), P('out', 'out', 'mixed_liquor')],
      states: ['cod', 'nh', 'no3', 'tp', 'do', 'mlss', 'alk'],
      interventions: ['carbonDose'],
      meta: { 溶解氧: '0.2–0.5 mg/L', 内回流比: '设计 2.0×Q' },
    },
    {
      id: 'aerobic1',
      kind: 'aerobic',
      name: '好氧池 A',
      role: '硝化 · 有机物氧化',
      volume: 5000,
      ports: [P('in', 'in', 'mixed_liquor'), P('out', 'out', 'mixed_liquor'), P('air', 'in', 'air'), P('chem', 'in', 'chemical')],
      states: ['cod', 'nh', 'no3', 'tp', 'do', 'mlss', 'alk'],
      interventions: ['doSetpoint', 'pacDose', 'alkDose'],
      meta: { 曝气器: '微孔曝气盘 ×1200', 溶解氧: '设定 2.0 mg/L' },
    },
    {
      id: 'aerobic2',
      kind: 'aerobic',
      name: '好氧池 B',
      role: '硝化 · 有机物氧化',
      volume: 5000,
      ports: [P('in', 'in', 'mixed_liquor'), P('out', 'out', 'mixed_liquor'), P('air', 'in', 'air')],
      states: ['cod', 'nh', 'no3', 'tp', 'do', 'mlss', 'alk'],
      interventions: ['doSetpoint'],
      meta: { 曝气器: '微孔曝气盘 ×1200' },
    },
    {
      id: 'aerobic3',
      kind: 'aerobic',
      name: '好氧池 C',
      role: '硝化 · 有机物氧化',
      volume: 5000,
      ports: [P('in', 'in', 'mixed_liquor'), P('out', 'out', 'mixed_liquor'), P('ir', 'out', 'internal_recycle'), P('air', 'in', 'air')],
      states: ['cod', 'nh', 'no3', 'tp', 'do', 'mlss', 'alk'],
      interventions: ['doSetpoint'],
      meta: { 曝气器: '微孔曝气盘 ×1200', 内回流取水点: '末端' },
    },
    {
      id: 'blower',
      kind: 'blower',
      name: '鼓风机房',
      role: '供氧',
      ports: [P('air', 'out', 'air')],
      states: ['airflow'],
      interventions: ['aerationOn'],
      meta: { 机组: '离心风机 ×3（2 用 1 备）', 单机风量: '6 000 m³/h' },
    },
    {
      id: 'chemical',
      kind: 'chemical',
      name: '加药间',
      role: '除磷 · 补碳 · 调碱',
      ports: [P('chem', 'out', 'chemical')],
      states: ['pac', 'carbon', 'alk'],
      interventions: ['pacDose', 'carbonDose', 'alkDose'],
      meta: { PAC: '聚合氯化铝 10%', 碳源: '乙酸钠 25%', 碱度: '碳酸氢钠' },
    },
    {
      id: 'clarifier',
      kind: 'clarifier',
      name: '二沉池',
      role: '泥水分离',
      area: 2400,
      depth: 4.5,
      ports: [
        P('in', 'in', 'mixed_liquor'),
        P('out', 'out', 'effluent'),
        P('ras', 'out', 'return_activated_sludge'),
        P('was', 'out', 'waste_sludge'),
      ],
      states: ['blanket', 'xRas', 'xEff', 'slr'],
      interventions: ['rasRatio', 'wasRatio'],
      meta: { 形式: '辐流式周边传动', 刮泥机: '2 台' },
    },
    {
      id: 'disinfection',
      kind: 'disinfection',
      name: '消毒接触池',
      role: '灭活 · 接触时间',
      volume: 1800,
      ports: [P('in', 'in', 'effluent'), P('out', 'out', 'effluent')],
      states: ['cod', 'nh', 'tp', 'ss'],
      meta: { 工艺: '紫外 + 次氯酸钠备用', 接触时间: '30 min' },
    },
    {
      id: 'outlet',
      kind: 'outlet',
      name: '达标排放口',
      role: '计量 · 采样',
      ports: [P('in', 'in', 'effluent')],
      states: ['flow', 'cod', 'nh', 'tp', 'ss', 'tn'],
      meta: { 标准: 'GB 18918-2002 一级 A', 在线仪表: 'COD · 氨氮 · 总磷 · 总氮 · pH' },
    },
    {
      id: 'thickener',
      kind: 'thickener',
      name: '污泥浓缩池',
      role: '减容',
      area: 320,
      depth: 4.0,
      ports: [P('in', 'in', 'waste_sludge'), P('out', 'out', 'waste_sludge')],
      states: ['ss'],
      meta: { 进泥含水率: '99.2%', 出泥含水率: '97%' },
    },
    {
      id: 'dewatering',
      kind: 'dewatering',
      name: '脱水机房',
      role: '出泥',
      ports: [P('in', 'in', 'waste_sludge'), P('out', 'out', 'sludge_cake')],
      states: ['ss'],
      meta: { 设备: '离心脱水机 ×2', 泥饼含水率: '60%' },
    },
  ],
  connections: [
    { id: 'c-inlet-screen', from: { unit: 'inlet', port: 'out' }, to: { unit: 'screening', port: 'in' }, stream: 'influent' },
    { id: 'c-screen-grit', from: { unit: 'screening', port: 'out' }, to: { unit: 'grit', port: 'in' }, stream: 'influent' },
    { id: 'c-grit-primary', from: { unit: 'grit', port: 'out' }, to: { unit: 'primary', port: 'in' }, stream: 'influent' },
    {
      id: 'c-primary-storm-route',
      from: { unit: 'primary', port: 'out' },
      to: { unit: 'stormstore', port: 'in' },
      stream: 'influent',
      flowRef: 'stormDivertFlow',
    },
    {
      id: 'c-primary-anaerobic',
      from: { unit: 'primary', port: 'out' },
      to: { unit: 'anaerobic', port: 'in' },
      stream: 'influent',
      flowRef: 'influentFlow',
    },
    {
      id: 'c-storm-anaerobic',
      from: { unit: 'stormstore', port: 'out' },
      to: { unit: 'anaerobic', port: 'in' },
      stream: 'influent',
      flowRef: 'returnFlow',
    },
    { id: 'c-primary-sludge', from: { unit: 'primary', port: 'sludge' }, to: { unit: 'thickener', port: 'in' }, stream: 'waste_sludge' },
    {
      // A²/O 多点进水：一部分原水直接进缺氧池，为反硝化补充碳源。
      // 单点进水时内回流（2×Q）会把缺氧区 COD 稀释到 3–5 mg/L，
      // 反硝化缺碳 → 硝酸盐累积 → 出水 TN 超标。这是模型跑出来后才暴露的工艺问题。
      id: 'c-primary-anoxic-stepfeed',
      from: { unit: 'primary', port: 'out' },
      to: { unit: 'anoxic', port: 'in' },
      stream: 'influent',
      flowRef: 'stepFeedFraction',
    },
    { id: 'c-anaerobic-anoxic', from: { unit: 'anaerobic', port: 'out' }, to: { unit: 'anoxic', port: 'in' }, stream: 'mixed_liquor' },
    { id: 'c-anoxic-aerobic1', from: { unit: 'anoxic', port: 'out' }, to: { unit: 'aerobic1', port: 'in' }, stream: 'mixed_liquor' },
    { id: 'c-aerobic1-aerobic2', from: { unit: 'aerobic1', port: 'out' }, to: { unit: 'aerobic2', port: 'in' }, stream: 'mixed_liquor' },
    { id: 'c-aerobic2-aerobic3', from: { unit: 'aerobic2', port: 'out' }, to: { unit: 'aerobic3', port: 'in' }, stream: 'mixed_liquor' },
    { id: 'c-aerobic3-clarifier', from: { unit: 'aerobic3', port: 'out' }, to: { unit: 'clarifier', port: 'in' }, stream: 'mixed_liquor' },
    {
      id: 'c-aerobic3-anoxic-ir',
      from: { unit: 'aerobic3', port: 'ir' },
      to: { unit: 'anoxic', port: 'ir' },
      stream: 'internal_recycle',
      flowRef: 'internalRecycleFlow',
      recycle: true,
    },
    {
      id: 'c-clarifier-anaerobic-ras',
      from: { unit: 'clarifier', port: 'ras' },
      to: { unit: 'anaerobic', port: 'ras' },
      stream: 'return_activated_sludge',
      flowRef: 'rasFlow',
      recycle: true,
    },
    { id: 'c-clarifier-was', from: { unit: 'clarifier', port: 'was' }, to: { unit: 'thickener', port: 'in' }, stream: 'waste_sludge', flowRef: 'wasFlow' },
    { id: 'c-clarifier-effluent', from: { unit: 'clarifier', port: 'out' }, to: { unit: 'disinfection', port: 'in' }, stream: 'effluent' },
    { id: 'c-disinfection-outlet', from: { unit: 'disinfection', port: 'out' }, to: { unit: 'outlet', port: 'in' }, stream: 'effluent' },
    { id: 'c-thickener-dewatering', from: { unit: 'thickener', port: 'out' }, to: { unit: 'dewatering', port: 'in' }, stream: 'waste_sludge' },
    { id: 'c-blower-aerobic1', from: { unit: 'blower', port: 'air' }, to: { unit: 'aerobic1', port: 'air' }, stream: 'air', flowRef: 'airflow' },
    { id: 'c-blower-aerobic2', from: { unit: 'blower', port: 'air' }, to: { unit: 'aerobic2', port: 'air' }, stream: 'air', flowRef: 'airflow' },
    { id: 'c-blower-aerobic3', from: { unit: 'blower', port: 'air' }, to: { unit: 'aerobic3', port: 'air' }, stream: 'air', flowRef: 'airflow' },
    { id: 'c-chem-aerobic1', from: { unit: 'chemical', port: 'chem' }, to: { unit: 'aerobic1', port: 'chem' }, stream: 'chemical', flowRef: 'pacFlow' },
  ],
};

export function unitsByKind(topo: ProcessTopology): Map<UnitKind, UnitSpec[]> {
  const map = new Map<UnitKind, UnitSpec[]>();
  for (const u of topo.units) {
    const list = map.get(u.kind) ?? [];
    list.push(u);
    map.set(u.kind, list);
  }
  return map;
}

export function findUnit(topo: ProcessTopology, id: string): UnitSpec | undefined {
  return topo.units.find((u) => u.id === id);
}

export function incoming(topo: ProcessTopology, unitId: string): Connection[] {
  return topo.connections.filter((c) => c.to.unit === unitId);
}

export function outgoing(topo: ProcessTopology, unitId: string): Connection[] {
  return topo.connections.filter((c) => c.from.unit === unitId);
}

/** 拓扑校验：端口存在、每单元有进有出、回流闭合。编排器用它决定能否保存。 */
export interface TopologyIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  unitId?: string;
  connectionId?: string;
}

export function validateTopology(topo: ProcessTopology): TopologyIssue[] {
  const issues: TopologyIssue[] = [];
  const ids = new Set<string>();

  for (const unit of topo.units) {
    if (ids.has(unit.id)) {
      issues.push({ severity: 'error', code: 'DUP_UNIT', message: `单元 ID 重复：${unit.id}`, unitId: unit.id });
    }
    ids.add(unit.id);
    const portIds = new Set(unit.ports.map((p) => p.id));
    for (const conn of topo.connections) {
      if (conn.from.unit === unit.id && !portIds.has(conn.from.port)) {
        issues.push({
          severity: 'error',
          code: 'BAD_PORT',
          message: `${unit.name} 缺少出口端口 ${conn.from.port}`,
          unitId: unit.id,
          connectionId: conn.id,
        });
      }
      if (conn.to.unit === unit.id && !portIds.has(conn.to.port)) {
        issues.push({
          severity: 'error',
          code: 'BAD_PORT',
          message: `${unit.name} 缺少入口端口 ${conn.to.port}`,
          unitId: unit.id,
          connectionId: conn.id,
        });
      }
    }
  }

  for (const conn of topo.connections) {
    if (!ids.has(conn.from.unit)) {
      issues.push({ severity: 'error', code: 'MISSING_UNIT', message: `连接 ${conn.id} 引用了不存在的源单元 ${conn.from.unit}`, connectionId: conn.id });
    }
    if (!ids.has(conn.to.unit)) {
      issues.push({ severity: 'error', code: 'MISSING_UNIT', message: `连接 ${conn.id} 引用了不存在的目标单元 ${conn.to.unit}`, connectionId: conn.id });
    }
    if (conn.from.unit === conn.to.unit) {
      issues.push({ severity: 'error', code: 'SELF_LOOP', message: `连接 ${conn.id} 自连`, connectionId: conn.id });
    }
  }

  for (const unit of topo.units) {
    const hasIn = incoming(topo, unit.id).length > 0;
    const hasOut = outgoing(topo, unit.id).length > 0;
    if (unit.kind === 'inlet' && !hasOut) {
      issues.push({ severity: 'error', code: 'DEAD_END', message: `进水单元 ${unit.name} 没有出口`, unitId: unit.id });
    }
    if (unit.kind === 'outlet' && !hasIn) {
      issues.push({ severity: 'error', code: 'DEAD_END', message: `排放单元 ${unit.name} 没有入口`, unitId: unit.id });
    }
    if (unit.kind !== 'inlet' && unit.kind !== 'blower' && unit.kind !== 'chemical' && !hasIn) {
      issues.push({ severity: 'warning', code: 'NO_INPUT', message: `${unit.name} 没有入口物流`, unitId: unit.id });
    }
    if (unit.kind !== 'outlet' && unit.kind !== 'dewatering' && unit.kind !== 'storage' && !hasOut) {
      issues.push({ severity: 'warning', code: 'NO_OUTPUT', message: `${unit.name} 没有出口物流`, unitId: unit.id });
    }
  }

  if (topo.train.length === 0) {
    issues.push({ severity: 'error', code: 'EMPTY_TRAIN', message: '主处理序列为空，引擎无法推进' });
  }
  for (const id of topo.train) {
    const unit = topo.units.find((u) => u.id === id);
    if (!unit) {
      issues.push({ severity: 'error', code: 'TRAIN_MISSING', message: `主序列引用了不存在的单元 ${id}`, unitId: id });
    } else if (!unit.volume) {
      issues.push({ severity: 'warning', code: 'TRAIN_NO_VOLUME', message: `主序列单元 ${unit.name} 没有容积，无法做停留时间计算`, unitId: id });
    }
  }

  return issues;
}

/** 从拓扑派生主序列的水力停留时间（小时）；flowM3h 为进水流量 m³/h */
export function hydraulicRetention(topo: ProcessTopology, flowM3h: number): { unit: string; name: string; volume: number; hrt: number }[] {
  return topo.train
    .map((id) => findUnit(topo, id))
    .filter((u): u is UnitSpec => Boolean(u?.volume))
    .map((u) => ({ unit: u.id, name: u.name, volume: u.volume!, hrt: u.volume! / Math.max(1, flowM3h) }));
}

/** 总容积，界面显示 "生物池 22 500 m³" 用 */
export function totalTrainVolume(topo: ProcessTopology): number {
  return topo.train.reduce((sum, id) => sum + (findUnit(topo, id)?.volume ?? 0), 0);
}

/** 从拓扑派生主序列：按 train 顺序给出生物学单元及其序号 */
export function deriveTrain(topo: ProcessTopology): { spec: UnitSpec; index: number }[] {
  const byId = new Map(topo.units.map((u) => [u.id, u]));
  return topo.train
    .map((id) => byId.get(id))
    .filter((u): u is UnitSpec => Boolean(u))
    .map((spec, index) => ({ spec, index }));
}
