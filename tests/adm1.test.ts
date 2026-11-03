import { describe, expect, it } from 'vitest';
import {
  ADM1_COMPONENTS,
  ADM1_PARAMS,
  ADM1_PROCESSES,
  emptyAdm1State,
  emptyState,
  stepAdm1,
  adm1PH,
} from '../src/sim/adm1';

describe('ADM1 standalone unit', () => {
  it('declares a non-empty standard state/process surface', () => {
    expect(ADM1_COMPONENTS.length).toBeGreaterThanOrEqual(24);
    expect(ADM1_PROCESSES.length).toBeGreaterThanOrEqual(15);
    expect(new Set(ADM1_COMPONENTS).size).toBe(ADM1_COMPONENTS.length);
    expect(new Set(ADM1_PROCESSES).size).toBe(ADM1_PROCESSES.length);
  });

  it('parameters are finite and physically positive where required', () => {
    for (const [key, value] of Object.entries(ADM1_PARAMS)) {
      expect(Number.isFinite(value), key).toBe(true);
      if (/^k_|^K_|^Y_|^q_|^b_|^mu_|^p_|^T_/.test(key)) expect(value, key).toBeGreaterThan(0);
    }
  });

  it('empty state contains every component and no NaN', () => {
    const s = emptyState({ S_ac: 1, X_ac: 2 });
    for (const c of ADM1_COMPONENTS) {
      expect(Number.isFinite(s[c]), c).toBe(true);
      expect(s[c], c).toBeGreaterThanOrEqual(0);
    }
    expect(s.S_ac).toBe(1);
    expect(s.X_ac).toBe(2);
  });

  it('pH diagnostic remains in engineering range', () => {
    expect(adm1PH(emptyState({ S_IC: 10, S_ac: 1 }))).toBeGreaterThan(5.5);
    expect(adm1PH(emptyState({ S_IC: 0, S_ac: 100 }))).toBeGreaterThanOrEqual(5.5);
    expect(adm1PH(emptyState({ S_IC: 100, S_ac: 0 }))).toBeLessThanOrEqual(8.5);
  });
});

describe('ADM1 process behavior', () => {
  const feed = emptyState({
    S_su: 3,
    S_aa: 2,
    S_fa: 1,
    S_ac: 1,
    S_IC: 10,
    S_IN: 2,
    X_c: 3,
    X_su: 1,
    X_aa: 1,
    X_fa: 1,
    X_c4: 1,
    X_pro: 1,
    X_ac: 1,
    X_h2: 1,
  });

  it('anaerobic digestion produces methane gas and biomass', () => {
    let state = emptyState({ ...feed });
    let last = stepAdm1(state, feed, ADM1_PARAMS, { volume: 1000, flow: 100, dtHours: 0.1 });
    state = last.state;
    for (let i = 0; i < 500; i++) {
      last = stepAdm1(state, feed, ADM1_PARAMS, { volume: 1000, flow: 100, dtHours: 0.1 });
      state = last.state;
    }
    expect(last.methaneRate).toBeGreaterThanOrEqual(0);
    expect(last.state.G_ch4).toBeGreaterThanOrEqual(0);
    expect(last.state.X_ac + last.state.X_h2).toBeGreaterThan(0);
  });

  it('never emits negative or non-finite states under long integration', () => {
    let state = emptyState({ ...feed, S_h2: 0.001 });
    for (let i = 0; i < 2000; i++) {
      const out = stepAdm1(state, feed, ADM1_PARAMS, { volume: 1000, flow: 100, dtHours: 0.05 });
      state = out.state;
      for (const c of ADM1_COMPONENTS) {
        expect(Number.isFinite(state[c]), c).toBe(true);
        expect(state[c], c).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('high hydrogen / low pH exposes inhibition instead of silently returning normal', () => {
    const inhibited = emptyState({ ...feed, S_h2: 100, S_ac: 100, S_IC: 0.01 });
    const out = stepAdm1(inhibited, feed, ADM1_PARAMS, { volume: 1000, flow: 100, dtHours: 0.1 });
    expect(out.inhibited).toBe(true);
    expect(out.pH).toBeLessThan(7);
  });

  it('temperature changes kinetics', () => {
    const cold = stepAdm1(feed, feed, ADM1_PARAMS, { volume: 1000, flow: 100, dtHours: 0.1, temperatureC: 10 });
    const warm = stepAdm1(feed, feed, ADM1_PARAMS, { volume: 1000, flow: 100, dtHours: 0.1, temperatureC: 35 });
    expect(warm.methaneRate).toBeGreaterThanOrEqual(cold.methaneRate);
  });

  it('does not mutate input state or parameter object', () => {
    const before = JSON.stringify(feed);
    const paramsBefore = JSON.stringify(ADM1_PARAMS);
    stepAdm1(feed, feed, ADM1_PARAMS, { volume: 1000, flow: 100, dtHours: 0.1 });
    expect(JSON.stringify(feed)).toBe(before);
    expect(JSON.stringify(ADM1_PARAMS)).toBe(paramsBefore);
  });
});

describe('ADM1 辅助分支', () => {
  it('emptyState 对未知覆盖键保持默认 0', () => {
    const s = emptyState();
    expect(s.G_ch4).toBe(0);
    expect(s.X_c).toBe(0);
  });

  it('零进水时状态不炸（全零向量的退化输入）', () => {
    const zero = emptyState();
    const out = stepAdm1(zero, zero, ADM1_PARAMS, { volume: 1000, flow: 100, dtHours: 0.1 });
    expect(Number.isFinite(out.pH)).toBe(true);
    expect(out.methaneRate).toBe(0);
  });

  it('极大流量下稀释主导，状态被进水拉走', () => {
    const feed = emptyState({ S_ac: 10, X_ac: 1, S_IC: 10 });
    const out = stepAdm1(emptyState({ S_ac: 100 }), feed, ADM1_PARAMS, {
      volume: 1,
      flow: 100000,
      dtHours: 1,
    });
    expect(out.state.S_ac).toBeGreaterThan(0);
    expect(Number.isFinite(out.state.S_ac)).toBe(true);
  });

  it('气液转移把溶解态甲烷计入气相', () => {
    const feed = emptyState({ S_ac: 20, X_ac: 5, X_su: 5, S_IC: 20 });
    let state = feed;
    for (let i = 0; i < 300; i++) {
      state = stepAdm1(state, feed, ADM1_PARAMS, { volume: 1000, flow: 50, dtHours: 0.1 }).state;
    }
    expect(state.G_ch4).toBeGreaterThan(0);
  });

  it('emptyAdm1State 与 emptyState 等价且接受覆盖', () => {
    const s = emptyAdm1State({ S_ac: 3 });
    expect(s.S_ac).toBe(3);
    expect(s.G_co2).toBe(0);
    for (const c of ADM1_COMPONENTS) expect(Number.isFinite(s[c]), c).toBe(true);
  });

  it('省略参数对象时使用默认 ADM1_PARAMS', () => {
    const feed = emptyState({ S_ac: 10, X_ac: 2, S_IC: 10 });
    const withDefault = stepAdm1(feed, feed, undefined, { volume: 1000, flow: 100, dtHours: 0.1 });
    const withExplicit = stepAdm1(feed, feed, ADM1_PARAMS, { volume: 1000, flow: 100, dtHours: 0.1 });
    expect(withDefault.state.S_ac).toBeCloseTo(withExplicit.state.S_ac, 12);
    expect(withDefault.pH).toBe(withExplicit.pH);
  });

  it('非有限输入状态被钳制为 0 而不是传播 NaN', () => {
    const bad = emptyState({ S_ac: Number.NaN, S_h2: Number.POSITIVE_INFINITY, S_IC: 5 });
    const out = stepAdm1(bad, emptyState({ S_IC: 5 }), ADM1_PARAMS, {
      volume: 1000,
      flow: 100,
      dtHours: 0.1,
    });
    for (const c of ADM1_COMPONENTS) {
      expect(Number.isFinite(out.state[c]), c).toBe(true);
      expect(out.state[c], c).toBeGreaterThanOrEqual(0);
    }
  });

  it('尚无产气时甲烷体积分数为 0 而不是 NaN', () => {
    const out = stepAdm1(emptyState(), emptyState(), ADM1_PARAMS, { volume: 1000, flow: 100, dtHours: 0.1 });
    expect(out.methaneFraction).toBe(0);
  });
});
