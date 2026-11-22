import { findUnit, type ProcessTopology, type StreamKind, type UnitKind, type UnitSpec } from './topology';

/**
 * 拓扑编辑器组件库与单元构造。
 *
 * 这些默认值（池容、端口、states/interventions）以前只存在于
 * ProcessEditor.tsx；抽到 model 层后，模板、测试和画布都能复用同一份定义，
 * 新增池型不必再在组件里找常量。
 */

export interface PaletteEntry {
  kind: UnitKind;
  name: string;
  role: string;
  group: string;
  ports: { id: string; kind: 'in' | 'out'; stream: StreamKind }[];
  volume?: number;
  area?: number;
  depth?: number;
}

export const PALETTE: PaletteEntry[] = [
  {
    group: '预处理',
    kind: 'screening',
    name: '格栅',
    role: '拦截',
    ports: [
      { id: 'in', kind: 'in', stream: 'influent' },
      { id: 'out', kind: 'out', stream: 'influent' },
    ],
  },
  {
    group: '预处理',
    kind: 'grit',
    name: '沉砂池',
    role: '除砂',
    ports: [
      { id: 'in', kind: 'in', stream: 'influent' },
      { id: 'out', kind: 'out', stream: 'influent' },
    ],
  },
  {
    group: '预处理',
    kind: 'primary',
    name: '初沉池',
    role: '去悬浮物',
    volume: 2400,
    area: 900,
    depth: 3.2,
    ports: [
      { id: 'in', kind: 'in', stream: 'influent' },
      { id: 'out', kind: 'out', stream: 'influent' },
      { id: 'sludge', kind: 'out', stream: 'waste_sludge' },
    ],
  },
  {
    group: '生物处理',
    kind: 'anaerobic',
    name: '厌氧池',
    role: '释磷',
    volume: 3000,
    ports: [
      { id: 'in', kind: 'in', stream: 'influent' },
      { id: 'ras', kind: 'in', stream: 'return_activated_sludge' },
      { id: 'out', kind: 'out', stream: 'mixed_liquor' },
    ],
  },
  {
    group: '生物处理',
    kind: 'anoxic',
    name: '缺氧池',
    role: '反硝化',
    volume: 4500,
    ports: [
      { id: 'in', kind: 'in', stream: 'mixed_liquor' },
      { id: 'ir', kind: 'in', stream: 'internal_recycle' },
      { id: 'out', kind: 'out', stream: 'mixed_liquor' },
    ],
  },
  {
    group: '生物处理',
    kind: 'aerobic',
    name: '好氧池',
    role: '硝化',
    volume: 5000,
    ports: [
      { id: 'in', kind: 'in', stream: 'mixed_liquor' },
      { id: 'out', kind: 'out', stream: 'mixed_liquor' },
      { id: 'air', kind: 'in', stream: 'air' },
      { id: 'chem', kind: 'in', stream: 'chemical' },
    ],
  },
  {
    group: '固液分离',
    kind: 'clarifier',
    name: '二沉池',
    role: '泥水分离',
    area: 3600,
    depth: 4.5,
    ports: [
      { id: 'in', kind: 'in', stream: 'mixed_liquor' },
      { id: 'out', kind: 'out', stream: 'effluent' },
      { id: 'ras', kind: 'out', stream: 'return_activated_sludge' },
      { id: 'was', kind: 'out', stream: 'waste_sludge' },
    ],
  },
  {
    group: '固液分离',
    kind: 'disinfection',
    name: '消毒池',
    role: '灭活',
    volume: 1800,
    ports: [
      { id: 'in', kind: 'in', stream: 'effluent' },
      { id: 'out', kind: 'out', stream: 'effluent' },
    ],
  },
  {
    group: '调蓄',
    kind: 'storage',
    name: '调蓄池',
    role: '削峰',
    volume: 16000,
    ports: [
      { id: 'in', kind: 'in', stream: 'influent' },
      { id: 'out', kind: 'out', stream: 'influent' },
    ],
  },
  {
    group: '公用工程',
    kind: 'blower',
    name: '鼓风机房',
    role: '供氧',
    ports: [{ id: 'air', kind: 'out', stream: 'air' }],
  },
  {
    group: '公用工程',
    kind: 'chemical',
    name: '加药间',
    role: '加药',
    ports: [{ id: 'chem', kind: 'out', stream: 'chemical' }],
  },
  {
    group: '污泥',
    kind: 'thickener',
    name: '浓缩池',
    role: '减容',
    area: 320,
    depth: 4,
    ports: [
      { id: 'in', kind: 'in', stream: 'waste_sludge' },
      { id: 'out', kind: 'out', stream: 'waste_sludge' },
    ],
  },
  {
    group: '污泥',
    kind: 'dewatering',
    name: '脱水机房',
    role: '出泥',
    ports: [
      { id: 'in', kind: 'in', stream: 'waste_sludge' },
      { id: 'out', kind: 'out', stream: 'sludge_cake' },
    ],
  },
];

const INTERVENTION_BY_KIND: Partial<Record<UnitKind, UnitSpec['interventions']>> = {
  anaerobic: [],
  anoxic: ['carbonDose'],
  aerobic: ['doSetpoint', 'pacDose', 'alkDose'],
  clarifier: ['rasRatio', 'wasRatio'],
  storage: ['stormStore'],
  chemical: ['pacDose', 'carbonDose', 'alkDose'],
};

const STATE_BY_KIND: Partial<Record<UnitKind, string[]>> = {
  anaerobic: ['cod', 'nh', 'no3', 'tp', 'do', 'mlss', 'alk'],
  anoxic: ['cod', 'nh', 'no3', 'tp', 'do', 'mlss', 'alk'],
  aerobic: ['cod', 'nh', 'no3', 'tp', 'do', 'mlss', 'alk'],
  clarifier: ['blanket', 'xRas', 'xEff', 'slr'],
  disinfection: ['cod', 'nh', 'tp', 'ss'],
  storage: ['volume'],
  blower: ['airflow'],
  chemical: ['pac', 'carbon', 'alk'],
};

export function nextUnitId(topo: ProcessTopology, kind: UnitKind): string {
  let i = 1;
  while (topo.units.some((u) => u.id === `${kind}${i}`)) i += 1;
  return `${kind}${i}`;
}

export const PALETTE_GROUPS = [...new Set(PALETTE.map((p) => p.group))];

/** 把组件库条目落成一个可运行单元，并在生物池的情况下接入主序列 */
export function insertPaletteUnit(
  topo: ProcessTopology,
  entry: PaletteEntry,
  pos?: { x: number; y: number },
): { topology: ProcessTopology; id: string } {
  const id = nextUnitId(topo, entry.kind);
  const unit: UnitSpec = {
    id,
    kind: entry.kind,
    name: entry.name,
    role: entry.role,
    volume: entry.volume,
    area: entry.area,
    depth: entry.depth,
    ports: entry.ports.map((p, i) => ({ ...p, order: i })),
    states: STATE_BY_KIND[entry.kind],
    interventions: INTERVENTION_BY_KIND[entry.kind],
  };
  const isBio = entry.kind === 'aerobic' || entry.kind === 'anoxic' || entry.kind === 'anaerobic';
  const next: ProcessTopology = {
    ...topo,
    units: [...topo.units, unit],
    train: isBio ? [...topo.train, id] : topo.train,
    positions: pos ? { ...(topo.positions ?? {}), [id]: pos } : topo.positions,
  };
  /**
   * 生物池自动接入主序列：插到 train 末端与它原有下游之间。
   * 其它类型保持独立，由用户自己连，避免乱接线。
   */
  if (isBio) {
    const lastId = topo.train[topo.train.length - 1];
    const lastUnit = lastId ? findUnit(topo, lastId) : undefined;
    const outPort = lastUnit?.ports.find((p) => p.kind === 'out' && p.stream === 'mixed_liquor');
    const inPort = unit.ports.find((p) => p.kind === 'in' && (p.stream === 'mixed_liquor' || p.stream === 'influent'));
    const newOut = unit.ports.find((p) => p.kind === 'out' && p.stream === 'mixed_liquor');
    if (lastUnit && outPort && inPort && newOut) {
      const downstream = topo.connections.find(
        (c) => c.from.unit === lastId && c.from.port === outPort.id && !c.recycle,
      );
      next.connections = topo.connections.map((c) =>
        downstream && c.id === downstream.id ? { ...c, from: { unit: id, port: newOut.id } } : c,
      );
      next.connections.push({
        id: `c-${lastId}-${id}`,
        from: { unit: lastId, port: outPort.id },
        to: { unit: id, port: inPort.id },
        stream: inPort.stream,
      });
    }
  }
  return { topology: next, id };
}

/** 复制单元：同规格副本，位置右下偏移 40px；连线不复制 */
export function duplicateTopologyUnit(
  topo: ProcessTopology,
  id: string,
): { topology: ProcessTopology; id: string } | null {
  const src = topo.units.find((u) => u.id === id);
  if (!src) return null;
  const newId = nextUnitId(topo, src.kind);
  const pos = topo.positions?.[id] ?? { x: 80, y: 80 };
  const unit: UnitSpec = {
    ...src,
    id: newId,
    name: `${src.name}·副本`,
    ports: src.ports.map((p, i) => ({ ...p, order: i })),
  };
  const nextPositions = Object.fromEntries([
    ...Object.entries(topo.positions ?? {}),
    [newId, { x: pos.x + 40, y: pos.y + 40 }],
  ]);
  return {
    topology: {
      ...topo,
      units: [...topo.units, unit],
      train: topo.train.includes(id) ? [...topo.train, newId] : topo.train,
      positions: nextPositions,
    },
    id: newId,
  };
}
