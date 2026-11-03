import type { StreamKind, UnitKind } from '../model/topology';

/**
 * 物流与单元的展示元数据（唯一来源）。
 *
 * 这些表此前在 PlantCanvas / ProcessEditor / UnitInspector 各存一份：
 * 颜色改一处忘一处，图例和端口就会对不上（历史上进水与出水曾经同色）。
 * 展示层只允许从这里取，组件里不再写颜色字面量。
 */

export interface StreamMeta {
  label: string;
  /** 端口旁的极短标签：只保留区分度最高的两个字 */
  short: string;
  color: string;
  width: number;
  dash?: string;
  /** 是否在总览图上标注物流名（空气/药剂线太密，不标） */
  labelInLegend: boolean;
}

export const STREAM_META: Record<StreamKind, StreamMeta> = {
  influent: { label: '进水', short: '进水', color: '#3d7fd9', width: 2.6, labelInLegend: true },
  mixed_liquor: { label: '混合液', short: '混合', color: '#12876f', width: 2.4, labelInLegend: true },
  return_activated_sludge: {
    label: '污泥回流',
    short: '污泥',
    color: '#b0770e',
    width: 1.8,
    dash: '7 5',
    labelInLegend: true,
  },
  waste_sludge: { label: '剩余污泥', short: '排泥', color: '#8a5f2e', width: 1.4, dash: '5 4', labelInLegend: true },
  internal_recycle: { label: '内回流', short: '内回', color: '#0d7f96', width: 1.8, dash: '3 5', labelInLegend: true },
  effluent: { label: '出水', short: '出水', color: '#0c9d7e', width: 2.2, labelInLegend: true },
  air: { label: '空气', short: '空气', color: '#38a8c9', width: 1, dash: '2 6', labelInLegend: true },
  chemical: { label: '药剂', short: '药剂', color: '#8e5fc9', width: 1.2, dash: '2 4', labelInLegend: true },
  sludge_cake: { label: '泥饼', short: '泥饼', color: '#6f5436', width: 1.2, dash: '4 4', labelInLegend: false },
};

export const streamLabel = (s: StreamKind): string => STREAM_META[s].label;
export const streamShort = (s: StreamKind): string => STREAM_META[s].short;
export const streamColor = (s: StreamKind): string => STREAM_META[s].color;

/** 图例展示顺序（与工艺流向一致，而不是对象键顺序） */
export const STREAM_LEGEND_ORDER: StreamKind[] = [
  'influent',
  'mixed_liquor',
  'internal_recycle',
  'return_activated_sludge',
  'waste_sludge',
  'air',
  'chemical',
];

export interface UnitKindMeta {
  label: string;
  /** 单色几何符号，不用 emoji：工控深色底上 emoji 会抢注意力且字形不一 */
  icon: string;
  /** 画布标题前的图标颜色（CSS 变量或 hex） */
  accent: string;
}

export const UNIT_META: Record<UnitKind, UnitKindMeta> = {
  inlet: { label: '进水', icon: '⇥', accent: 'var(--text-3)' },
  screening: { label: '格栅', icon: '≣', accent: 'var(--text-3)' },
  grit: { label: '沉砂', icon: '⌗', accent: 'var(--text-3)' },
  primary: { label: '初沉', icon: '▤', accent: 'var(--text-3)' },
  anaerobic: { label: '厌氧', icon: '◍', accent: 'var(--water-dim)' },
  anoxic: { label: '缺氧', icon: '◐', accent: 'var(--water-dim)' },
  aerobic: { label: '好氧', icon: '◉', accent: 'var(--cyan)' },
  clarifier: { label: '二沉', icon: '◎', accent: 'var(--amber)' },
  disinfection: { label: '消毒', icon: '☀', accent: 'var(--text-3)' },
  outlet: { label: '排放', icon: '⇥', accent: 'var(--text-3)' },
  storage: { label: '调蓄', icon: '▭', accent: 'var(--text-3)' },
  thickener: { label: '浓缩', icon: '▽', accent: 'var(--text-3)' },
  dewatering: { label: '脱水', icon: '⬒', accent: 'var(--text-3)' },
  blower: { label: '鼓风', icon: '≋', accent: 'var(--cyan)' },
  chemical: { label: '加药', icon: '⬢', accent: 'var(--purple-dim, #7a5f8a)' },
  pump: { label: '泵', icon: '⊕', accent: 'var(--text-3)' },
  splitter: { label: '分流', icon: '⑂', accent: 'var(--text-3)' },
};

export const unitKindLabel = (k: UnitKind): string => UNIT_META[k]?.label ?? k;
export const unitKindIcon = (k: UnitKind): string => UNIT_META[k]?.icon ?? '▢';
export const unitKindAccent = (k: UnitKind): string => UNIT_META[k]?.accent ?? 'var(--text-3)';
