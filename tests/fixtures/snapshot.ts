import type { PlantSnapshot } from '../../src/shared/protocol';
import { DEFAULT_CONTROLS, LIMITS } from '../../src/sim/config';

/**
 * 构造一份"结构完整、数值可断言"的快照。
 *
 * 组件测试只关心渲染逻辑，不需要真跑仿真——但快照必须字段齐全，
 * 否则测的是组件的容错分支而不是正常分支。
 */
export function makeSnapshot(overrides: Partial<PlantSnapshot> = {}): PlantSnapshot {
  const base: PlantSnapshot = {
    timeMin: 1440 + 90, // 第 2 天 01:30
    simulatedAt: new Date(0).toISOString(),
    speed: 1,
    paused: false,
    influent: {
      flow: 2000,
      cod: 320,
      bod: 140,
      ss: 180,
      nh: 30,
      tn: 40,
      tp: 4.2,
      ph: 7.2,
      temperature: 20,
      alkalinity: 320,
    },
    effluent: {
      flow: 1900,
      cod: 34.2,
      bod: 7.1,
      ss: 8.2,
      nh: 0.62,
      tn: 12.4,
      tp: 0.28,
      ph: 7.1,
      temperature: 20,
    },
    tanks: [],
    clarifier: {
      blanketM: 0.86,
      sludgeMassKg: 22000,
      xRas: 8600,
      xEff: 4,
      slr: 3.1,
      underflowM3h: 1600,
      area: 1500,
      depth: 4.5,
    },
    controls: { ...DEFAULT_CONTROLS },
    scenario: null,
    energy: { blowerKw: 120, mixerKw: 20, pumpKw: 30, totalKw: 170, specificKwhM3: 0.15 },
    cost: { energyToday: 500, chemicalToday: 80, sludgeToday: 40, totalToday: 620, total: 4000 },
    srtDays: 14.2,
    fmRatio: 0.096,
    score: 72,
    margins: [
      { metric: 'SS', ratio: 0.82, value: 8.2, limit: 10 },
      { metric: 'TN', ratio: 0.83, value: 12.4, limit: 15 },
      { metric: 'COD', ratio: 0.68, value: 34.2, limit: 50 },
    ],
    alarms: [],
    activeAlarms: [],
    alarmAttribution: {},
    health: {
      score: 82,
      grade: 'good',
      parts: [
        { label: '出水裕度', score: 82, weight: 0.35, detail: '最紧指标占限值 83%' },
        { label: '溶解氧', score: 90, weight: 0.15, detail: '2.00 / 设定 2.0' },
        { label: '污泥龄', score: 85, weight: 0.15, detail: '14.2 d' },
        { label: '二沉池', score: 80, weight: 0.2, detail: '泥位 0.86 m' },
        { label: '告警', score: 100, weight: 0.15, detail: '0 条活跃' },
      ],
    },
    trends: [],
    forecast: null,
    recommendation: null,
    forecastBand: null,
    benchmark: null,
    limits: LIMITS,
    totals: {
      inflowM3: 3000,
      energyKwh: 450,
      cost: 4000,
      wasteSludgeKg: 90,
      elapsedMin: 1530,
      energyCost: 3200,
      chemicalCost: 500,
      sludgeCost: 300,
    },
    stormStorageM3: 0,
    reactorCount: 5,
  };
  return { ...base, ...overrides };
}
