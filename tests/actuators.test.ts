import { describe, expect, it } from 'vitest';
import {
  ACTUATOR_INVALID_INPUT,
  ACTUATOR_SATURATED,
  ACTUATOR_UNAVAILABLE,
  commandActuator,
  createFan,
  createPump,
  createValve,
  failSafePosition,
  pumpPowerKw,
} from '../src/sim/actuators';

describe('阀门：速率限制与行程饱和', () => {
  it('0→100% 指令按速率限制分多步到位，不能一步跳满', () => {
    const valve = createValve('v1', 'u1', { rateLimitPerMin: 20, deadband: 0 });
    const first = commandActuator(valve, 100, 1);
    expect(first.status).toBe('clamped');
    expect(first.code).toBe(ACTUATOR_SATURATED);
    expect(first.actual).toBeCloseTo(20, 6);

    // 5 步爬坡到 100%
    let last = first;
    for (let i = 0; i < 4; i += 1) last = commandActuator(valve, 100, 1);
    expect(last.actual).toBeCloseTo(100, 6);
  });

  it('越界指令钳到行程上限并标记饱和', () => {
    const valve = createValve('v2', 'u1', { rateLimitPerMin: 100, deadband: 0 });
    const r = commandActuator(valve, 150, 1);
    expect(r.status).toBe('clamped');
    expect(r.code).toBe(ACTUATOR_SATURATED);
    expect(r.actual).toBeCloseTo(100, 6);
  });

  it('NaN 指令拒绝执行，不静默通过', () => {
    const valve = createValve('v3', 'u1');
    const r = commandActuator(valve, NaN, 1);
    expect(r.status).toBe('rejected');
    expect(r.code).toBe(ACTUATOR_INVALID_INPUT);
  });
});

describe('风机：可用性折减与不可用拒绝', () => {
  it('可用性因子 0.5 时最大风量比例减半', () => {
    const fan = createFan('b1', 'aerobic1', { rateLimitPerMin: 1, deadband: 0 });
    const r = commandActuator(fan, 1, 1, 0.5);
    expect(r.status).toBe('clamped');
    expect(r.code).toBe(ACTUATOR_SATURATED);
    expect(r.actual).toBeCloseTo(0.5, 6);
  });

  it('可用性因子 0 时指令被拒', () => {
    const fan = createFan('b2', 'aerobic1');
    const r = commandActuator(fan, 0.8, 1, 0);
    expect(r.status).toBe('rejected');
    expect(r.code).toBe(ACTUATOR_UNAVAILABLE);
    expect(r.actual).toBe(0);
  });

  it('低于喘振下限的运行指令被拉回下限', () => {
    const fan = createFan('b3', 'aerobic1', { surgeFloor: 0.25, rateLimitPerMin: 1, deadband: 0 });
    const r = commandActuator(fan, 0.1, 1);
    expect(r.actual).toBeCloseTo(0.25, 6);
    expect(r.code).toBe(ACTUATOR_SATURATED);
  });
});

describe('泵与失效安全位', () => {
  it('泵功率按相似定律 P ∝ n³ 折算', () => {
    const pump = createPump('p1', 'clarifier', { ratedPowerKw: 100 });
    expect(pumpPowerKw(pump, 0.5)).toBeCloseTo(12.5, 2);
    expect(pumpPowerKw(pump, 0)).toBeCloseTo(0, 6);
  });

  it('fail-closed 进下限，lock 保持原位', () => {
    const closed = createValve('v4', 'u1', { failMode: 'fail-closed', initial: 60 });
    expect(failSafePosition(closed)).toBe(0);
    const locked = createValve('v5', 'u1', { failMode: 'lock', initial: 60 });
    expect(failSafePosition(locked)).toBeCloseTo(60, 6);
  });
});
