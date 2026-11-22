import { describe, expect, it } from 'vitest';
import { createComplianceLedger } from '../src/server/complianceLedger';
import type { MinuteReading } from '../src/sim/sampling';

function reading(minute: number, flowM3h = 1000, cod = 30): MinuteReading {
  return { minute, flowM3h, values: { cod, bod: 10, ss: 8, nh: 1.2, tn: 10, tp: 0.3 } };
}

describe('合规采样账本', () => {
  it('保留 40 天读数，超出后从最早开始淘汰', () => {
    const ledger = createComplianceLedger(1440);
    for (let m = 0; m <= 2880; m += 10) ledger.push(reading(m));
    const span = ledger.span();
    expect(span.fromMin).toBeGreaterThanOrEqual(1440);
    expect(span.toMin).toBe(2880);
    expect(span.count).toBeGreaterThan(100);
    // 被淘汰的早期读数取不到
    expect(ledger.readings(0, 600)).toHaveLength(0);
  });

  it('同一仿真分钟重复写入只保留最后一条', () => {
    const ledger = createComplianceLedger();
    ledger.push(reading(10, 1000, 30));
    ledger.push(reading(10, 1200, 45));
    const got = ledger.readings(10, 10);
    expect(got).toHaveLength(1);
    expect(got[0].flowM3h).toBe(1200);
    expect(got[0].values.cod).toBe(45);
  });

  it('拒绝倒退的分钟值（回放/时钟回拨不污染窗口）', () => {
    const ledger = createComplianceLedger();
    ledger.push(reading(100));
    ledger.push(reading(50));
    expect(ledger.span().toMin).toBe(100);
    expect(ledger.readings(50, 50)).toHaveLength(0);
  });

  it('按闭区间取读数，非法窗口返回空数组', () => {
    const ledger = createComplianceLedger();
    for (let m = 0; m <= 60; m += 1) ledger.push(reading(m));
    expect(ledger.readings(10, 20)).toHaveLength(11);
    expect(ledger.readings(20, 10)).toHaveLength(0);
    expect(ledger.readings(Number.NaN, 10)).toHaveLength(0);
  });

  it('40 天容量下 24h 窗口仍可完整取到', () => {
    const ledger = createComplianceLedger();
    for (let m = 0; m <= 3 * 1440; m += 5) ledger.push(reading(m));
    const day3 = ledger.readings(2 * 1440, 3 * 1440);
    expect(day3.length).toBeGreaterThanOrEqual(288);
    expect(day3[0].minute).toBe(2 * 1440);
    expect(day3[day3.length - 1].minute).toBe(3 * 1440);
  });
});
