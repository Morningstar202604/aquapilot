/**
 * 共享的工艺状态类型。
 *
 * 这些类型描述"界面上要展示什么"，不绑定任何具体引擎。
 * 拓扑求解引擎（networkEngine）与固定五池引擎（engine）都产出这些结构，
 * 协议层只依赖这里，不依赖引擎实现。
 */

export interface InfluentState {
  flow: number;
  cod: number;
  bod: number;
  ss: number;
  nh: number;
  tn: number;
  tp: number;
  ph: number;
  temperature: number;
  alkalinity: number;
}

export interface EffluentState {
  flow: number;
  cod: number;
  bod: number;
  ss: number;
  nh: number;
  tn: number;
  tp: number;
  ph: number;
  temperature: number;
}

export interface TankState {
  id: string;
  name: string;
  short: string;
  kind: 'anaerobic' | 'anoxic' | 'aerobic';
  volume: number;
  cod: number;
  nh: number;
  no3: number;
  tp: number;
  do: number;
  mlss: number;
  alkalinity: number;
  temperature: number;
  codRemoved: number;
  nhRemoved: number;
  o2Demand: number;
  klaUsed: number;
}

export interface ClarifierState {
  blanketM: number;
  sludgeMassKg: number;
  xRas: number;
  xEff: number;
  slr: number;
  underflowM3h: number;
  area: number;
  depth: number;
}

export interface EnergyState {
  blowerKw: number;
  mixerKw: number;
  pumpKw: number;
  totalKw: number;
  specificKwhM3: number;
}

export interface CostState {
  energyToday: number;
  chemicalToday: number;
  sludgeToday: number;
  totalToday: number;
  total: number;
}

export interface Alarm {
  id: string;
  at: number;
  severity: 'warning' | 'critical';
  code: string;
  message: string;
  metric?: string;
  value?: number;
}
