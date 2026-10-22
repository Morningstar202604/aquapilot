export type ScenarioType =
  'storm' | 'shock_load' | 'toxic' | 'blower_failure' | 'ras_failure' | 'power_outage' | 'winter' | 'chemical_shortage';

export interface ScenarioSpec {
  type: ScenarioType;
  durationMin: number;
  startedAt: number;
  magnitude: number;
}

export interface ScenarioMeta {
  type: ScenarioType;
  label: string;
  description: string;
  defaultDurationMin: number;
  defaultMagnitude: number;
}

export const SCENARIOS: Record<ScenarioType, ScenarioMeta> = {
  storm: {
    type: 'storm',
    label: '暴雨冲击',
    description: '降雨使进水量升至 1.8 倍，污染物被稀释，水力负荷与二沉池固体通量上升。',
    defaultDurationMin: 360,
    defaultMagnitude: 1,
  },
  shock_load: {
    type: 'shock_load',
    label: '高负荷冲击',
    description: '进水 COD 与氨氮同步升高约 80%，好氧区需氧量骤增。',
    defaultDurationMin: 240,
    defaultMagnitude: 1,
  },
  toxic: {
    type: 'toxic',
    label: '毒性抑制',
    description: '工业废水混入，异养菌与硝化菌活性受到抑制，出水氨氮存在超标风险。',
    defaultDurationMin: 300,
    defaultMagnitude: 1,
  },
  blower_failure: {
    type: 'blower_failure',
    label: '鼓风机故障',
    description: '一组鼓风机跳停，最大供气能力降至 50%，溶解氧可能失守。',
    defaultDurationMin: 180,
    defaultMagnitude: 0.5,
  },
  ras_failure: {
    type: 'ras_failure',
    label: '回流泵故障',
    description: '污泥回流中断，二沉池污泥界面快速上升，存在跑泥风险。',
    defaultDurationMin: 120,
    defaultMagnitude: 0,
  },
  power_outage: {
    type: 'power_outage',
    label: '全厂停电',
    description: '曝气与回流全部停止，溶解氧耗尽，工艺进入恢复期。',
    defaultDurationMin: 45,
    defaultMagnitude: 0,
  },
  winter: {
    type: 'winter',
    label: '低温工况',
    description: '水温降至 12 ℃，硝化速率显著下降，需提高污泥龄与溶解氧。',
    defaultDurationMin: 1440,
    defaultMagnitude: 12,
  },
  chemical_shortage: {
    type: 'chemical_shortage',
    label: '药剂短缺',
    description: 'PAC 库存不足，化学除磷停投，出水总磷需依靠生物除磷维持。',
    defaultDurationMin: 480,
    defaultMagnitude: 0,
  },
};

export const SCENARIO_ORDER: ScenarioType[] = [
  'storm',
  'shock_load',
  'toxic',
  'blower_failure',
  'ras_failure',
  'power_outage',
  'winter',
  'chemical_shortage',
];
