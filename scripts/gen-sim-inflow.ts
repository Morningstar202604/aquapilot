/**
 * M1b phase 2 slice: `aggregateInflow` oracle.
 *
 * Minimal pre-state only: edge list, edge flows, source reactors, terminal
 * reactor and influent. The TS function is called directly so flow-weighted
 * mixing order and fallbacks stay exact.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CompiledEdge } from '../src/sim/network';
import type { ReactorState } from '../src/sim/networkTypes';
import type { NetworkSimState } from '../src/sim/networkTypes';
import { aggregateInflow } from '../src/sim/networkEngine';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = resolve(ROOT, 'rust/golden/sim-inflow.json');
const SOURCES = ['src/sim/networkEngine.ts', 'src/sim/forcing.ts'];

function sha256(path: string): string {
  return createHash('sha256')
    .update(readFileSync(resolve(ROOT, path)))
    .digest('hex');
}

interface Composition {
  cod: number;
  nh: number;
  no3: number;
  tp: number;
  alkalinity: number;
}

interface EdgeSpec {
  id: string;
  from: string;
  recycleKind?: 'ras' | 'internal';
}

interface Case {
  name: string;
  edges: EdgeSpec[];
  flows: Record<string, number>;
  reactors: Record<string, Composition>;
  lastReactor: Composition | null;
  influent: NetworkSimState['influent'];
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

const A = { cod: 120, nh: 4, no3: 2, tp: 1.2, alkalinity: 260 };
const B = { cod: 340, nh: 12, no3: 6, tp: 2.4, alkalinity: 310 };
const LAST = { cod: 90, nh: 0.8, no3: 9, tp: 0.9, alkalinity: 150 };

const CASES: Case[] = [
  {
    name: 'external-single',
    edges: [{ id: 'e1', from: 'plant' }],
    flows: { e1: 1000 },
    reactors: {},
    lastReactor: null,
    influent: FEED,
  },
  {
    name: 'reactor-single',
    edges: [{ id: 'e1', from: 'a' }],
    flows: { e1: 500 },
    reactors: { a: A },
    lastReactor: null,
    influent: FEED,
  },
  {
    name: 'ras-terminal',
    edges: [{ id: 'ras', from: 'a', recycleKind: 'ras' }],
    flows: { ras: 800 },
    reactors: { a: A },
    lastReactor: LAST,
    influent: FEED,
  },
  {
    name: 'internal-terminal',
    edges: [{ id: 'ir', from: 'a', recycleKind: 'internal' }],
    flows: { ir: 1200 },
    reactors: { a: A },
    lastReactor: LAST,
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
    lastReactor: null,
    influent: FEED,
  },
  {
    name: 'three-stream-mix',
    edges: [
      { id: 'feed', from: 'plant' },
      { id: 'ras', from: 'plant', recycleKind: 'ras' },
      { id: 'ir', from: 'plant', recycleKind: 'internal' },
    ],
    flows: { feed: 1000, ras: 800, ir: 400 },
    reactors: {},
    lastReactor: LAST,
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
    lastReactor: null,
    influent: FEED,
  },
  {
    name: 'negative-flow-skip',
    edges: [
      { id: 'e1', from: 'a' },
      { id: 'e2', from: 'b' },
    ],
    flows: { e1: -5, e2: 600 },
    reactors: { a: A, b: B },
    lastReactor: null,
    influent: FEED,
  },
  {
    name: 'unknown-source-external',
    edges: [{ id: 'e1', from: 'missing' }],
    flows: { e1: 700 },
    reactors: {},
    lastReactor: null,
    influent: FEED,
  },
  {
    name: 'ras-without-terminal',
    edges: [{ id: 'ras', from: 'a', recycleKind: 'ras' }],
    flows: { ras: 500 },
    reactors: { a: A },
    lastReactor: null,
    influent: FEED,
  },
  {
    name: 'all-zero',
    edges: [{ id: 'e1', from: 'a' }],
    flows: { e1: 0 },
    reactors: { a: A },
    lastReactor: LAST,
    influent: FEED,
  },
  {
    name: 'reverse-order',
    edges: [
      { id: 'e2', from: 'b' },
      { id: 'e1', from: 'a' },
    ],
    flows: { e1: 300, e2: 700 },
    reactors: { a: A, b: B },
    lastReactor: null,
    influent: FEED,
  },
];

function reactor(spec: Composition): ReactorState {
  return { id: 'r', name: 'r', kind: 'aerobic', volume: 1000, ...spec } as unknown as ReactorState;
}

function edge(spec: EdgeSpec): CompiledEdge {
  return { id: spec.id, from: spec.from, to: 't', recycleKind: spec.recycleKind } as unknown as CompiledEdge;
}

const cases = CASES.map((c) => {
  const edgeFlow = new Map(Object.entries(c.flows));
  const byId = new Map(Object.entries(c.reactors).map(([id, spec]) => [id, { ...reactor(spec), id }]));
  const last = c.lastReactor ? reactor(c.lastReactor) : (undefined as unknown as ReactorState);
  const out = aggregateInflow(c.edges.map(edge), edgeFlow, byId, last, c.influent);
  return {
    name: c.name,
    edges: c.edges,
    flows: c.flows,
    reactors: c.reactors,
    lastReactor: c.lastReactor,
    influent: c.influent,
    output: out,
  };
});

const payload = {
  schema: 'aquapilot.sim.inflow.v1',
  generatedBy: 'scripts/gen-sim-inflow.ts',
  oracle: 'aggregateInflow',
  note: 'Phase 2 slice: flow-weighted aggregate reactor inflow. Not solveReactors.',
  sources: Object.fromEntries(SOURCES.map((p) => [p, sha256(p)])),
  cases,
};

const rendered = `${JSON.stringify(payload, null, 2)}\n`;
if (process.argv.includes('--check')) {
  const existing = readFileSync(OUT, 'utf8');
  if (existing !== rendered) {
    console.error(`contract drift: ${OUT}`);
    console.error('run `npm run gen:sim-inflow` and review the diff');
    process.exit(1);
  }
  console.log(`contract ok: ${OUT} (cases=${cases.length})`);
} else {
  writeFileSync(OUT, rendered);
  console.log(`wrote ${OUT}: cases=${cases.length}`);
}
