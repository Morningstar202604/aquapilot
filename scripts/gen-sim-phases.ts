/**
 * M1b phase 4/5 + metrics/alarms oracle generator.
 *
 * Freezes pure functions before wiring `stepNetwork` in Rust. It does not
 * claim whole-plant closure: the state here is the minimal pre-state each
 * phase reads, not a `NetworkSimState`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { evaluateAlarms } from '../src/sim/alarmRules';
import { effluentMarginRows, estimateMargin, qualityScore, worstRatio } from '../src/sim/metrics';
import { solveBiomass, solveEffluent, solveEnergyAndCost } from '../src/sim/networkEngine';
import { GB18918_1A, GB18918_1B } from '../src/sim/standards';
import type { ScenarioSpec } from '../src/sim/scenarios';

const OUT = 'rust/golden/sim-phases.json';

function hash(path: string): string {
  return createHash('sha256').update(readFileSync(path, 'utf8')).digest('hex');
}

const effluents = [
  { flow: 2000, cod: 20, bod: 5, ss: 6, nh: 1.2, tn: 8, tp: 0.2, ph: 7.1, temperature: 20 },
  { flow: 1900, cod: 46, bod: 9, ss: 9, nh: 4.5, tn: 14, tp: 0.45, ph: 7.0, temperature: 20 },
  { flow: 2100, cod: 55, bod: 12, ss: 14, nh: 6, tn: 18, tp: 0.7, ph: 6.9, temperature: 18 },
  { flow: 1800, cod: 10, bod: 2, ss: 2, nh: 0.5, tn: 4, tp: 0.05, ph: 7.3, temperature: 22 },
  { flow: 2200, cod: 0, bod: 0, ss: 0, nh: 0, tn: 0, tp: 0, ph: 7.0, temperature: 20 },
  { flow: 2000, cod: -1, bod: 5, ss: 5, nh: 1, tn: 8, tp: 0.2, ph: 7.0, temperature: 20 },
];

const limits = [GB18918_1A.limits, GB18918_1B.limits];
const metrics = effluents.flatMap((effluent) =>
  limits.map((limit) => ({
    effluent,
    limits: limit,
    rows: effluentMarginRows(effluent as never, limit as never),
    worstRatio: worstRatio(effluent as never, limit as never),
    score: qualityScore(effluent as never),
    estimate: estimateMargin(effluent as never, limit as never),
  })),
);

function spec(type: ScenarioSpec['type'], startedAt: number, durationMin: number, magnitude: number): ScenarioSpec {
  return { type, startedAt, durationMin, magnitude };
}

const alarmInputs = [
  {
    effluent: effluents[0],
    lastDo: 2,
    srtDays: 15,
    blanketM: 1,
    depth: 4.5,
    atMin: 100,
  },
  {
    effluent: effluents[2],
    lastDo: 0.4,
    srtDays: 5,
    blanketM: 4.2,
    depth: 4.5,
    atMin: 220,
  },
  {
    effluent: effluents[3],
    lastDo: 1.1,
    srtDays: 9,
    blanketM: 3.9,
    depth: 4.5,
    atMin: 0,
  },
  {
    effluent: effluents[1],
    lastDo: 0.9,
    srtDays: 7.5,
    blanketM: 2,
    depth: 4.5,
    atMin: 540,
  },
];
const standards = [null, GB18918_1A, GB18918_1B];
const alarms = standards.flatMap((standard) =>
  alarmInputs.map((input) => {
    const scoped = standard ? { ...input, standard } : input;
    const got = evaluateAlarms(scoped as never, standard as never);
    return { input: scoped, standard, expected: got };
  }),
);

const effluentInputs: Array<Record<string, unknown>> = [];
for (let i = 0; i < 48; i += 1) {
  const mode = i % 3;
  const scenario =
    i % 4 === 0
      ? null
      : i % 4 === 1
        ? spec('chemical_shortage', 0, 360, 1)
        : i % 4 === 2
          ? spec('storm', 0, 360, 1)
          : spec('toxic', 0, 360, 1);
  effluentInputs.push({
    qe: 1600 + (i % 6) * 80,
    temperature: 15 + (i % 5),
    xEff: [3, 8, 14, 25][i % 4],
    pacDose: [0, 1.5, 3][i % 3],
    scenario,
    timeMin: [10, 100, 300, 360][i % 4],
    lastCod: [30, 70, 120][i % 3],
    lastNh: [1, 4, 8][i % 3],
    lastNo3: [2, 8, 15][i % 3],
    lastTp: [0.2, 0.6, 1.5][i % 3],
    lastAlkalinity: [180, 220, 300][i % 3],
    asm1: mode === 0 ? { sI: 8 + i, sS: 12 + i } : null,
    asm2d: mode === 1 ? { sI: 5 + i, sF: 15 + i, sA: 3 + i } : null,
  });
}

const effluentCases = effluentInputs.map((input) => {
  const asm1 = input.asm1 as { sI: number; sS: number } | null;
  const asm2d = input.asm2d as { sI: number; sF: number; sA: number } | null;
  const fakeState: Record<string, unknown> = {
    scenario: input.scenario,
    controls: { pacDose: input.pacDose },
    timeMin: input.timeMin,
    effluent: {},
  };
  const lastReactor = {
    cod: input.lastCod,
    nh: input.lastNh,
    no3: input.lastNo3,
    tp: input.lastTp,
    alkalinity: input.lastAlkalinity,
    asm1: asm1 ? { S_I: asm1.sI, S_S: asm1.sS } : null,
    asm2d: asm2d ? { S_I: asm2d.sI, S_F: asm2d.sF, S_A: asm2d.sA } : null,
  };
  const pacDose = solveEffluent({
    state: fakeState,
    T: input.temperature,
    clar: { xEff: input.xEff },
    lastReactor,
    Qe: input.qe,
  } as never);
  return { input, expected: { effluent: fakeState.effluent, pacDose } };
});

const models = ['simple', 'asm1', 'asm2d'] as const;
const biomassCases = models.flatMap((modelMode, modelIndex) => {
  return Array.from({ length: 12 }, (_, i) => {
    const reactors = Array.from({ length: 3 }, (_, r) => {
      if (modelMode === 'asm1') {
        return {
          volume: 1200 + r * 300,
          asm1: { X_B_H: 1200 + i * 20 + r * 50, X_B_A: 180 + i * 3 + r * 10 },
        };
      }
      if (modelMode === 'asm2d') {
        return {
          volume: 1200 + r * 300,
          asm2d: {
            X_I: 800 + i * 10,
            X_S: 120 + i * 2,
            X_H: 900 + i * 15,
            X_PAO: 300 + i * 5,
            X_AUT: 120 + i * 2,
            X_PP: 80 + i,
            X_PHA: 40 + i,
          },
        };
      }
      return { volume: 1200 + r * 300 };
    });
    const state: any = {
      modelMode,
      biomassKg: 12000 + modelIndex * 2000 + i * 100,
      reactors,
      volume: { bio: 4500 },
      clarifier: { xRas: 7000 + i * 50 },
      influent: { bod: 130 + i },
    };
    const qw = 20 + i;
    const q = 1800 + i * 10;
    const ctx = {
      state,
      dtH: 0.25,
      Qw: qw,
      Q: q,
      clar: state.clarifier,
      influent: state.influent,
    };
    solveBiomass(ctx as never, { o2DemandKgH: 0, codOxidizedKgH: 40 + i, balancedOxidizedKgH: 0, nhOxidizedKgH: 3 + i }, 0);
    return {
      input: {
        modelMode,
        biomassKg: 12000 + modelIndex * 2000 + i * 100,
        reactors,
        volumeBio: 4500,
        clarXRas: 7000 + i * 50,
        dtH: 0.25,
        qw,
        q,
        influentBod: 130 + i,
        oxidizedCodKgH: 40 + i,
        oxidizedNhKgH: 3 + i,
        wastedKg: 0,
      },
      expected: {
        biomassKg: state.biomassKg,
        srtDays: state.srtDays,
        fmRatio: state.fmRatio,
      },
    };
  });
});


const energyCases = Array.from({ length: 24 }, (_, i) => {
  const initialCost = { energy: i, chemical: i * 2, sludge: i * 3, total: i * 6 };
  const initialCostToday = { energy: i * 0.1, chemical: i * 0.2, sludge: i * 0.3, total: i * 0.6 };
  const initialTotals = {
    inflowM3: 1000 + i * 10,
    energyKwh: 500 + i * 5,
    wasteSludgeKg: 20 + i,
    influentCodKg: 300 + i * 3,
    oxidizedCodKg: 200 + i * 2,
  };
  const state: any = {
    aerationCapacity: [1, 0.5, 0.02, 0][i % 4],
    volume: { anoxic: 1200 + i * 20, anaerobic: 600 + i * 10 },
    controls: { carbonDose: [0, 2, 5][i % 3], alkDose: [0, 8, 15][i % 3] },
    timeMin: [0, 1439, 1440, 2881][i % 4],
    lastDay: [0, 0, 0, 1][i % 4],
    cost: { ...initialCost },
    costToday: { ...initialCostToday },
    totals: { ...initialTotals },
    influent: { cod: 300 + i * 5 },
  };
  const ctx = {
    state,
    dtH: 0.25,
    Q: 1800 + i * 10,
    Qr: 450 + i * 5,
    rec: { ir: [0, 2, 4][i % 3] },
  };
  solveEnergyAndCost(ctx as never, 100 + i * 5, 10 + i, 1.5, 30 + i);
  return {
    input: {
      dtH: 0.25,
      q: 1800 + i * 10,
      qr: 450 + i * 5,
      ir: [0, 2, 4][i % 3],
      aerationCapacity: [1, 0.5, 0.02, 0][i % 4],
      o2TransferredKgH: 100 + i * 5,
      wastedKg: 10 + i,
      pacDose: 1.5,
      codOxidizedKgH: 30 + i,
      volumeAnoxic: 1200 + i * 20,
      volumeAnaerobic: 600 + i * 10,
      carbonDose: [0, 2, 5][i % 3],
      alkDose: [0, 8, 15][i % 3],
      timeMin: [0, 1439, 1440, 2881][i % 4],
      lastDay: [0, 0, 0, 1][i % 4],
      cost: initialCost,
      costToday: initialCostToday,
      totals: initialTotals,
      influentCod: 300 + i * 5,
    },
    expected: {
      energy: state.energy,
      cost: state.cost,
      costToday: state.costToday,
      totals: state.totals,
      lastDay: state.lastDay,
    },
  };
});

const sources = [
  'src/sim/networkEngine.ts',
  'src/sim/metrics.ts',
  'src/sim/alarmRules.ts',
  'src/sim/standards.ts',
  'src/sim/units.ts',
];

const golden = {
  schemaVersion: 1,
  generatedBy: 'scripts/gen-sim-phases.ts',
  oracle: 'metrics.ts + alarmRules.ts + solveBiomass + solveEffluent',
  note: 'M1b phase 4/5 and metrics/alarms parity. Minimal pre-state, not a whole-plant step.',
  sources: Object.fromEntries(sources.map((path) => [path, hash(path)])),
  counts: {
    metrics: metrics.length,
    alarms: alarms.length,
    effluent: effluentCases.length,
    biomass: biomassCases.length,
    energy: energyCases.length,
  },
  metrics,
  alarms,
  effluent: effluentCases,
  biomass: biomassCases,
  energy: energyCases,
};

if (metrics.length !== 12) throw new Error(`metrics count drift: ${metrics.length}`);
if (alarms.length !== 12) throw new Error(`alarms count drift: ${alarms.length}`);
if (effluentCases.length !== 48) throw new Error(`effluent count drift: ${effluentCases.length}`);
if (biomassCases.length !== 36) throw new Error(`biomass count drift: ${biomassCases.length}`);
if (energyCases.length !== 24) throw new Error(`energy count drift: ${energyCases.length}`);

const rendered = `${JSON.stringify(golden, null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (!existsSync(OUT)) {
    console.error(`${OUT} missing; run npm run gen:sim-phases`);
    process.exit(1);
  }
  if (readFileSync(OUT, 'utf8') !== rendered) {
    console.error(`${OUT} drifted; run npm run gen:sim-phases and review the diff`);
    process.exit(1);
  }
  console.log(`contract ok: ${OUT} (energy=${energyCases.length})`);
} else {
  writeFileSync(OUT, rendered);
  console.log(`wrote ${OUT}: metrics=${metrics.length} alarms=${alarms.length} effluent=${effluentCases.length} biomass=${biomassCases.length} energy=${energyCases.length}`);
}
