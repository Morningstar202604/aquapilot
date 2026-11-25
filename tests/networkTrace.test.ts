import { describe, expect, it } from 'vitest';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import { createNetworkState, stepNetwork } from '../src/sim/networkEngine';
import type { NetworkStepTrace } from '../src/sim/networkTrace';

describe('production step trace', () => {
  it('captures every module boundary for an ASM2d plant step', () => {
    const state = createNetworkState(PLANT_TOPOLOGY, {
      seed: 21,
      model: 'asm2d',
      plantEnabled: true,
    });
    // The first production step materializes per-reactor ASM2d states; trace it next.
    stepNetwork(state, PLANT_TOPOLOGY, 15);
    const traces: NetworkStepTrace[] = [];
    stepNetwork(state, PLANT_TOPOLOGY, 15, (trace) => traces.push(trace));

    expect(traces).toHaveLength(1);
    const trace = traces[0];
    expect(trace.timeMin).toBe(30);
    expect(trace.dtMin).toBe(15);
    expect(trace.asm2d?.reactors).toHaveLength(5);
    expect(trace.asm2d?.reactors.every((r) => r.state && Number.isFinite(r.state.S_F))).toBe(true);
    expect(trace.asm2d?.edges.length).toBeGreaterThan(0);
    expect(trace.asm2d?.expected.reactors).toHaveLength(5);
    expect(Number.isFinite(trace.asm2d?.expected.flux.o2DemandKgH)).toBe(true);
    expect(trace.settlers?.length).toBeGreaterThan(0);
    expect(trace.settlers?.[0].state.x).toHaveLength(10);
    expect(trace.sludge?.initial.digester.adm1.S_su).toBeTypeOf('number');
    expect(trace.sludge?.expected.state.digester.adm1.G_co2).toBeTypeOf('number');
    expect(trace.balance?.input.influent.cod).toBeGreaterThan(0);
    expect(trace.balance?.initial.cod).toBeDefined();
    expect(trace.balance?.expected.cod).toBeDefined();
    expect(trace.inventory?.reactors).toHaveLength(5);
    expect(trace.inventory?.expected.codKg).toBeGreaterThan(0);
    expect(trace.effluent?.Qe).toBeGreaterThan(0);
    expect(trace.effluent?.expected.cod).toBeTypeOf('number');
    expect(trace.biomass?.Q).toBeGreaterThan(0);
    expect(trace.biomass?.expected.srtDays).toBeGreaterThan(0);
  });

  it('does not fabricate ASM2d/plant sections for an ASM1 non-plant step', () => {
    const state = createNetworkState(PLANT_TOPOLOGY, {
      seed: 3,
      model: 'asm1',
      plantEnabled: false,
    });
    let trace: NetworkStepTrace | undefined;
    stepNetwork(state, PLANT_TOPOLOGY, 15, (t) => {
      trace = t;
    });

    expect(trace?.asm2d).toBeUndefined();
    expect(trace?.sludge).toBeUndefined();
    // The plant boundary object exists even when the sludge line is disabled,
    // so the mass-book trace is still present and auditable.
    expect(trace?.balance).toBeDefined();
    expect(trace?.inventory).toBeUndefined();
    expect(trace?.settlers?.length).toBeGreaterThan(0);
    expect(trace?.effluent?.expected.cod).toBeTypeOf('number');
    expect(trace?.biomass?.expected.biomassKg).toBeGreaterThanOrEqual(0);
  });

  it('keeps the no-hook path free of trace side effects', () => {
    const state = createNetworkState(PLANT_TOPOLOGY, { seed: 5, model: 'asm2d', plantEnabled: true });
    let calls = 0;
    const before = state.timeMin;
    stepNetwork(state, PLANT_TOPOLOGY, 15, () => {
      calls += 1;
    });
    stepNetwork(state, PLANT_TOPOLOGY, 15);
    expect(calls).toBe(1);
    expect(state.timeMin).toBe(before + 30);
  });
});
