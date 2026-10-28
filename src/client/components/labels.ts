import { CONTROL_BOUNDS } from '../../sim/config';
import { SCENARIOS } from '../../sim/scenarios';

export { CONTROL_BOUNDS };

export const SCENARIO_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(SCENARIOS).map(([k, v]) => [k, v.label]),
);

export function unitOf(key: string): string {
  return CONTROL_BOUNDS[key as keyof typeof CONTROL_BOUNDS]?.unit ?? '';
}

export function labelOf(key: string): string {
  return CONTROL_BOUNDS[key as keyof typeof CONTROL_BOUNDS]?.label ?? key;
}

export function precisionOf(key: string): number {
  return CONTROL_BOUNDS[key as keyof typeof CONTROL_BOUNDS]?.precision ?? 2;
}

/**
 * 全览模式的节点标题字号。
 *
 * 紧凑模式把字号放大到 24px 才能在 60% 缩放下读清，但长名字（污泥浓缩池、
 * 细格栅 · 曝气沉砂池）会压到相邻单元上——截图里「污泥浓缩池」盖住了
 * 脱水机房的边框，把两个设备读成一个。这里按估算宽度逐级降字号，
 * 仍放不下再截断加省略号：宁可少两个字，也不能让标题越界。
 *
 * 宽度估算按 CJK 全角 1em、其它 0.6em：只用于挑字号，不参与布局计算。
 */
export function fitCompactTitle(
  name: string,
  nodeWidth: number,
  options: { padding?: number; max?: number; min?: number } = {},
): { text: string; fontSize: number } {
  const short = name.split(' · ')[0];
  const padding = options.padding ?? 18;
  const max = options.max ?? 24;
  const min = options.min ?? 15;
  const available = Math.max(1, nodeWidth - padding);
  const widthOf = (text: string, size: number) =>
    [...text].reduce((sum, ch) => sum + (/[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? size : size * 0.5), 0);
  for (const size of [max, 22, 20, 18, 16, min]) {
    if (widthOf(short, size) <= available) return { text: short, fontSize: size };
  }
  let text = '';
  for (const ch of short) {
    if (widthOf(`${text}${ch}…`, min) > available) break;
    text += ch;
  }
  return { text: text.length > 0 ? `${text}…` : short.slice(0, 1), fontSize: min };
}
