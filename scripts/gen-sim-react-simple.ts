/**
 * M1b phase 2 simple-reactor oracle.
 *
 * Calls the real TS `solveReactors(ctx)` with a minimal one-step context.
 * ASM1/ASM2d branches are intentionally excluded by `modelMode: 'simple'`.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CompiledEdge, CompiledNetwork } from '../src/sim/network';
import type { NetworkSimState, ReactorState } from '../src/sim/networkTypes';
import type { ControlSettings } from '../src/sim/config';
import { DEFAULT_CONTROLS } from '../src/sim/config';
import { KINETICS } from '../src/sim/kinetics';
import { solveReactors } from '../src/sim/networkEngine';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = resolve(ROOT, 'rust/golden/sim-react-simple.json');
const SOURCES = ['src/sim/networkEngine.ts', 'src/sim/kinetics.ts', 'src/sim/config.ts'];

function sha256(path: string): string {
  return createHash('sha256')
    .update(readFileSync(resolve(ROOT, path)))
    .digest('hex');
}

type Kind = 'anaerobic' | 'anoxic' | 'aerobic';

interface ReactorSpec {
  id: string;
  kind: Kind;
  volume: number;
  cod: number;
  nh: number;
  no3: number;
  tp: number;
  doLevel: number;
  alkalinity: number;
}

interface EdgeSpec {
  id: string;
  from: string;
  to: string;
  recycleKind?: 'ras' | 'internal';
}

interface Case {
  name: string;
  reactors: ReactorSpec[];
  order: string[];
  edges: EdgeSpec[];
  flows: Record<string, number>;
  influent: NetworkSimState['influent'];
  bf: number;
  dtH: number;
  carbonDose: number;
  alkDose: number;
  doSetpoint: number;
  aerationCapacity: number;
  suppression: number;
}

const FEED: NetworkSimState['influent'] = {
  flow: 2000,
  cod: 420,
  bod: 180,
  nh: 36,
  tn: 50,
  tp: 4.8,
  ss: 190,
  temperature: 20,
  alkalinity: 320,
};

function r(
  id: string,
  kind: Kind,
  cod: number,
  nh: number,
  no3: number,
  tp: number,
  doLevel: number,
  alkalinity: number,
  volume = 1000,
): ReactorSpec {
  return { id, kind, volume, cod, nh, no3, tp, doLevel, alkalinity };
}

const SERIES = [
  r('ana', 'anaerobic', 300, 40, 1, 6, 0.1, 280, 800),
  r('anx', 'anoxic', 220, 25, 6, 3, 0.2, 220, 900),
  r('aer', 'aerobic', 120, 8, 2, 1, 2, 180, 1600),
];

const CASES: Case[] = [
  {
    name: 'aerobic-single',
    reactors: [r('a', 'aerobic', 300, 30, 3, 2, 2, 200)],
    order: ['a'],
    edges: [{ id: 'feed', from: 'plant', to: 'a' }],
    flows: { feed: 1000 },
    influent: FEED,
    bf: 1,
    dtH: 1 / 60,
    carbonDose: 0,
    alkDose: 0,
    doSetpoint: 2,
    aerationCapacity: 1,
    suppression: 1,
  },
  {
    name: 'anaerobic-single',
    reactors: [r('a', 'anaerobic', 300, 30, 1, 6, 0.1, 280)],
    order: ['a'],
    edges: [{ id: 'feed', from: 'plant', to: 'a' }],
    flows: { feed: 1000 },
    influent: FEED,
    bf: 1,
    dtH: 1 / 60,
    carbonDose: 0,
    alkDose: 0,
    doSetpoint: 2,
    aerationCapacity: 1,
    suppression: 1,
  },
  {
    name: 'anoxic-carbon-60',
    reactors: [r('a', 'anoxic', 250, 25, 8, 3, 0.2, 220)],
    order: ['a'],
    edges: [{ id: 'feed', from: 'plant', to: 'a' }],
    flows: { feed: 1000 },
    influent: FEED,
    bf: 1,
    dtH: 1 / 60,
    carbonDose: 60,
    alkDose: 0,
    doSetpoint: 2,
    aerationCapacity: 0,
    suppression: 1,
  },
  {
    name: 'anoxic-no-carbon',
    reactors: [r('a', 'anoxic', 250, 25, 8, 3, 0.2, 220)],
    order: ['a'],
    edges: [{ id: 'feed', from: 'plant', to: 'a' }],
    flows: { feed: 1000 },
    influent: FEED,
    bf: 1,
    dtH: 1 / 60,
    carbonDose: 0,
    alkDose: 0,
    doSetpoint: 2,
    aerationCapacity: 0,
    suppression: 1,
  },
  {
    name: 'aerobic-low-do',
    reactors: [r('a', 'aerobic', 400, 40, 4, 2, 0.3, 240)],
    order: ['a'],
    edges: [{ id: 'feed', from: 'plant', to: 'a' }],
    flows: { feed: 1200 },
    influent: { ...FEED, temperature: 15 },
    bf: 0.8,
    dtH: 1 / 60,
    carbonDose: 0,
    alkDose: 0,
    doSetpoint: 2,
    aerationCapacity: 0.6,
    suppression: 1,
  },
  {
    name: 'aerobic-high-do',
    reactors: [r('a', 'aerobic', 400, 120, 20, 1, 6, 260)],
    order: ['a'],
    edges: [{ id: 'feed', from: 'plant', to: 'a' }],
    flows: { feed: 800 },
    influent: FEED,
    bf: 1.4,
    dtH: 1 / 60,
    carbonDose: 0,
    alkDose: 0,
    doSetpoint: 2,
    aerationCapacity: 1.5,
    suppression: 1,
  },
  {
    name: 'aerobic-no-aeration',
    reactors: [r('a', 'aerobic', 400, 100, 10, 2, 2, 200)],
    order: ['a'],
    edges: [{ id: 'feed', from: 'plant', to: 'a' }],
    flows: { feed: 500 },
    influent: FEED,
    bf: 1,
    dtH: 1 / 60,
    carbonDose: 0,
    alkDose: 0,
    doSetpoint: 2,
    aerationCapacity: 0,
    suppression: 1,
  },
  {
    name: 'aerobic-low-alkalinity',
    reactors: [r('a', 'aerobic', 400, 60, 30, 2, 2, 20)],
    order: ['a'],
    edges: [{ id: 'feed', from: 'plant', to: 'a' }],
    flows: { feed: 900 },
    influent: FEED,
    bf: 1,
    dtH: 1 / 60,
    carbonDose: 0,
    alkDose: 0,
    doSetpoint: 2,
    aerationCapacity: 1,
    suppression: 1,
  },
  {
    name: 'series-three',
    reactors: SERIES,
    order: ['ana', 'anx', 'aer'],
    edges: [
      { id: 'feed', from: 'plant', to: 'ana' },
      { id: 'e1', from: 'ana', to: 'anx' },
      { id: 'e2', from: 'anx', to: 'aer' },
    ],
    flows: { feed: 1000, e1: 1000, e2: 1000 },
    influent: FEED,
    bf: 1,
    dtH: 1 / 60,
    carbonDose: 40,
    alkDose: 5,
    doSetpoint: 2,
    aerationCapacity: 1,
    suppression: 1,
  },
  {
    name: 'series-ras',
    reactors: SERIES,
    order: ['ana', 'anx', 'aer'],
    edges: [
      { id: 'feed', from: 'plant', to: 'ana' },
      { id: 'e1', from: 'ana', to: 'anx' },
      { id: 'e2', from: 'anx', to: 'aer' },
      { id: 'ras', from: 'aer', to: 'ana', recycleKind: 'ras' },
      { id: 'ir', from: 'aer', to: 'anx', recycleKind: 'internal' },
    ],
    flows: { feed: 1000, e1: 1000, e2: 1000, ras: 800, ir: 400 },
    influent: FEED,
    bf: 1,
    dtH: 1 / 60,
    carbonDose: 40,
    alkDose: 5,
    doSetpoint: 2,
    aerationCapacity: 1,
    suppression: 0.8,
  },
  {
    name: 'isolated-reactor',
    reactors: [r('a', 'aerobic', 1000, 50, 10, 1, 2, 200)],
    order: ['a'],
    edges: [],
    flows: {},
    influent: FEED,
    bf: 1,
    dtH: 1 / 60,
    carbonDose: 0,
    alkDose: 0,
    doSetpoint: 2,
    aerationCapacity: 1,
    suppression: 1,
  },
  {
    name: 'two-feed-mix',
    reactors: [r('a', 'aerobic', 500, 60, 12, 2, 1.5, 210)],
    order: ['a'],
    edges: [
      { id: 'f1', from: 'plant', to: 'a' },
      { id: 'f2', from: 'plant', to: 'a' },
    ],
    flows: { f1: 600, f2: 400 },
    influent: FEED,
    bf: 1,
    dtH: 1 / 60,
    carbonDose: 0,
    alkDose: 0,
    doSetpoint: 2,
    aerationCapacity: 1,
    suppression: 1,
  },
  {
    name: 'warm-aerobic',
    reactors: [r('a', 'aerobic', 600, 80, 18, 3, 1.2, 150)],
    order: ['a'],
    edges: [{ id: 'feed', from: 'plant', to: 'a' }],
    flows: { feed: 1400 },
    influent: { ...FEED, temperature: 30 },
    bf: 1.2,
    dtH: 1 / 60,
    carbonDose: 0,
    alkDose: 0,
    doSetpoint: 2.5,
    aerationCapacity: 0.9,
    suppression: 1,
  },
];

function reactor(spec: ReactorSpec): ReactorState {
  return {
    id: spec.id,
    name: spec.id,
    kind: spec.kind,
    volume: spec.volume,
    cod: spec.cod,
    nh: spec.nh,
    no3: spec.no3,
    tp: spec.tp,
    doLevel: spec.doLevel,
    alkalinity: spec.alkalinity,
    temperature: 20,
    o2Demand: 0,
    kla: 0,
    inflow: 0,
  } as ReactorState;
}

function run(c: Case) {
  const reactors = c.reactors.map(reactor);
  const byId = new Map(reactors.map((item) => [item.id, item]));
  const incoming: Record<string, CompiledEdge[]> = {};
  for (const e of c.edges) {
    const edge = {
      id: e.id,
      from: e.from,
      to: e.to,
      recycleKind: e.recycleKind,
    } as unknown as CompiledEdge;
    (incoming[e.to] ??= []).push(edge);
  }
  const state = {
    modelMode: 'simple',
    reactors,
    controls: {
      ...DEFAULT_CONTROLS,
      carbonDose: c.carbonDose,
      alkDose: c.alkDose,
      doSetpoint: c.doSetpoint,
    } as ControlSettings,
    aerationCapacity: c.aerationCapacity,
  } as unknown as NetworkSimState;
  const net = {
    order: c.order,
    incomingByReactor: incoming,
    edges: [],
    problems: [],
    outgoingByReactor: {},
  } as unknown as CompiledNetwork;
  const flows = { edgeFlow: new Map(Object.entries(c.flows)) };
  const lastId = c.order[c.order.length - 1];
  const lastReactor = byId.get(lastId) ?? reactors[0];
  const ctx = {
    state,
    net,
    dtMin: c.dtH * 60,
    dtH: c.dtH,
    influent: c.influent,
    sup: c.suppression,
    rec: { ras: 0, ir: 0, was: 0 },
    flows,
    Q: c.influent.flow,
    Qr: 0,
    Qw: 0,
    Qe: c.influent.flow,
    underflow: 0,
    xBiomass: 3400,
    bf: c.bf,
    T: c.influent.temperature,
    thetaH: Math.pow(KINETICS.thetaH, c.influent.temperature - 20),
    thetaN: Math.pow(KINETICS.thetaN, c.influent.temperature - 20),
    clar: { xRas: 0 },
    lastReactor,
    byId,
  } as unknown as Parameters<typeof solveReactors>[0];
  const flux = solveReactors(ctx);
  return {
    name: c.name,
    reactors: c.reactors,
    order: c.order,
    edges: c.edges,
    flows: c.flows,
    influent: c.influent,
    bf: c.bf,
    dtH: c.dtH,
    carbonDose: c.carbonDose,
    alkDose: c.alkDose,
    doSetpoint: c.doSetpoint,
    aerationCapacity: c.aerationCapacity,
    suppression: c.suppression,
    output: {
      reactors: reactors.map((item) => ({
        id: item.id,
        kind: item.kind,
        volume: item.volume,
        cod: item.cod,
        nh: item.nh,
        no3: item.no3,
        tp: item.tp,
        doLevel: item.doLevel,
        alkalinity: item.alkalinity,
        temperature: item.temperature,
        o2Demand: item.o2Demand,
        kla: item.kla,
        inflow: item.inflow,
      })),
      flux,
    },
  };
}

const cases = CASES.map(run);
const payload = {
  schema: 'aquapilot.sim.react-simple.v1',
  generatedBy: 'scripts/gen-sim-react-simple.ts',
  oracle: 'solveReactors (simple branch)',
  note: 'Phase 2 simple branch only. ASM1/ASM2d reaction integration not included.',
  sources: Object.fromEntries(SOURCES.map((p) => [p, sha256(p)])),
  cases,
};

const rendered = `${JSON.stringify(payload, null, 2)}\n`;
if (process.argv.includes('--check')) {
  const existing = readFileSync(OUT, 'utf8');
  if (existing !== rendered) {
    console.error(`contract drift: ${OUT}`);
    console.error('run `npm run gen:sim-react-simple` and review the diff');
    process.exit(1);
  }
  console.log(`contract ok: ${OUT} (cases=${cases.length})`);
} else {
  writeFileSync(OUT, rendered);
  console.log(`wrote ${OUT}: cases=${cases.length}`);
}
