import { describe, expect, it } from 'vitest';
import {
  aerationCapacityOf,
  diurnal,
  mixed,
  recycleFactors,
  scenarioEnvelope,
  seasonalTemperature,
  toxicSuppression,
} from '../src/sim/forcing';

const scenario = (type: string, over: Partial<{ startedAt: number; durationMin: number; magnitude: number }> = {}) =>
  ({ type, startedAt: 0, durationMin: 360, magnitude: 1, ...over }) as never;

describe('日节律与季节性', () => {
  it('日节律在 10 点与 20 点出现双峰，夜间最低', () => {
    const morning = diurnal(10 * 60);
    const evening = diurnal(20 * 60);
    const night = diurnal(3 * 60);
    expect(morning).toBeGreaterThan(night);
    expect(evening).toBeGreaterThan(night);
    expect(morning).toBeCloseTo(1.08, 2);
  });

  it('日节律跨天周期一致', () => {
    expect(diurnal(600)).toBeCloseTo(diurnal(600 + 1440), 10);
  });

  it('水温年周期在 1 月与 7 月分别接近最低/最高', () => {
    const jan = seasonalTemperature(15 * 1440);
    const jul = seasonalTemperature(195 * 1440);
    expect(jan).toBeLessThan(17);
    expect(jul).toBeGreaterThan(22);
    // 正弦相位按「第 60 天」定，取样日与极值日差 15 天，差值略小于 2×3.6
    expect(jul - jan).toBeGreaterThan(4.5);
    expect(jul - jan).toBeLessThanOrEqual(7.3);
  });
});

describe('事故包络', () => {
  it('未注入事故时强度为 0', () => {
    expect(scenarioEnvelope(null, 100)).toBe(0);
  });

  it('进入/退出各有斜坡，中段为 1', () => {
    const s = scenario('storm');
    expect(scenarioEnvelope(s, 10)).toBeCloseTo(0.5, 5);
    expect(scenarioEnvelope(s, 180)).toBe(1);
    expect(scenarioEnvelope(s, 350)).toBeCloseTo(0.125, 3);
    expect(scenarioEnvelope(s, 400)).toBe(0);
  });

  it('窗口之外恒为 0（不会漏到下一段场景）', () => {
    const s = scenario('toxic', { startedAt: 100, durationMin: 60 });
    expect(scenarioEnvelope(s, 99)).toBe(0);
    expect(scenarioEnvelope(s, 161)).toBe(0);
  });

  it('毒性抑制与曝气能力都被包络缩放', () => {
    expect(toxicSuppression(null, 0)).toBe(1);
    expect(toxicSuppression(scenario('toxic'), 180)).toBeLessThan(0.5);
    expect(aerationCapacityOf(null, 0)).toBe(1);
    expect(aerationCapacityOf(scenario('power_outage'), 180)).toBe(0);
    expect(aerationCapacityOf(scenario('blower_failure', { magnitude: 0.6 }), 180)).toBeCloseTo(0.6, 5);
  });

  it('停电把内回流归零并压掉 RAS/WAS', () => {
    const r = recycleFactors({ rasRatio: 0.8, internalRecirc: 2, wasRatio: 0.02 }, scenario('power_outage'), 180);
    expect(r.ir).toBe(0);
    expect(r.ras).toBe(0);
    expect(r.was).toBe(0);
  });

  it('RAS 故障只压污泥回流', () => {
    const r = recycleFactors({ rasRatio: 0.8, internalRecirc: 2, wasRatio: 0.02 }, scenario('ras_failure'), 180);
    expect(r.ir).toBe(2);
    expect(r.ras).toBe(0);
  });
});

describe('混合', () => {
  it('按流量加权', () => {
    expect(mixed(100, 1, 0, 3)).toBe(25);
  });

  it('零流量时保留左值而不是 NaN', () => {
    expect(mixed(42, 0, 0, 0)).toBe(42);
  });
});
