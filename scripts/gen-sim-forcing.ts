/**
 * M1b forcing/influent oracle generator.
 *
 * Freezes the TS pure functions before the Rust whole-plant engine is ported.
 * It deliberately covers all eight scenarios, ramp edges, real-series cyclic
 * sampling, uncertainty scaling and the synthetic diurnal/noise path.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import {
  aerationCapacityOf,
  diurnal,
  recycleFactors,
  scenarioEnvelope,
  seasonalTemperature,
  toxicSuppression,
} from '../src/sim/forcing';
import { deriveInfluent } from '../src/sim/networkEngine';
import type { NetworkSimState } from '../src/sim/networkTypes';
import type { ScenarioSpec, ScenarioType } from '../src/sim/scenarios';

const OUT = 'rust/golden/sim-forcing.json';

function hash(path: string): string {
  return createHash('sha256').update(readFileSync(path, 'utf8')).digest('hex');
}

const kinds: ScenarioType[] = [
  'storm',
  'shock_load',
  'toxic',
  'blower_failure',
  'ras_failure',
  'power_outage',
  'winter',
  'chemical_shortage',
];

const times = [0, 5, 10, 15, 60, 100, 180, 359, 360, 600, 1440, 10080, 43200, 525600];

function spec(kind: ScenarioType, timeMin: number, magnitude = 1): ScenarioSpec {
  return {
    type: kind,
    durationMin: kind === 'winter' ? 1440 : kind === 'power_outage' ? 45 : 360,
    startedAt: Math.max(0, timeMin - (kind === 'power_outage' ? 20 : 60)),
    magnitude: kind === 'winter' ? 12 : kind === 'blower_failure' ? 0.5 : magnitude,
  };
}

const forcing = kinds.flatMap((kind) =>
  times.map((timeMin) => {
    const scenario = spec(kind, timeMin);
    return {
      timeMin,
      scenario,
      diurnal: diurnal(timeMin),
      seasonalTemperature: seasonalTemperature(timeMin),
      scenarioEnvelope: scenarioEnvelope(scenario, timeMin),
      toxicSuppression: toxicSuppression(scenario, timeMin),
      aerationCapacity: aerationCapacityOf(scenario, timeMin),
    };
  }),
);

const controls = [
  { rasRatio: 3, internalRecirc: 4, wasRatio: 0.5 },
  { rasRatio: 2.2, internalRecirc: 3.5, wasRatio: 0.35 },
  { rasRatio: 4.1, internalRecirc: 1.2, wasRatio: 0.8 },
  { rasRatio: 0, internalRecirc: 0, wasRatio: 0 },
];

const recycle = kinds.flatMap((kind) =>
  controls.flatMap((control) =>
    [10, 100, 300].map((timeMin) => ({
      timeMin,
      control,
      scenario: spec(kind, timeMin),
      expected: recycleFactors(control, spec(kind, timeMin), timeMin),
    })),
  ),
);

interface SeriesPoint {
  minute: number;
  flow: number;
  cod: number;
  nh: number;
  tp: number;
  ss: number;
  temperature: number;
  alkalinity?: number;
}

const seriesA = {
  name: 'cyclic-24h',
  samples: Array.from({ length: 25 }, (_, i): SeriesPoint => {
    const minute = i * 60;
    return {
      minute,
      flow: 1500 + 300 * Math.sin((2 * Math.PI * minute) / 1440),
      cod: 280 + 80 * Math.sin((2 * Math.PI * minute) / 1440 + 0.5),
      nh: 25 + 8 * Math.cos((2 * Math.PI * minute) / 1440),
      tp: 3.5 + 1.2 * Math.sin((2 * Math.PI * minute) / 720),
      ss: 140 + 40 * Math.cos((2 * Math.PI * minute) / 1440),
      temperature: 19 + 2 * Math.sin((2 * Math.PI * minute) / 1440),
      alkalinity: 240 + 30 * Math.sin((2 * Math.PI * minute) / 1440),
    };
  }),
  durationMin: 1440,
  warnings: [],
};
const seriesSingle = {
  name: 'single',
  samples: [{ minute: 0, flow: 9999, cod: 1600, nh: 5, tp: 20, ss: 999, temperature: 5, alkalinity: 500 }],
  durationMin: 0,
  warnings: [],
};
const seriesEmpty = { name: 'empty', samples: [], durationMin: 0, warnings: [] };

const uncertainty = { flow: 0.85, cod: 1.15, nh: 0.9, tp: 1.1, temperature: 2.5, biomass: 0.95 };
const seeds = [1, 21, 73];
const rngCounts = [0, 1, 17, 1439];
const influentTimes = [0, 60, 600, 1440, 10080];

const influent: Array<{ context: Record<string, unknown>; expected: Record<string, number> }> = [];
for (const kind of [null, ...kinds]) {
  for (const seed of seeds) {
    for (const rngCount of rngCounts) {
      for (const timeMin of influentTimes) {
        const scenario = kind ? spec(kind, timeMin) : null;
        for (const uncertain of [null, uncertainty]) {
          const context = {
            timeMin,
            seed,
            rngCount,
            scenario,
            uncertainty: uncertain,
            influentSeries: null,
          };
          const state = context as unknown as NetworkSimState;
          influent.push({ context, expected: { ...deriveInfluent(state) } });
        }
      }
    }
  }
}

for (const timeMin of [0, 360, 720, 1080, 2000, 1440]) {
  for (const series of [seriesA, seriesSingle, seriesEmpty]) {
    const context = {
      timeMin,
      seed: 21,
      rngCount: 1439,
      scenario: null,
      uncertainty: null,
      influentSeries: series,
    };
    const state = context as unknown as NetworkSimState;
    influent.push({ context, expected: { ...deriveInfluent(state) } });
  }
}

const sources = [
  'src/sim/forcing.ts',
  'src/sim/networkEngine.ts',
  'src/sim/influentSeries.ts',
  'src/sim/config.ts',
  'src/sim/rng.ts',
  'src/sim/scenarios.ts',
  'src/sim/networkTypes.ts',
];

const golden = {
  schemaVersion: 1,
  generatedBy: 'scripts/gen-sim-forcing.ts',
  oracle: 'src/sim/forcing.ts + deriveInfluent + sampleAt',
  note: 'M1b pure forcing/influent parity. Not a whole-plant step parity and not M2 completion.',
  sources: Object.fromEntries(sources.map((path) => [path, hash(path)])),
  counts: {
    forcing: forcing.length,
    recycle: recycle.length,
    influent: influent.length,
  },
  forcing,
  recycle,
  influent,
};

if (forcing.length !== kinds.length * times.length) throw new Error('forcing count drift');
if (recycle.length !== kinds.length * controls.length * 3) throw new Error('recycle count drift');
if (influent.length !== (1 + kinds.length) * seeds.length * rngCounts.length * influentTimes.length * 2 + 18) {
  throw new Error(`influent count drift: ${influent.length}`);
}

const rendered = `${JSON.stringify(golden, null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (!existsSync(OUT)) {
    console.error(`${OUT} missing; run npm run gen:sim-forcing`);
    process.exit(1);
  }
  const current = readFileSync(OUT, 'utf8');
  if (current !== rendered) {
    console.error(`${OUT} drifted; run npm run gen:sim-forcing and review the diff`);
    process.exit(1);
  }
  console.log(`contract ok: ${OUT} (forcing=${forcing.length} recycle=${recycle.length} influent=${influent.length})`);
} else {
  writeFileSync(OUT, rendered);
  console.log(`wrote ${OUT}: forcing=${forcing.length} recycle=${recycle.length} influent=${influent.length}`);
}
