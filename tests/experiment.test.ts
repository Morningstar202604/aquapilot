import { describe, expect, it } from 'vitest';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import { runExperiment, type ExperimentSpec } from '../src/sim/experiment';

function spec(overrides: Partial<ExperimentSpec> = {}): ExperimentSpec {
  return {
    name: 'test-experiment',
    model: 'asm1',
    seed: 20261019,
    warmupDays: 5,
    durationMin: 120,
    sampleEveryMin: 30,
    scenario: null,
    controls: {},
    plantEnabled: false,
    bioPRemoval: true,
    standardId: 'gb18918-1b',
    policy: 'fixed',
    decisionIntervalMin: 240,
    validation: 'basic',
    ...overrides,
  };
}

describe('离线仿真实验（experiment）', () => {
  it('同拓扑、同种子重复运行逐点一致', async () => {
    const a = await runExperiment(PLANT_TOPOLOGY, spec({ durationMin: 60, sampleEveryMin: 30 }));
    const b = await runExperiment(PLANT_TOPOLOGY, spec({ durationMin: 60, sampleEveryMin: 30 }));
    expect(a.summary.sampleCount).toBe(3);
    expect(a.samples).toEqual(b.samples);
    expect(a.summary.effluent).toEqual(b.summary.effluent);
    expect(a.validation.certified).toBe(true);
  });

  it('采样点覆盖起点、间隔与终点', async () => {
    const r = await runExperiment(PLANT_TOPOLOGY, spec({ durationMin: 120, sampleEveryMin: 30 }));
    expect(r.samples.map((s) => s.minute)).toEqual([0, 30, 60, 90, 120]);
  });

  it('full 级别增加重复性与步长收敛检查', async () => {
    const r = await runExperiment(PLANT_TOPOLOGY, spec({ durationMin: 60, validation: 'full' }));
    expect(r.validation.level).toBe('full');
    expect(r.validation.checks.map((c) => c.id)).toEqual(
      expect.arrayContaining(['repeatability.determinism', 'numerics.stepConvergence']),
    );
    expect(r.validation.checks.find((c) => c.id === 'repeatability.determinism')?.status).toBe('pass');
  });

  it('AI 策略会记录决策并改变控制', async () => {
    const r = await runExperiment(PLANT_TOPOLOGY, spec({ durationMin: 120, policy: 'ai', decisionIntervalMin: 60 }));
    expect(r.summary.decisions).toBeGreaterThan(0);
    expect(r.summary.controlTrace?.length).toBeGreaterThan(0);
    expect(r.summary.policy).toBe('ai');
  });

  it('AbortSignal 可中断长实验', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runExperiment(PLANT_TOPOLOGY, spec({ durationMin: 2_880 }), { signal: controller.signal }),
    ).rejects.toThrow(/cancelled/);
  });

  it('开启全厂边界时返回三本账检查项', async () => {
    const r = await runExperiment(
      PLANT_TOPOLOGY,
      spec({ model: 'asm2d', durationMin: 60, plantEnabled: true, sampleEveryMin: 30 }),
    );
    const check = r.validation.checks.find((c) => c.id === 'massBalance.closed');
    expect(check).toBeDefined();
    expect(r.validation.scope).toBe('plant');
  });
});
