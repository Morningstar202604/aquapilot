import type { Alarm, EffluentState, EnergyState, InfluentState, TankState, ClarifierState, CostState } from '../sim/plantTypes';
import type { ControlSettings, Limits } from '../sim/config';
import type { ScenarioSpec } from '../sim/scenarios';
import type { Answer, Recommendation } from '../ai/agent';
import type { ProcessTopology } from '../model/topology';

export interface TrendPoint {
  t: number;
  influentCod: number;
  influentNh: number;
  influentFlow: number;
  effluentCod: number;
  effluentNh: number;
  effluentTn: number;
  effluentTp: number;
  effluentSs: number;
  do: number;
  mlss: number;
  energyKw: number;
  blanket: number;
}

export interface PlantSnapshot {
  timeMin: number;
  simulatedAt: string;
  speed: number;
  paused: boolean;
  influent: InfluentState;
  effluent: EffluentState;
  tanks: TankState[];
  clarifier: ClarifierState;
  controls: ControlSettings;
  scenario: ScenarioSpec | null;
  energy: EnergyState;
  cost: CostState;
  srtDays: number;
  fmRatio: number;
  score: number;
  margins: { metric: string; ratio: number; value: number; limit: number }[];
  alarms: Alarm[];
  activeAlarms: Alarm[];
  trends: TrendPoint[];
  forecast: {
    points: {
      minute: number;
      cod: number;
      nh: number;
      tn: number;
      tp: number;
      ss: number;
      doLevel: number;
      score: number;
    }[];
    violations: { metric: string; minute: number; value: number; limit: number }[];
  } | null;
  recommendation: Recommendation | null;
  limits: Limits;
  totals: { inflowM3: number; energyKwh: number; cost: number; wasteSludgeKg: number; elapsedMin: number };
  stormStorageM3: number;
  reactorCount: number;
}

export type ClientMessage =
  | { type: 'hello' }
  | { type: 'chat'; text: string }
  | { type: 'control'; patch: Partial<ControlSettings> }
  | { type: 'aiEnabled'; enabled: boolean }
  | { type: 'applyRecommendation' }
  | { type: 'scenario'; kind: 'start'; scenario: ScenarioSpec['type']; durationMin?: number; magnitude?: number }
  | { type: 'scenario'; kind: 'clear' }
  | { type: 'sim'; action: 'pause' | 'resume' | 'reset' }
  | { type: 'speed'; value: number }
  | { type: 'refreshDecision' }
  | { type: 'topology'; action: 'get' }
  | { type: 'topology'; action: 'apply'; topology: ProcessTopology };

export type ServerMessage =
  | { type: 'snapshot'; data: PlantSnapshot }
  | { type: 'chat'; question: string; answer: Answer }
  | { type: 'decision'; data: Recommendation }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'simState'; paused: boolean; speed: number }
  | { type: 'topology'; data: ProcessTopology; dirty: boolean; readiness: { ready: boolean; blockers: string[]; warnings: string[]; derived: { trainUnits: number; bioVolume: number; hrtHours: number; aerobicVolume: number } } };


