/**
 * 工艺模板：三种可直接运行的厂型。
 *
 * 模板不是"画图预设"：每个都必须在服务端通过 checkRunReadiness + compileNetwork
 * + 预热，才允许出现在切换列表里。测试逐个验证（tests/presets.test.ts）。
 *
 * 设计取舍：全部由 PLANT_TOPOLOGY 深拷贝派生，避免复制 17 个单元的 JSON——
 * 复制会漂移，派生不会。差异只写「单元属性覆盖」（kind / volume / name）。
 * 不删单元：删掉厌氧池会导致进水与污泥回流没有合法端口，与其在模板里
 * 做拓扑手术，不如把厌氧池改成缺氧池——这才是 A/O 工艺的真实形态。
 */

import { PLANT_TOPOLOGY, ProcessTopology, UnitSpec } from './topology';

export interface Preset {
  id: string;
  name: string;
  description: string;
  /** 单元属性覆盖：kind / volume / area / depth / name / role */
  patch: Record<string, Partial<UnitSpec>>;
}

export const PRESETS: Preset[] = [
  {
    id: 'a2o-standard',
    name: 'A²/O 标准厂',
    description: '厌氧 3 000 + 缺氧 4 500 + 好氧 15 000 m³，内回流 2×Q、多点进水 0.3×Q。设计基准。',
    patch: {},
  },
  {
    id: 'a2o-deep-denit',
    name: 'A²/O 强化脱氮',
    description: '缺氧池扩至 7 500 m³、好氧池各 4 500 m³，适合总氮吃紧、碳源偏低的工况。',
    patch: {
      anoxic: { volume: 7500 },
      aerobic1: { volume: 4500 },
      aerobic2: { volume: 4500 },
      aerobic3: { volume: 4500 },
    },
  },
  {
    id: 'ao-no-anaerobic',
    name: 'A/O 无厌氧池',
    description: '首池由厌氧改为缺氧（反硝化），生物除磷失效，总磷完全依赖 PAC 化学兜底。',
    patch: {
      anaerobic: { kind: 'anoxic', name: '缺氧池 A', role: '反硝化 · 水解' },
      anoxic: { volume: 6000 },
      aerobic1: { volume: 6000 },
      aerobic2: { volume: 6000 },
      aerobic3: { volume: 6000 },
    },
  },
];

/** 把模板物化成一份独立的拓扑对象（深拷贝，调用方可安全修改） */
export function buildPreset(preset: Preset): ProcessTopology {
  const base: ProcessTopology = structuredClone(PLANT_TOPOLOGY);
  const units = base.units.map((u) => {
    const patch = preset.patch[u.id];
    return patch ? { ...u, ...patch } : u;
  });
  return {
    ...base,
    id: `preset-${preset.id}`,
    name: preset.name,
    units,
  };
}

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}
