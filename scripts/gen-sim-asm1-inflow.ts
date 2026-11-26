/**
 * M1b phase 2 ASM1 slice: `toAsm1` / `influentToAsm1` / `aggregateAsm1Inflow`.
 *
 * States are serialized in the exact `ASM1_COMPONENTS` order so the Rust array
 * representation can be compared component-by-component, including loop order.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASM1_COMPONENTS, emptyAsm1State, type Asm1State } from '../src/sim/asm1';
import { influentToAsm1, toAsm1 } from '../src/sim/asm1Mapping';
import type { CompiledEdge } from '../src/sim/network';
import type { ReactorState, NetworkSimState } from '../src/sim/networkTypes';
import { aggregateAsm1Inflow } from '../src/sim/networkEngine';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = resolve(ROOT, 'rust/golden/sim-asm1-inflow.json');
const SOURCES = ['src/sim/networkEngine.ts', 'src/sim/asm1.ts', 'src/sim/asm1Mapping.ts', 'src/sim/units.ts'];

function sha256(path: string): string {
  return createHash('sha256')
    .update(readFileSync(resolve(ROOT, path)))
    .digest('hex');
}

function values(state: Asm1State): number[] {
  return ASM1_COMPONENTS.map((c) => state[c]);
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

interface MappingCase {
  name: string;
  input: { cod: number; nh: number; no3: number; doLevel: number; alkalinity: number; mlss: number };
}

const MAPPING_CASES: MappingCase[] = [
  { name: 'influent-typical', input: { cod: 420, nh: 36, no3: 0, doLevel: 0, alkalinity: 320, mlss: 0 } },
  { name: 'influent-low-cod-clamp', input: { cod: 1, nh: 8, no3: 0, doLevel: 0, alkalinity: 60, mlss: 0 } },
  { name: 'influent-zero-cod', input: { cod: 0, nh: 8, no3: 0, doLevel: 0, alkalinity: 60, mlss: 0 } },
  { name: 'mixed-liquor', input: { cod: 900, nh: 2, no3: 8, doLevel: 2, alkalinity: 180, mlss: 2500 } },
  { name: 'mixed-liquor-heavy', input: { cod: 1200, nh: 1, no3: 5, doLevel: 3, alkalinity: 200, mlss: 6000 } },
  { name: 'biomass-exceeds-remaining', input: { cod: 100, nh: 5, no3: 1, doLevel: 1, alkalinity: 100, mlss: 4000 } },
  { name: 'no-nitrate', input: { cod: 300, nh: 20, no3: 0, doLevel: 0, alkalinity: 250, mlss: 1000 } },
  { name: 'high-alkalinity', input: { cod: 500, nh: 40, no3: 3, doLevel: 1.5, alkalinity: 500, mlss: 0 } },
];

interface EdgeSpec {
  id: string;
  from: string;
  recycleKind?: 'ras' | 'internal';
}

interface InflowCase {
  name: string;
  edges: EdgeSpec[];
  flows: Record<string, number>;
  reactors: Record<string, Asm1State>;
  lastAsm1: Asm1State | null;
  xRas: number;
  influent: NetworkSimState['influent'];
}

const A = emptyAsm1State({
  S_I: 10,
  S_S: 40,
  X_I: 80,
  X_S: 120,
  X_B_H: 600,
  X_B_A: 60,
  S_O: 2,
  S_NO: 8,
  S_NH: 2,
  S_ALK: 5,
});
const B = emptyAsm1State({
  S_I: 20,
  S_S: 80,
  X_I: 160,
  X_S: 90,
  X_B_H: 900,
  X_B_A: 30,
  S_O: 1,
  S_NO: 5,
  S_NH: 5,
  S_ALK: 4,
});
const LAST = emptyAsm1State({
  S_I: 30,
  S_S: 10,
  X_I: 200,
  X_S: 100,
  X_B_H: 1100,
  X_B_A: 80,
  S_O: 1.5,
  S_NO: 9,
  S_NH: 1,
  S_ALK: 6,
});
const THIN = emptyAsm1State({ X_I: 0.2, X_S: 0.1 });

const INFLOW_CASES: InflowCase[] = [
  {
    name: 'external-single',
    edges: [{ id: 'e1', from: 'plant' }],
    flows: { e1: 1000 },
    reactors: {},
    lastAsm1: null,
    xRas: 0,
    influent: FEED,
  },
  {
    name: 'reactor-single',
    edges: [{ id: 'e1', from: 'a' }],
    flows: { e1: 500 },
    reactors: { a: A },
    lastAsm1: null,
    xRas: 0,
    influent: FEED,
  },
  {
    name: 'ras-ratio-3',
    edges: [{ id: 'ras', from: 'a', recycleKind: 'ras' }],
    flows: { ras: 800 },
    reactors: { a: A },
    lastAsm1: LAST,
    xRas: 600,
    influent: FEED,
  },
  {
    name: 'ras-ratio-cap-6',
    edges: [{ id: 'ras', from: 'a', recycleKind: 'ras' }],
    flows: { ras: 800 },
    reactors: { a: A },
    lastAsm1: LAST,
    xRas: 3000,
    influent: FEED,
  },
  {
    name: 'ras-ratio-floor-1',
    edges: [{ id: 'ras', from: 'a', recycleKind: 'ras' }],
    flows: { ras: 800 },
    reactors: { a: A },
    lastAsm1: LAST,
    xRas: 100,
    influent: FEED,
  },
  {
    name: 'ras-thin-feed',
    edges: [{ id: 'ras', from: 'a', recycleKind: 'ras' }],
    flows: { ras: 800 },
    reactors: { a: A },
    lastAsm1: THIN,
    xRas: 5,
    influent: FEED,
  },
  {
    name: 'internal-terminal',
    edges: [{ id: 'ir', from: 'a', recycleKind: 'internal' }],
    flows: { ir: 1200 },
    reactors: { a: A },
    lastAsm1: LAST,
    xRas: 600,
    influent: FEED,
  },
  {
    name: 'two-reactor-mix',
    edges: [
      { id: 'e1', from: 'a' },
      { id: 'e2', from: 'b' },
    ],
    flows: { e1: 300, e2: 700 },
    reactors: { a: A, b: B },
    lastAsm1: null,
    xRas: 0,
    influent: FEED,
  },
  {
    name: 'feed-ras-ir-mix',
    edges: [
      { id: 'feed', from: 'plant' },
      { id: 'ras', from: 'plant', recycleKind: 'ras' },
      { id: 'ir', from: 'plant', recycleKind: 'internal' },
    ],
    flows: { feed: 1000, ras: 800, ir: 400 },
    reactors: {},
    lastAsm1: LAST,
    xRas: 600,
    influent: FEED,
  },
  {
    name: 'zero-flow-skip',
    edges: [
      { id: 'e1', from: 'a' },
      { id: 'e2', from: 'b' },
    ],
    flows: { e1: 0, e2: 600 },
    reactors: { a: A, b: B },
    lastAsm1: null,
    xRas: 0,
    influent: FEED,
  },
  {
    name: 'unknown-source',
    edges: [{ id: 'e1', from: 'missing' }],
    flows: { e1: 700 },
    reactors: {},
    lastAsm1: null,
    xRas: 0,
    influent: FEED,
  },
  {
    name: 'ras-without-terminal',
    edges: [{ id: 'ras', from: 'a', recycleKind: 'ras' }],
    flows: { ras: 500 },
    reactors: { a: A },
    lastAsm1: null,
    xRas: 600,
    influent: FEED,
  },
];

function reactor(state: Asm1State): ReactorState {
  return { id: 'r', name: 'r', kind: 'aerobic', volume: 1000, asm1: state } as unknown as ReactorState;
}

function edge(spec: EdgeSpec): CompiledEdge {
  return { id: spec.id, from: spec.from, to: 't', recycleKind: spec.recycleKind } as unknown as CompiledEdge;
}

const mappings = MAPPING_CASES.map((c) => ({
  name: c.name,
  input: c.input,
  output: values(
    toAsm1({
      cod: c.input.cod,
      nh: c.input.nh,
      no3: c.input.no3,
      tp: 4.8,
      doLevel: c.input.doLevel,
      alkalinity: c.input.alkalinity,
      mlss: c.input.mlss,
    }),
  ),
}));

const inflow = INFLOW_CASES.map((c) => {
  const edgeFlow = new Map(Object.entries(c.flows));
  const byId = new Map(Object.entries(c.reactors).map(([id, state]) => [id, { ...reactor(state), id }]));
  const last = c.lastAsm1 ? reactor(c.lastAsm1) : (undefined as unknown as ReactorState);
  const out = aggregateAsm1Inflow(c.edges.map(edge), edgeFlow, byId, last, c.xRas, c.influent, c.influent.temperature);
  return {
    name: c.name,
    edges: c.edges,
    flows: c.flows,
    reactors: Object.fromEntries(Object.entries(c.reactors).map(([id, s]) => [id, values(s)])),
    lastAsm1: c.lastAsm1 ? values(c.lastAsm1) : null,
    xRas: c.xRas,
    influent: c.influent,
    output: values(out),
  };
});

// `influentToAsm1` is the same mapping with mlss=0 and no nitrate; lock it separately.
const influentMappings = [
  { name: 'feed', influent: FEED, output: values(influentToAsm1(FEED)) },
  {
    name: 'low-alk',
    influent: { ...FEED, alkalinity: 60, cod: 90 },
    output: values(influentToAsm1({ ...FEED, alkalinity: 60, cod: 90 })),
  },
];

const payload = {
  schema: 'aquapilot.sim.asm1-inflow.v1',
  generatedBy: 'scripts/gen-sim-asm1-inflow.ts',
  oracle: 'toAsm1 + influentToAsm1 + aggregateAsm1Inflow',
  note: 'Phase 2 ASM1 mixing slice. Not solveReactors / reaction integration.',
  sources: Object.fromEntries(SOURCES.map((p) => [p, sha256(p)])),
  mappings,
  influentMappings,
  inflow,
};

const rendered = `${JSON.stringify(payload, null, 2)}\n`;
if (process.argv.includes('--check')) {
  const existing = readFileSync(OUT, 'utf8');
  if (existing !== rendered) {
    console.error(`contract drift: ${OUT}`);
    console.error('run `npm run gen:sim-asm1-inflow` and review the diff');
    process.exit(1);
  }
  console.log(`contract ok: ${OUT} (mappings=${mappings.length}, inflow=${inflow.length})`);
} else {
  writeFileSync(OUT, rendered);
  console.log(`wrote ${OUT}: mappings=${mappings.length} inflow=${inflow.length}`);
}
