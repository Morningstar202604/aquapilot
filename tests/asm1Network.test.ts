import { describe, expect, it } from 'vitest';
import { emptyAsm1State, type Asm1State } from '../src/sim/asm1';
import {
  ASM1_COD_PER_VSS,
  stepAsm1Cstr,
  stepAsm1Network,
  type Asm1Edge,
  type Asm1Reactor,
} from '../src/sim/asm1Network';

const feed: Asm1State = emptyAsm1State({
  S_I: 30,
  S_S: 80,
  X_I: 150,
  X_S: 250,
  X_B_H: 120,
  X_B_A: 20,
  X_P: 40,
  S_O: 2,
  S_NO: 0.5,
  S_NH: 28,
  S_ND: 5,
  X_ND: 12,
  S_ALK: 8,
});

function train(): { reactors: Asm1Reactor[]; edges: Asm1Edge[] } {
  const reactors: Asm1Reactor[] = [
    { id: 'anaerobic', volume: 3000, state: { ...feed } },
    { id: 'anoxic', volume: 4500, state: { ...feed } },
    { id: 'aerobic1', volume: 5750, state: { ...feed } },
    { id: 'aerobic2', volume: 5750, state: { ...feed } },
    { id: 'aerobic3', volume: 5750, state: { ...feed } },
  ];
  const edges: Asm1Edge[] = [
    { from: null, to: 0, flow: 1546, recycle: null },
    { from: 4, to: 0, flow: 454, recycle: 'ras' },
    { from: 0, to: 1, flow: 2000, recycle: null },
    { from: 1, to: 2, flow: 2000, recycle: null },
    { from: 2, to: 3, flow: 2000, recycle: null },
    { from: 3, to: 4, flow: 2000, recycle: null },
  ];
  return { reactors, edges };
}

describe('ASM1 CSTR / network slice', () => {
  it('CSTR 24 h stays finite, non-negative and consumes substrate', () => {
    let state = { ...feed, S_O: 0 };
    for (let i = 0; i < 24; i++) {
      state = stepAsm1Cstr(state, feed, undefined, {
        volume: 1000,
        flow: 100,
        dtHours: 1,
        temperatureC: 20,
      });
    }
    for (const value of Object.values(state)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(state.S_S).toBeLessThan(feed.S_S);
    expect(state.X_B_H).toBeGreaterThan(0);
  });

  it('network RAS thickens particulate COD at the head of the train', () => {
    const { reactors, edges } = train();
    for (let i = 0; i < 96; i++) {
      stepAsm1Network(reactors, edges, feed, undefined, {
        dtHours: 0.5,
        temperatureC: 20,
        xRas: 4500,
      });
    }
    expect(reactors[0].state.X_I).toBeGreaterThan(feed.X_I * 2);
    expect(reactors[4].state.X_I).toBeGreaterThan(feed.X_I);
    for (const reactor of reactors) {
      for (const value of Object.values(reactor.state)) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
    expect(ASM1_COD_PER_VSS).toBe(1.42);
  });

  it('network is deterministic for the same initial state', () => {
    const a = train();
    const b = train();
    for (let i = 0; i < 12; i++) {
      stepAsm1Network(a.reactors, a.edges, feed, undefined, {
        dtHours: 0.5,
        temperatureC: 20,
        xRas: 4500,
      });
      stepAsm1Network(b.reactors, b.edges, feed, undefined, {
        dtHours: 0.5,
        temperatureC: 20,
        xRas: 4500,
      });
    }
    expect(a.reactors.map((r) => r.state)).toEqual(b.reactors.map((r) => r.state));
  });
});
