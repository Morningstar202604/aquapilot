/**
 * Generate M1b phase 1 / alarm-history oracle.
 *
 * Phase 1 (`resolveHydraulics`) is exercised through the real TS function so
 * the Rust port must reproduce both the storm storage state machine and the
 * derived influent fields. Alarm history is exercised through `pushAlarm` so
 * de-duplication, sequence numbers and the 80-entry cap stay byte-exact.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ControlSettings } from '../src/sim/config';
import type { ScenarioSpec } from '../src/sim/scenarios';
import type { NetworkSimState } from '../src/sim/networkTypes';
import { pushAlarm, resolveHydraulics } from '../src/sim/networkEngine';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = resolve(ROOT, 'rust/golden/sim-step.json');
const SOURCES = ['src/sim/networkEngine.ts', 'src/sim/forcing.ts', 'src/sim/influentSeries.ts'];

function sha256(path: string): string {
  return createHash('sha256')
    .update(readFileSync(resolve(ROOT, path)))
    .digest('hex');
}

interface HydraulicCase {
  name: string;
  seed: number;
  rngCount: number;
  timeMin: number;
  dtH: number;
  stormStorageM3: number;
  stormStore: number;
  scenario: ScenarioSpec | null;
}

const HYDRAULIC_CASES: HydraulicCase[] = [
  { name: 'dry', seed: 7, rngCount: 0, timeMin: 0, dtH: 1, stormStorageM3: 0, stormStore: 0.3, scenario: null },
  {
    name: 'dry-storage-return',
    seed: 7,
    rngCount: 5,
    timeMin: 300,
    dtH: 1,
    stormStorageM3: 500,
    stormStore: 0.3,
    scenario: null,
  },
  {
    name: 'storm-start',
    seed: 11,
    rngCount: 3,
    timeMin: 60,
    dtH: 1,
    stormStorageM3: 0,
    stormStore: 0.25,
    scenario: { type: 'storm', durationMin: 240, startedAt: 0, magnitude: 1 },
  },
  {
    name: 'storm-middle',
    seed: 11,
    rngCount: 20,
    timeMin: 120,
    dtH: 0.5,
    stormStorageM3: 2500,
    stormStore: 0.4,
    scenario: { type: 'storm', durationMin: 240, startedAt: 0, magnitude: 1.4 },
  },
  {
    name: 'storm-full',
    seed: 13,
    rngCount: 0,
    timeMin: 30,
    dtH: 0.25,
    stormStorageM3: 15990,
    stormStore: 0.5,
    scenario: { type: 'storm', durationMin: 120, startedAt: 0, magnitude: 1 },
  },
  {
    name: 'storm-zero-store',
    seed: 13,
    rngCount: 9,
    timeMin: 90,
    dtH: 1,
    stormStorageM3: 4000,
    stormStore: 0,
    scenario: { type: 'storm', durationMin: 120, startedAt: 0, magnitude: 2 },
  },
  {
    name: 'storm-ending',
    seed: 17,
    rngCount: 2,
    timeMin: 240,
    dtH: 1,
    stormStorageM3: 12000,
    stormStore: 0.35,
    scenario: { type: 'storm', durationMin: 240, startedAt: 0, magnitude: 0.8 },
  },
  {
    name: 'low-flow-clamp',
    seed: 19,
    rngCount: 1,
    timeMin: 720,
    dtH: 1,
    stormStorageM3: 0,
    stormStore: 0.1,
    scenario: null,
  },
  {
    name: 'other-scenario',
    seed: 23,
    rngCount: 4,
    timeMin: 600,
    dtH: 0.75,
    stormStorageM3: 800,
    stormStore: 0.5,
    scenario: { type: 'shock_load', durationMin: 120, startedAt: 0, magnitude: 2 },
  },
  {
    name: 'toxic-storage',
    seed: 29,
    rngCount: 6,
    timeMin: 1000,
    dtH: 2,
    stormStorageM3: 100,
    stormStore: 0.5,
    scenario: { type: 'toxic', durationMin: 180, startedAt: 0, magnitude: 1 },
  },
];

const CONTROL_BASE: ControlSettings = {
  doSetpoint: 2,
  internalRecirc: 2,
  rasRatio: 0.8,
  wasRatio: 0.0085,
  pacDose: 40,
  carbonDose: 0,
  alkDose: 0,
  stormStore: 0,
  stepFeed: 0.3,
  aiEnabled: true,
};

function hydraulicState(c: HydraulicCase): NetworkSimState {
  return {
    timeMin: c.timeMin,
    seed: c.seed,
    rngCount: c.rngCount,
    scenario: c.scenario,
    controls: { ...CONTROL_BASE, stormStore: c.stormStore },
    stormStorageM3: c.stormStorageM3,
    influentSeries: null,
    uncertainty: undefined,
  } as unknown as NetworkSimState;
}

interface AlarmPush {
  at: number;
  code: string;
  severity: 'warning' | 'critical';
  message: string;
  metric: string;
  value: number;
}

interface AlarmCase {
  name: string;
  initialSeq: number;
  pushes: AlarmPush[];
}

const ALARM_CASES: AlarmCase[] = [
  {
    name: 'unique',
    initialSeq: 0,
    pushes: [0, 1, 2, 3, 4].map((i) => ({
      at: i,
      code: `C${i}`,
      severity: 'warning',
      message: `m${i}`,
      metric: 'x',
      value: i,
    })),
  },
  {
    name: 'dedup-window',
    initialSeq: 3,
    pushes: [
      { at: 0, code: 'EFF_NH', severity: 'critical', message: 'a', metric: 'nh', value: 6 },
      { at: 10, code: 'EFF_NH', severity: 'critical', message: 'a', metric: 'nh', value: 6 },
      { at: 44.999, code: 'EFF_NH', severity: 'critical', message: 'a', metric: 'nh', value: 6 },
      { at: 45, code: 'EFF_NH', severity: 'critical', message: 'a', metric: 'nh', value: 6 },
      { at: 89.999, code: 'EFF_NH', severity: 'critical', message: 'a', metric: 'nh', value: 6 },
      { at: 90, code: 'EFF_NH', severity: 'critical', message: 'a', metric: 'nh', value: 6 },
    ],
  },
  {
    name: 'cap-100',
    initialSeq: 0,
    pushes: Array.from({ length: 100 }, (_, i) => ({
      at: i,
      code: `C${i}`,
      severity: i % 2 ? 'warning' : 'critical',
      message: `m${i}`,
      metric: 'x',
      value: i,
    })),
  },
  {
    name: 'exactly-80',
    initialSeq: 0,
    pushes: Array.from({ length: 80 }, (_, i) => ({
      at: i,
      code: `C${i}`,
      severity: 'warning',
      message: `m${i}`,
      metric: 'x',
      value: i,
    })),
  },
  {
    name: 'cap-81',
    initialSeq: 0,
    pushes: Array.from({ length: 81 }, (_, i) => ({
      at: i,
      code: `C${i}`,
      severity: 'warning',
      message: `m${i}`,
      metric: 'x',
      value: i,
    })),
  },
  {
    name: 'repeating-ten',
    initialSeq: 7,
    pushes: Array.from({ length: 120 }, (_, i) => ({
      at: i * 10,
      code: `C${i % 10}`,
      severity: 'warning',
      message: `m${i}`,
      metric: 'x',
      value: i,
    })),
  },
  {
    name: 'descending-time',
    initialSeq: 2,
    pushes: [100, 90, 80, 70, 60].map((at, i) => ({
      at,
      code: `C${i}`,
      severity: 'warning',
      message: `m${i}`,
      metric: 'x',
      value: i,
    })),
  },
];

function alarmState(): NetworkSimState {
  return {
    timeMin: 0,
    alarms: [],
    alarmSeq: 0,
  } as unknown as NetworkSimState;
}

const hydraulics = HYDRAULIC_CASES.map((c) => {
  const state = hydraulicState(c);
  const out = resolveHydraulics(state, c.dtH);
  return {
    ...c,
    output: { influent: out.influent, q: out.Q, stormStorageM3: state.stormStorageM3 },
  };
});

const alarms = ALARM_CASES.map((c) => {
  const state = alarmState();
  state.alarmSeq = c.initialSeq;
  for (const push of c.pushes) {
    state.timeMin = push.at;
    pushAlarm(state, push.severity, push.code, push.message, push.metric, push.value);
  }
  return { ...c, output: { alarms: state.alarms, alarmSeq: state.alarmSeq } };
});

const payload = {
  schema: 'aquapilot.sim.step.v1',
  generatedBy: 'scripts/gen-sim-step.ts',
  oracle: 'resolveHydraulics + pushAlarm',
  note: 'M1b phase 1 and alarm-history parity. Minimal pre-state, not a whole-plant step.',
  sources: Object.fromEntries(SOURCES.map((p) => [p, sha256(p)])),
  hydraulics,
  alarms,
};

const text = `${JSON.stringify(payload, null, 2)}\n`;
if (process.argv.includes('--check')) {
  const existing = readFileSync(OUT, 'utf8');
  if (existing !== text) {
    console.error(`contract drift: ${OUT}`);
    console.error('run `npm run gen:sim-step` and review the diff');
    process.exit(1);
  }
  console.log(`contract ok: ${OUT} (hydraulics=${hydraulics.length}, alarms=${alarms.length})`);
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT}: hydraulics=${hydraulics.length} alarms=${alarms.length}`);
}
