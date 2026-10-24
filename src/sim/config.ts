export type TankKind = 'anaerobic' | 'anoxic' | 'aerobic';

export interface TankConfig {
  id: string;
  name: string;
  short: string;
  kind: TankKind;
  volume: number;
}

export interface Limits {
  cod: number;
  bod: number;
  ss: number;
  nh: number;
  tn: number;
  tp: number;
  phMin: number;
  phMax: number;
}

export const LIMITS: Limits = {
  cod: 50,
  bod: 10,
  ss: 10,
  nh: 5,
  tn: 15,
  tp: 0.5,
  phMin: 6,
  phMax: 9,
};

export const PLANT = {
  name: '澄川再生水厂',
  code: 'CC-WWTP-03',
  capacityM3d: 48000,
  designFlowM3h: 2000,
  tanks: [
    { id: 'anaerobic', name: '厌氧池', short: '厌氧', kind: 'anaerobic', volume: 3000 },
    { id: 'anoxic', name: '缺氧池', short: '缺氧', kind: 'anoxic', volume: 4500 },
    { id: 'aerobic1', name: '好氧池 A', short: '好氧A', kind: 'aerobic', volume: 5000 },
    { id: 'aerobic2', name: '好氧池 B', short: '好氧B', kind: 'aerobic', volume: 5000 },
    { id: 'aerobic3', name: '好氧池 C', short: '好氧C', kind: 'aerobic', volume: 5000 },
  ] as TankConfig[],
  clarifier: { area: 3600, depth: 4.5 },
  siteAreaHa: 4.2,
  dischargeStandard: 'GB 18918-2002 一级 A',
} as const;

export const BIO_VOLUME = PLANT.tanks.reduce((sum, t) => sum + t.volume, 0);
export const AEROBIC_VOLUME = PLANT.tanks.filter((t) => t.kind === 'aerobic').reduce((sum, t) => sum + t.volume, 0);

export interface ControlSettings {
  doSetpoint: number;
  internalRecirc: number;
  rasRatio: number;
  wasRatio: number;
  pacDose: number;
  carbonDose: number;
  alkDose: number;
  stormStore: number;
  /** 多点进水：直接进入缺氧池的原水比例（0–0.5），为反硝化补碳源 */
  stepFeed: number;
  aiEnabled: boolean;
}

export const DEFAULT_CONTROLS: ControlSettings = {
  doSetpoint: 2.0,
  internalRecirc: 2.0,
  rasRatio: 0.8,
  wasRatio: 0.0085,
  pacDose: 40,
  carbonDose: 0,
  alkDose: 0,
  stormStore: 0,
  stepFeed: 0.3,
  aiEnabled: true,
};

export const CONTROL_BOUNDS: Record<
  keyof Omit<ControlSettings, 'aiEnabled'>,
  { min: number; max: number; step: number; unit: string; label: string; precision: number }
> = {
  doSetpoint: { min: 0.8, max: 4.0, step: 0.1, unit: 'mg/L', label: '好氧区溶解氧设定', precision: 1 },
  internalRecirc: { min: 0, max: 3.5, step: 0.1, unit: '×Q', label: '内回流比', precision: 1 },
  rasRatio: { min: 0.3, max: 1.5, step: 0.05, unit: '×Q', label: '污泥回流比', precision: 2 },
  wasRatio: { min: 0.002, max: 0.03, step: 0.001, unit: '×Q', label: '剩余污泥排放', precision: 3 },
  pacDose: { min: 0, max: 60, step: 1, unit: 'mg/L', label: 'PAC 投加', precision: 0 },
  carbonDose: { min: 0, max: 60, step: 1, unit: 'mg/L', label: '碳源投加', precision: 0 },
  alkDose: { min: 0, max: 120, step: 2, unit: 'mg/L', label: '碱度投加', precision: 0 },
  stormStore: { min: 0, max: 1, step: 0.1, unit: '', label: '雨水调蓄分流', precision: 1 },
  stepFeed: { min: 0, max: 0.5, step: 0.05, unit: '×Q', label: '缺氧区多点进水', precision: 2 },
};

export const INFLUENT_DESIGN = {
  flow: 2000,
  cod: 350,
  bod: 150,
  ss: 180,
  nh: 34,
  tn: 44,
  tp: 4.8,
  ph: 7.2,
  temperature: 20,
  alkalinity: 320,
};
