/**
 * M1b phase 2 ASM1-reactor oracle.
 *
 * Calls the real TS `solveReactors(ctx)` with `modelMode: 'asm1'` for one step.
 * Covers initialization, 13-component CSTR transport, temperature/pH/free
 * ammonia/toxicity suppression, KLa DO control and RAS/internal recycle.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CompiledEdge, CompiledNetwork } from '../src/sim/network';
import type { NetworkSimState, ReactorState } from '../src/sim/networkTypes';
import type { ControlSettings } from '../src/sim/config';
import { DEFAULT_CONTROLS } from '../src/sim/config';
import { ASM1_COMPONENTS, type Asm1State } from '../src/sim/asm1';
import { toAsm1 } from '../src/sim/asm1Mapping';
import { solveReactors } from '../src/sim/networkEngine';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = resolve(ROOT, 'rust/golden/sim-react-asm1.json');
const SOURCES = [
  'src/sim/networkEngine.ts',
  'src/sim/asm1.ts',
  'src/sim/asm1Mapping.ts',
  'src/sim/aeration.ts',
  'src/sim/config.ts',
];

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
  asm1?: Asm1State;
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
  doSetpoint: number;
  aerationCapacity: number;
  suppression: number;
  xBiomass: number;
  xRas: number;
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
  asm1?: Asm1State,
): ReactorSpec {
  return { id, kind, volume, cod, nh, no3, tp, doLevel, alkalinity, asm1 };
}

const SERIES = [
  r('ana', 'anaerobic', 300, 40, 1, 6, 0.1, 280, 800),
  r('anx', 'anoxic', 220, 25, 6, 3, 0.2, 220, 900),
  r('aer', 'aerobic', 120, 8, 2, 1, 2, 180, 1600),
];

const CASES: Case[] = [
  {
    name: 'aerobic-single',
    reactors: [r('a', 'aerobic', 300, 30, 3, 2, 2, 200, 1000)],
    order: ['a'],
    edges: [{ id: 'feed', from: 'plant', to: 'a' }],
    flows: { feed: 1000 },
    influent: FEED,
    bf: 1,
    dtH: 1 / 60,
    carbonDose: 0,
    doSetpoint: 2,
    aerationCapacity: 1,
    suppression: 1,
    xBiomass: 3400,
    xRas: 0,
  },
  {
    name: 'anaerobic-single',
    reactors: [r('a', 'anaerobic', 300, 40, 1, 6, 0.1, 280, 800)],
    order: ['a'],
    edges: [{ id: 'feed', from: 'plant', to: 'a' }],
    flows: { feed: 1000 },
    influent: FEED,
    bf: 1,
    dtH: 1 / 60,
    carbonDose: 0,
    doSetpoint: 2,
    aerationCapacity: 1,
    suppression: 1,
    xBiomass: 3400,
    xRas: 0,
  },
  {
    name: 'anoxic-carbon-60',
    reactors: [r('a', 'anoxic', 220, 25, 6, 3, 0.2, 220, 250)],
    order: ['a'],
    edges: [{ id: 'feed', from: 'plant', to: 'a' }],
    flows: { feed: 1000 },
    influent: FEED,
    bf: 1,
    dtH: 1 / 60,
    carbonDose: 60,
    doSetpoint: 2,
    aerationCapacity: 0,
    suppression: 1,
    xBiomass: 3400,
    xRas: 0,
  },
  {
    name: 'anoxic-no-carbon',
    reactors: [r('a', 'anoxic', 220, 25, 6, 3, 0.2, 220, 250)],
    order: ['a'],
    edges: [{ id: 'feed', from: 'plant', to: 'a' }],
    flows: { feed: 1000 },
    influent: FEED,
    bf: 1,
    dtH: 1 / 60,
    carbonDose: 0,
    doSetpoint: 2,
    aerationCapacity: 0,
    suppression: 1,
    xBiomass: 3400,
    xRas: 0,
  },
  {
    name: 'aerobic-low-do',
    reactors: [r('a', 'aerobic', 400, 40, 4, 2, 0.3, 240, 1000)],
    order: ['a'],
    edges: [{ id: 'feed', from: 'plant', to: 'a' }],
    flows: { feed: 1200 },
    influent: { ...FEED, temperature: 15 },
    bf: 0.8,
    dtH: 1 / 60,
    carbonDose: 0,
    doSetpoint: 2,
    aerationCapacity: 0.6,
    suppression: 1,
    xBiomass: 3400,
    xRas: 0,
  },
  {
    name: 'aerobic-no-aeration',
    reactors: [r('a', 'aerobic', 100, 10, 2, 2, 0.5, 200, 400)],
    order: ['a'],
    edges: [{ id: 'feed', from: 'plant', to: 'a' }],
    flows: { feed: 500 },
    influent: FEED,
    bf: 1,
    dtH: 1 / 60,
    carbonDose: 0,
    doSetpoint: 2,
    aerationCapacity: 0,
    suppression: 1,
    xBiomass: 3400,
    xRas: 0,
  },
  {
    name: 'aerobic-low-alkalinity',
    reactors: [r('a', 'aerobic', 60, 30, 2, 2, 2, 40, 900)],
    order: ['a'],
    edges: [{ id: 'feed', from: 'plant', to: 'a' }],
    flows: { feed: 900 },
    influent: { ...FEED, alkalinity: 80 },
    bf: 1,
    dtH: 1 / 60,
    carbonDose: 0,
    doSetpoint: 2,
    aerationCapacity: 1,
    suppression: 1,
    xBiomass: 3400,
    xRas: 0,
  },
  {
    name: 'aerobic-high-ammonia',
    reactors: [r('a', 'aerobic', 90, 80, 3, 2, 2, 80, 900)],
    order: ['a'],
    edges: [{ id: 'feed', from: 'plant', to: 'a' }],
    flows: { feed: 900 },
    influent: { ...FEED, nh: 70, alkalinity: 140 },
    bf: 1,
    dtH: 1 / 60,
    carbonDose: 0,
    doSetpoint: 2,
    aerationCapacity: 1,
    suppression: 1,
    xBiomass: 3400,
    xRas: 0,
  },
  {
    name: 'toxic-suppression-0.2',
    reactors: [r('a', 'aerobic', 200, 25, 3, 2, 2, 180, 1000)],
    order: ['a'],
    edges: [{ id: 'feed', from: 'plant', to: 'a' }],
    flows: { feed: 1000 },
    influent: FEED,
    bf: 1,
    dtH: 1 / 60,
    carbonDose: 0,
    doSetpoint: 2,
    aerationCapacity: 1,
    suppression: 0.2,
    xBiomass: 3400,
    xRas: 0,
  },
  {
    name: 'toxic-suppression-zero',
    reactors: [r('a', 'aerobic', 200, 25, 3, 2, 2, 180, 1000)],
    order: ['a'],
    edges: [{ id: 'feed', from: 'plant', to: 'a' }],
    flows: { feed: 1000 },
    influent: FEED,
    bf: 1,
    dtH: 1 / 60,
    carbonDose: 0,
    doSetpoint: 2,
    aerationCapacity: 1,
    suppression: 0,
    xBiomass: 3400,
    xRas: 0,
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
    doSetpoint: 2,
    aerationCapacity: 1,
    suppression: 1,
    xBiomass: 3400,
    xRas: 0,
  },
  {
    name: 'series-ras-internal',
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
    doSetpoint: 2,
    aerationCapacity: 1,
    suppression: 0.8,
    xBiomass: 3400,
    xRas: 9000,
  },
  {
    name: 'isolated-reactor',
    reactors: [r('a', 'aerobic', 50, 10, 1, 2, 2, 200, 1000)],
    order: ['a'],
    edges: [],
    flows: {},
    influent: FEED,
    bf: 1,
    dtH: 1 / 60,
    carbonDose: 0,
    doSetpoint: 2,
    aerationCapacity: 1,
    suppression: 1,
    xBiomass: 3400,
    xRas: 0,
  },
  {
    name: 'two-feed-mix',
    reactors: [r('a', 'aerobic', 60, 12, 2, 1.5, 2, 210, 500)],
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
    doSetpoint: 2,
    aerationCapacity: 1,
    suppression: 1,
    xBiomass: 3400,
    xRas: 0,
  },
  {
    name: 'warm-aerobic',
    reactors: [r('a', 'aerobic', 80, 18, 3, 1.2, 1.5, 150, 600)],
    order: ['a'],
    edges: [{ id: 'feed', from: 'plant', to: 'a' }],
    flows: { feed: 1400 },
    influent: { ...FEED, temperature: 30 },
    bf: 1.2,
    dtH: 1 / 60,
    carbonDose: 0,
    doSetpoint: 2.5,
    aerationCapacity: 0.9,
    suppression: 1,
    xBiomass: 3400,
    xRas: 0,
  },
  {
    name: 'preinitialized-asm1',
    reactors: [
      r(
        'a',
        'aerobic',
        300,
        30,
        3,
        2,
        2,
        200,
        1000,
        toAsm1({
          cod: 900,
          nh: 12,
          no3: 4,
          tp: 2,
          doLevel: 1.8,
          alkalinity: 160,
          mlss: 4200,
        }),
      ),
    ],
    order: ['a'],
    edges: [{ id: 'feed', from: 'plant', to: 'a' }],
    flows: { feed: 1000 },
    influent: FEED,
    bf: 1,
    dtH: 1 / 60,
    carbonDose: 0,
    doSetpoint: 2,
    aerationCapacity: 0.8,
    suppression: 1,
    xBiomass: 4200,
    xRas: 0,
  },
];

function reactor(spec: ReactorSpec): ReactorState {
  return {
    id: spec.id,
    name: spec.id,
    kind: spec.kind,
    volume: spec.volume,
    asm1: spec.asm1,
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
    const edge = { id: e.id, from: e.from, to: e.to, recycleKind: e.recycleKind } as unknown as CompiledEdge;
    (incoming[e.to] ??= []).push(edge);
  }
  const state = {
    modelMode: 'asm1',
    reactors,
    controls: {
      ...DEFAULT_CONTROLS,
      carbonDose: c.carbonDose,
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
    xBiomass: c.xBiomass,
    bf: c.bf,
    T: c.influent.temperature,
    thetaH: Math.pow(1.045, c.influent.temperature - 20),
    thetaN: Math.pow(1.08, c.influent.temperature - 20),
    clar: { xRas: c.xRas },
    lastReactor,
    byId,
  } as unknown as Parameters<typeof solveReactors>[0];
  const flux = solveReactors(ctx);
  return {
    name: c.name,
    reactors: c.reactors.map(({ asm1, ...rest }) => ({
      ...rest,
      asm1: asm1 ? Object.fromEntries(ASM1_COMPONENTS.map((comp) => [comp, asm1[comp]])) : null,
    })),
    order: c.order,
    edges: c.edges,
    flows: c.flows,
    influent: c.influent,
    bf: c.bf,
    dtH: c.dtH,
    carbonDose: c.carbonDose,
    doSetpoint: c.doSetpoint,
    aerationCapacity: c.aerationCapacity,
    suppression: c.suppression,
    xBiomass: c.xBiomass,
    xRas: c.xRas,
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
        doIntegral: item.doIntegral ?? 0,
        inflow: item.inflow,
        asm1: item.asm1 ? Object.fromEntries(ASM1_COMPONENTS.map((comp) => [comp, item.asm1![comp]])) : null,
      })),
      flux,
    },
  };
}

const cases = CASES.map(run);
const payload = {
  schema: 'aquapilot.sim.react-asm1.v1',
  generatedBy: 'scripts/gen-sim-react-asm1.ts',
  oracle: 'solveReactors (ASM1 branch)',
  note: 'One step; ASM2d branch excluded. ASM1 initialization uses max(cod,150)+MLSS mapping.',
  sources: Object.fromEntries(SOURCES.map((path) => [path, sha256(path)])),
  cases,
};
const json = `${JSON.stringify(payload, null, 2)}\n`;
if (process.argv.includes('--check')) {
  const existing = readFileSync(OUT, 'utf8');
  if (existing !== json) {
    throw new Error('contract drift: run npm run gen:sim-react-asm1 and review the diff');
  }
  console.log(`contract ok: ${OUT} (cases=${cases.length})`);
} else {
  writeFileSync(OUT, json);
  console.log(`wrote ${OUT}: cases=${cases.length}`);
}
