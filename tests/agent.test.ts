import { describe, expect, it } from 'vitest';
import { answer, decide } from '../src/ai/agent';
import { CONTROL_BOUNDS, LIMITS } from '../src/sim/config';
import {
  createNetworkState,
  networkModel,
  spinUpNetwork,
  startNetworkScenario,
  stepNetwork,
} from '../src/sim/networkEngine';
import { PLANT_TOPOLOGY } from '../src/model/topology';

/**
 * 决策层测试跑在生产引擎上。
 *
 * 它们此前审计的是固定五池参考引擎——一条服务端不再运行、AI 也不再预测的路径。
 * 这里换成 networkEngine：预测与被控对象同源，护栏才有意义。
 */
function steadyState(seed = 21) {
  return spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed }), PLANT_TOPOLOGY, 30);
}
const step = (s: ReturnType<typeof steadyState>, dt = 1) => stepNetwork(s, PLANT_TOPOLOGY, dt);
const startScenario = (
  s: ReturnType<typeof steadyState>,
  type: Parameters<typeof startNetworkScenario>[1],
  opts?: Parameters<typeof startNetworkScenario>[2],
) => startNetworkScenario(s, type, opts);
const model = (s: ReturnType<typeof steadyState>) => networkModel(PLANT_TOPOLOGY, s);

describe('AI decision guardrails', () => {
  it('never proposes dissolved oxygen below the process floor', () => {
    const s = steadyState();
    const rec = decide({ model: model(s), horizonMin: 180 });
    expect(rec.chosens.controls.doSetpoint).toBeGreaterThanOrEqual(1.5);
    expect(rec.chosens.controls.doSetpoint).toBeLessThanOrEqual(CONTROL_BOUNDS.doSetpoint.max);
  });

  it('never cuts PAC below the chemical phosphorus backstop', () => {
    const s = steadyState();
    const rec = decide({ model: model(s), horizonMin: 180 });
    expect(rec.chosens.controls.pacDose).toBeGreaterThanOrEqual(18);
  });

  it('keeps every proposed control inside its physical bounds', () => {
    const s = steadyState();
    startScenario(s, 'storm');
    const rec = decide({ model: model(s), horizonMin: 180 });
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
    const rec = decide({ model: model(s), horizonMin: 240 });
    expect(rec.chosens.controls.doSetpoint).toBeGreaterThanOrEqual(2.4);
    expect(['normal', 'watch', 'critical']).toContain(rec.severity);
    expect(rec.rationale.length).toBeGreaterThan(0);
  });

  it('选择的方案不劣于任意备选（真实比较，不把自己算进上界）', () => {
    const s = steadyState();
    startScenario(s, 'blower_failure', { durationMin: 240, magnitude: 0.35 });
    for (let i = 0; i < 60; i++) step(s, 1);
    const rec = decide({ model: model(s), horizonMin: 240 });
    for (const alt of rec.alternatives) {
      expect(rec.chosens.score).toBeGreaterThanOrEqual(alt.score - 1e-9);
    }
  });

  it('方案区分度落在 0–1 之间', () => {
    const s = steadyState();
    const rec = decide({ model: model(s), horizonMin: 180 });
    expect(rec.separation).toBeGreaterThan(0.3);
    expect(rec.separation).toBeLessThanOrEqual(1);
  });

  it('explains each tweak with a human readable reason', () => {
    const s = steadyState();
    startScenario(s, 'storm');
    const rec = decide({ model: model(s), horizonMin: 240 });
    for (const tweak of rec.tweaks) {
      expect(tweak.reason.length).toBeGreaterThan(8);
      expect(tweak.to).not.toBe(tweak.from);
    }
  });

  it('is deterministic for the same state', () => {
    const s = steadyState();
    const a = decide({ model: model(s), horizonMin: 180 });
    const b = decide({ model: model(s), horizonMin: 180 });
    expect(a.chosens.controls).toEqual(b.chosens.controls);
    expect(a.summary).toBe(b.summary);
  });
});

describe('AI conversational answers', () => {
  it('answers a status question with current effluent data', () => {
    const s = steadyState();
    const a = answer('现在运行怎么样', model(s), null);
    expect(a.kind).toBe('status');
    expect(a.body).toContain(s.effluent.nh.toFixed(2));
    expect(a.confidence).toBeGreaterThan(0.8);
  });

  it('explains the latest recommendation on a why question', () => {
    const s = steadyState();
    startScenario(s, 'storm');
    const rec = decide({ model: model(s), horizonMin: 180 });
    const a = answer('为什么这样调节', model(s), rec);
    expect(a.kind).toBe('explain');
    expect(a.body).toBe(rec.summary);
  });

  it('runs a what-if forecast for a named scenario', () => {
    const s = steadyState();
    const before = s.timeMin;
    const a = answer('如果发生暴雨会怎样', model(s), null);
    expect(a.kind).toBe('whatif');
    expect(a.title).toContain('暴雨');
    expect(a.bullets.join(' ')).toMatch(/限值内|超标/);
    expect(a.bullets.some((b) => b.includes('能耗峰值'))).toBe(true);
    expect(s.timeMin).toBe(before);
  });

  it('falls back to guidance when the question is not understood', () => {
    const s = steadyState();
    const a = answer('今天午饭吃什么', model(s), null);
    expect(a.kind).toBe('unknown');
    expect(a.bullets.length).toBeGreaterThan(0);
  });
});

describe('closed loop safety', () => {
  it('暴雨闭环下出水悬浮物不失控（收紧到 1.5 倍限值）', () => {
    const s = steadyState(2026);
    startScenario(s, 'storm', { durationMin: 360 });
    for (let cycle = 0; cycle < 8; cycle++) {
      const rec = decide({ model: model(s), horizonMin: 180 });
      s.controls = { ...rec.chosens.controls, aiEnabled: true };
      for (let m = 0; m < 30; m++) step(s, 1);
    }
    expect(s.effluent.ss).toBeLessThan(LIMITS.ss * 1.5);
    expect(s.effluent.cod).toBeLessThan(LIMITS.cod * 2);
    expect(Number.isFinite(s.effluent.cod)).toBe(true);
  });

  it('holds the dissolved oxygen target through a full day of closed loop control', () => {
    const s = steadyState(404);
    /**
     * 这条测的是「连续 48 个周期后 DO 是否仍被控制住」，不是鲁棒评估本身，
     * 因此关掉 ensemble（每个候选 3 条轨迹）。开启时在覆盖率插桩下会超过
     * 20 s 的测试超时，而那属于性能而非行为回归。
     */
    for (let cycle = 0; cycle < 48; cycle++) {
      const rec = decide({ model: model(s), horizonMin: 120, robust: false });
      s.controls = { ...rec.chosens.controls, aiEnabled: true };
      for (let m = 0; m < 30; m++) step(s, 1);
    }
    const aerobic = s.reactors.filter((t) => t.kind === 'aerobic');
    for (const tank of aerobic) {
      expect(tank.doLevel).toBeGreaterThan(0.9);
      expect(tank.doLevel).toBeLessThan(5);
    }
  });
});
