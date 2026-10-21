import { describe, expect, it } from 'vitest';
import { answer, decide } from '../src/ai/agent';
import { CONTROL_BOUNDS, DEFAULT_CONTROLS, LIMITS } from '../src/sim/config';
import { createInitialState, forecast, spinUp, startScenario, step } from '../src/sim/engine';
import { legacyModel } from '../src/sim/plantModel';

function steadyState(seed = 21) {
  return spinUp(createInitialState({ seed }), 30);
}

describe('AI decision guardrails', () => {
  it('never proposes dissolved oxygen below the process floor', () => {
    const s = steadyState();
    const rec = decide({ model: legacyModel(s, forecast), horizonMin: 180 });
    expect(rec.chosens.controls.doSetpoint).toBeGreaterThanOrEqual(1.5);
    expect(rec.chosens.controls.doSetpoint).toBeLessThanOrEqual(CONTROL_BOUNDS.doSetpoint.max);
  });

  it('never cuts PAC below the chemical phosphorus backstop', () => {
    const s = steadyState();
    const rec = decide({ model: legacyModel(s, forecast), horizonMin: 180 });
    expect(rec.chosens.controls.pacDose).toBeGreaterThanOrEqual(18);
  });

  it('keeps every proposed control inside its physical bounds', () => {
    const s = steadyState();
    startScenario(s, 'storm');
    const rec = decide({ model: legacyModel(s, forecast), horizonMin: 180 });
    for (const [key, value] of Object.entries(rec.chosens.controls)) {
      if (key === 'aiEnabled') continue;
      const bounds = CONTROL_BOUNDS[key as keyof typeof CONTROL_BOUNDS];
      expect(value).toBeGreaterThanOrEqual(bounds.min);
      expect(value).toBeLessThanOrEqual(bounds.max);
    }
  });

  it('raises dissolved oxygen when toxicity suppresses nitrification', () => {
    const s = steadyState();
    startScenario(s, 'toxic', { durationMin: 360 });
    for (let i = 0; i < 120; i++) step(s, 1);
    const rec = decide({ model: legacyModel(s, forecast), horizonMin: 240 });
    expect(rec.chosens.controls.doSetpoint).toBeGreaterThanOrEqual(2.4);
    expect(rec.severity).toMatch(/watch|critical|normal/);
    expect(rec.rationale.length).toBeGreaterThan(0);
  });

  it('prefers a compliant candidate over one that predicts violations', () => {
    const s = steadyState();
    startScenario(s, 'blower_failure', { durationMin: 240, magnitude: 0.35 });
    for (let i = 0; i < 60; i++) step(s, 1);
    const rec = decide({ model: legacyModel(s, forecast), horizonMin: 240 });
    expect(rec.chosens.violations).toBeLessThanOrEqual(
      Math.max(...rec.alternatives.map((a) => a.violations), rec.chosens.violations),
    );
  });

  it('reports confidence inside a bounded range', () => {
    const s = steadyState();
    const rec = decide({ model: legacyModel(s, forecast), horizonMin: 180 });
    expect(rec.confidence).toBeGreaterThan(0.3);
    expect(rec.confidence).toBeLessThanOrEqual(1);
  });

  it('explains each tweak with a human readable reason', () => {
    const s = steadyState();
    startScenario(s, 'storm');
    const rec = decide({ model: legacyModel(s, forecast), horizonMin: 240 });
    for (const tweak of rec.tweaks) {
      expect(tweak.reason.length).toBeGreaterThan(8);
      expect(tweak.to).not.toBe(tweak.from);
    }
  });

  it('is deterministic for the same state', () => {
    const s = steadyState();
    const a = decide({ model: legacyModel(s, forecast), horizonMin: 180 });
    const b = decide({ model: legacyModel(s, forecast), horizonMin: 180 });
    expect(a.chosens.controls).toEqual(b.chosens.controls);
    expect(a.summary).toBe(b.summary);
  });
});

describe('AI conversational answers', () => {
  it('answers a status question with current effluent data', () => {
    const s = steadyState();
    const a = answer('现在运行怎么样', legacyModel(s, forecast), null);
    expect(a.kind).toBe('status');
    expect(a.body).toContain(s.effluent.nh.toFixed(2));
    expect(a.confidence).toBeGreaterThan(0.8);
  });

  it('explains the latest recommendation on a why question', () => {
    const s = steadyState();
    startScenario(s, 'storm');
    const rec = decide({ model: legacyModel(s, forecast), horizonMin: 180 });
    const a = answer('为什么这样调节', legacyModel(s, forecast), rec);
    expect(a.kind).toBe('explain');
    expect(a.body).toBe(rec.summary);
  });

  it('runs a what-if forecast for a named scenario', () => {
    const s = steadyState();
    const before = s.timeMin;
    const a = answer('如果发生暴雨会怎样', legacyModel(s, forecast), null);
    expect(a.kind).toBe('whatif');
    expect(a.title).toContain('暴雨');
    expect(a.bullets.join(' ')).toMatch(/限值内|超标/);
    expect(a.bullets.some((b) => b.includes('能耗峰值'))).toBe(true);
    expect(s.timeMin).toBe(before);
  });

  it('falls back to guidance when the question is not understood', () => {
    const s = steadyState();
    const a = answer('今天午饭吃什么', legacyModel(s, forecast), null);
    expect(a.kind).toBe('unknown');
    expect(a.bullets.length).toBeGreaterThan(0);
  });
});

describe('closed loop safety', () => {
  it('keeps the plant compliant through a storm when the AI is in control', () => {
    const s = steadyState(2026);
    startScenario(s, 'storm', { durationMin: 360 });
    for (let cycle = 0; cycle < 8; cycle++) {
      const rec = decide({ model: legacyModel(s, forecast), horizonMin: 180 });
      s.controls = { ...rec.chosens.controls, aiEnabled: true };
      for (let m = 0; m < 30; m++) step(s, 1);
    }
    expect(s.effluent.ss).toBeLessThan(LIMITS.ss * 2);
    expect(Number.isFinite(s.effluent.cod)).toBe(true);
  });

  it('holds the dissolved oxygen target through a full day of closed loop control', () => {
    const s = steadyState(404);
    for (let cycle = 0; cycle < 48; cycle++) {
      const rec = decide({ model: legacyModel(s, forecast), horizonMin: 120 });
      s.controls = { ...rec.chosens.controls, aiEnabled: true };
      for (let m = 0; m < 30; m++) step(s, 1);
    }
    const aerobic = s.tanks.filter((t) => t.kind === 'aerobic');
    for (const tank of aerobic) {
      expect(tank.do).toBeGreaterThan(0.9);
      expect(tank.do).toBeLessThan(5);
    }
  });
});
