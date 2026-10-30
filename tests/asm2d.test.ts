import { describe, expect, it } from 'vitest';
import {
  ASM2D_COMPONENTS,
  ASM2D_PARAMS,
  ASM2D_PROCESSES,
  asm2dDescriptor,
  buildAsm2dRates,
  buildAsm2dStoichiometry,
  emptyAsm2dState,
  stepAsm2dCstr,
} from '../src/sim/asm2d';
import { checkModelConservation } from '../src/sim/modelRegistry';

describe('ASM2d model descriptor', () => {
  it('declares the standard 19-state / 19-process surface', () => {
    expect(ASM2D_COMPONENTS).toHaveLength(19);
    expect(ASM2D_PROCESSES).toHaveLength(19);
    expect(new Set(ASM2D_COMPONENTS).size).toBe(19);
    expect(new Set(ASM2D_PROCESSES).size).toBe(19);
  });

  it('has finite parameters and bounded positive kinetic constants', () => {
    for (const [key, value] of Object.entries(ASM2D_PARAMS)) {
      expect(Number.isFinite(value), key).toBe(true);
      if (key.startsWith('K_') || key.startsWith('k_') || key.startsWith('mu_') || key.startsWith('q_')) {
        expect(value, key).toBeGreaterThan(0);
      }
    }
  });

  it('all process rows use declared components only', () => {
    const rows = buildAsm2dStoichiometry();
    for (const process of ASM2D_PROCESSES) {
      for (const component of Object.keys(rows[process])) {
        expect((ASM2D_COMPONENTS as readonly string[]).includes(component), `${process}.${component}`).toBe(true);
      }
    }
  });

  it('conservation checker reports every process and no unexpected residual', () => {
    const rows = checkModelConservation(asm2dDescriptor());
    expect(rows).toHaveLength(ASM2D_PROCESSES.length);
    expect(rows.every((row) => row.ok)).toBe(true);
    expect(rows.filter((row) => row.note).length).toBeGreaterThan(0);
  });
});

describe('ASM2d CSTR behavior', () => {
  const influent = emptyAsm2dState({
    S_A: 60,
    S_F: 30,
    S_PO4: 5,
    S_NH4: 30,
    S_O: 0,
    S_NO3: 0.1,
    X_H: 2000,
    X_PAO: 300,
    X_AUT: 80,
    X_PP: 300,
    X_PHA: 50,
    S_ALK: 8,
  });

  it('anaerobic PAO storage releases phosphate', () => {
    let state = { ...influent, S_O: 0, S_NO3: 0 };
    for (let i = 0; i < 24; i++) {
      state = stepAsm2dCstr(state, influent, ASM2D_PARAMS, { volume: 1000, flow: 100, dtHours: 1 });
    }
    expect(state.S_PO4).toBeGreaterThan(influent.S_PO4);
    expect(state.X_PHA).toBeGreaterThan(influent.X_PHA);
  });

  it('aerobic PAO operation consumes phosphate relative to anaerobic state', () => {
    let anaerobic = { ...influent, S_O: 0, S_NO3: 0 };
    for (let i = 0; i < 24; i++) {
      anaerobic = stepAsm2dCstr(anaerobic, influent, ASM2D_PARAMS, { volume: 1000, flow: 100, dtHours: 1 });
    }
    let aerobic = { ...anaerobic, S_O: 2, S_NO3: 0.1 };
    for (let i = 0; i < 48; i++) {
      aerobic = stepAsm2dCstr(aerobic, influent, ASM2D_PARAMS, { volume: 1000, flow: 100, dtHours: 1 });
    }
    expect(aerobic.S_PO4).toBeLessThan(anaerobic.S_PO4);
  });

  it('never emits negative concentrations or non-finite values', () => {
    let state = { ...influent, S_O: 2, S_NO3: 5 };
    for (let i = 0; i < 240; i++) {
      state = stepAsm2dCstr(state, influent, ASM2D_PARAMS, { volume: 1000, flow: 100, dtHours: 1 });
      for (const component of ASM2D_COMPONENTS) {
        expect(Number.isFinite(state[component]), component).toBe(true);
        expect(state[component], component).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('temperature changes kinetic rates but does not mutate the parameter object', () => {
    const state = { ...influent, S_O: 2 };
    const cold = buildAsm2dRates(ASM2D_PARAMS, 10).aerobic_growth_XH(state);
    const warm = buildAsm2dRates(ASM2D_PARAMS, 30).aerobic_growth_XH(state);
    expect(warm).toBeGreaterThan(cold);
    expect(ASM2D_PARAMS.T_REF).toBe(20);
  });
});
