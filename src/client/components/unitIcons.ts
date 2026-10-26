import type { UnitKind } from '../../model/topology';

/**
 * 工艺单元图标（Unicode 几何符号，不引入图标库）。
 *
 * 不用 emoji：工控深色底上彩色 emoji 会跳出来抢注意力，而且不同系统字形不一。
 * 这里选的都是等宽、有明确"设备语义"的符号，字号统一，颜色跟随主题。
 */
export const UNIT_KIND_ICON: Record<UnitKind, string> = {
  inlet: '⇥',
  screening: '≣',
  grit: '⌗',
  primary: '▤',
  anaerobic: '◍',
  anoxic: '◐',
  aerobic: '◉',
  clarifier: '◎',
  disinfection: '☀',
  outlet: '⇥',
  storage: '▭',
  thickener: '▽',
  dewatering: '⬒',
  blower: '≋',
  chemical: '⬢',
  pump: '⊕',
  splitter: '⑂',
};
