import { describe, expect, it } from 'vitest';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import {
  addInstrument,
  createInstrumentRegistry,
  measure,
  SENSOR_FAULT_ACTIVE,
  SENSOR_OUT_OF_RANGE,
  type InstrumentSpec,
  type InstrumentVariable,
} from '../src/sim/instruments';

function spec(partial: Partial<InstrumentSpec> & { id: string; variable: InstrumentVariable }): InstrumentSpec {
  return {
    unitId: 'u1',
    min: 0,
    max: 12,
    tauMin: 1,
    deadTimeMin: 0,
    noiseStd: 0.02,
    driftPerDay: 0,
    fault: 'none',
    ...partial,
  };
}

function makeRegistry(s: InstrumentSpec, seed = 11) {
  const registry = createInstrumentRegistry(null, { seed });
  addInstrument(registry, s);
  return registry;
}

describe('仪表测量链：死时间与一阶滞后', () => {
  it('阶跃后死时间内读数保持旧值，到期后按 τ 逼近新真值', () => {
    const registry = makeRegistry(spec({ id: 'u1:do', variable: 'do', deadTimeMin: 2, tauMin: 1, noiseStd: 0.01 }));

    // 预热：真值 2.0 跑 5 步，排空死时间队列、滞后值稳定在 2
    for (let i = 0; i < 5; i += 1) {
      measure(registry, { 'u1:do': 2.0 }, 1);
    }

    // 阶跃到 6.0；deadTime=2 min，dt=1 min → 前 2 步读数不变
    const step6 = measure(registry, { 'u1:do': 6.0 }, 1)[0];
    const step7 = measure(registry, { 'u1:do': 6.0 }, 1)[0];
    expect(Math.abs((step6.measured ?? 0) - 2.0)).toBeLessThan(0.3);
    expect(Math.abs((step7.measured ?? 0) - 2.0)).toBeLessThan(0.3);

    // 第 3 步延迟样本到期，滞后开始逼近 6，但未一步到位
    const step8 = measure(registry, { 'u1:do': 6.0 }, 1)[0];
    expect(step8.measured ?? 0).toBeGreaterThan(2.5);
    expect(step8.measured ?? 0).toBeLessThan(6.0);
  });
});

describe('仪表测量链：故障注入与质量码', () => {
  it('stuck：读数冻结在锁定值，质量码 bad 并带故障码', () => {
    const registry = makeRegistry(spec({ id: 'u1:do', variable: 'do', fault: 'stuck' }));
    const first = measure(registry, { 'u1:do': 3.0 }, 1)[0];
    const second = measure(registry, { 'u1:do': 9.0 }, 1)[0];
    expect(second.measured).toBeCloseTo(first.measured ?? 0, 6);
    expect(second.quality).toBe('bad');
    expect(second.code).toBe(SENSOR_FAULT_ACTIVE);
  });

  it('drift：24 h 后累计偏差符合设定漂移率', () => {
    const registry = makeRegistry(
      spec({ id: 'u1:nh', variable: 'nh', max: 60, tauMin: 0.5, driftPerDay: 0.2, noiseStd: 0.01, fault: 'drift' }),
    );
    // 1440 min = 1 天，dt=60 min，共 24 步
    let reading = measure(registry, { 'u1:nh': 5.0 }, 60)[0];
    for (let i = 1; i < 24; i += 1) {
      reading = measure(registry, { 'u1:nh': 5.0 }, 60)[0];
    }
    const bias = (reading.measured ?? 0) - 5.0;
    expect(bias).toBeGreaterThan(0.15);
    expect(bias).toBeLessThan(0.25);
    expect(reading.quality).toBe('good');
  });

  it('dropout：输出 null，质量码 bad', () => {
    const registry = makeRegistry(spec({ id: 'u1:do', variable: 'do', fault: 'dropout' }));
    const reading = measure(registry, { 'u1:do': 2.0 }, 1)[0];
    expect(reading.measured).toBeNull();
    expect(reading.quality).toBe('bad');
    expect(reading.code).toBe(SENSOR_FAULT_ACTIVE);
  });

  it('超量程：判 uncertain 并带 SENSOR_OUT_OF_RANGE', () => {
    const registry = makeRegistry(spec({ id: 'u1:do', variable: 'do', max: 12 }));
    const reading = measure(registry, { 'u1:do': 20.0 }, 1)[0];
    expect(reading.quality).toBe('uncertain');
    expect(reading.code).toBe(SENSOR_OUT_OF_RANGE);
  });

  it('信号缺失：读数 null 且 bad，不补默认值', () => {
    const registry = makeRegistry(spec({ id: 'u1:do', variable: 'do' }));
    const reading = measure(registry, {}, 1)[0];
    expect(reading.measured).toBeNull();
    expect(reading.quality).toBe('bad');
  });
});

describe('仪表测量链：可复现性与拓扑派生', () => {
  it('相同 seed 的两个注册表，同一真值序列读数完全一致', () => {
    const truth = [2.0, 2.4, 1.8, 2.1, 2.6];
    const run = (seed: number) => {
      const registry = makeRegistry(spec({ id: 'u1:do', variable: 'do', noiseStd: 0.1 }), seed);
      return truth.map((t) => measure(registry, { 'u1:do': t }, 1)[0].measured);
    };
    expect(run(42)).toEqual(run(42));
    expect(run(42)).not.toEqual(run(43));
  });

  it('按拓扑派生测点：好氧池有 DO/MLSS，进水有流量/温度', () => {
    const registry = createInstrumentRegistry(PLANT_TOPOLOGY, { seed: 1 });
    const ids = registry.instruments.map((i) => i.spec.id);
    expect(ids).toContain('aerobic1:do');
    expect(ids).toContain('aerobic1:mlss');
    expect(ids.some((id) => id.startsWith('inlet:'))).toBe(true);
  });
});
