import { describe, expect, it } from 'vitest';
import { AERATION, saturationDo, stepAeration, totalBlowerPower } from '../src/sim/aeration';
import {
  ASM1_PARAMS,
  buildRates,
  emptyAsm1State,
  freeAmmoniaMgL,
  phFromAlkalinity,
  processInhibition,
  reactionRates,
} from '../src/sim/asm1';

describe('曝气氧传递与鼓风控制', () => {
  it('饱和溶解氧随温度下降，20 ℃ 为参数表值', () => {
    expect(saturationDo(20)).toBeCloseTo(AERATION.doSat20, 2);
    expect(saturationDo(12)).toBeGreaterThan(saturationDo(20));
    expect(saturationDo(30)).toBeLessThan(saturationDo(20));
  });

  it('正常供气时 DO 稳定在设定值附近，且产生实际氧传递与风量', () => {
    const r = stepAeration({
      volume: 5000,
      temperatureC: 20,
      doLevel: 2,
      o2Demand: 80,
      doSetpoint: 2,
      capacity: 1,
      previousKla: 0,
      previousIntegral: 0,
      dtH: 1 / 60,
    });
    expect(r.doLevel).toBeGreaterThan(1.7);
    expect(r.doLevel).toBeLessThan(2.3);
    expect(r.kla).toBeGreaterThan(0);
    expect(r.o2TransferredKgH).toBeGreaterThan(0);
    expect(r.airflowM3h).toBeGreaterThan(0);
    expect(r.blowerKw).toBeGreaterThan(0);
  });

  it('鼓风机剩余能力下降时 DO 不能继续贴设定值', () => {
    const r = stepAeration({
      volume: 5000,
      temperatureC: 20,
      doLevel: 2,
      o2Demand: 80,
      doSetpoint: 2,
      capacity: 0.05,
      previousKla: 0,
      previousIntegral: 0,
      dtH: 1 / 60,
    });
    expect(r.doLevel).toBeLessThan(1.7);
    expect(r.kla).toBeLessThanOrEqual(AERATION.klaMax * 0.05 + 1e-9);
  });

  it('停曝气时 DO 按耗氧量下降，不产生风量与功率', () => {
    const r = stepAeration({
      volume: 5000,
      temperatureC: 20,
      doLevel: 2,
      o2Demand: 80,
      doSetpoint: 2,
      capacity: 0,
      previousKla: 8,
      previousIntegral: 1,
      dtH: 1 / 60,
    });
    expect(r.doLevel).toBeLessThan(1.5);
    expect(r.kla).toBe(0);
    expect(r.o2TransferredKgH).toBe(0);
    expect(r.blowerKw).toBe(0);
    expect(r.integral).toBe(0);
  });

  it('KLa 指令受执行器速率限制，不能一步跳到最大值', () => {
    const r = stepAeration({
      volume: 5000,
      temperatureC: 20,
      doLevel: 0.5,
      o2Demand: 80,
      doSetpoint: 2,
      capacity: 1,
      previousKla: 2,
      previousIntegral: 0,
      dtH: 1 / 60,
    });
    expect(r.kla).toBeGreaterThan(2);
    expect(r.kla).toBeLessThanOrEqual(2 + AERATION.klaRateLimitPerHour / 60 + 1e-9);
  });

  it('风机功率按实际传递氧量计算，停机时为 0', () => {
    const on = totalBlowerPower(100, 1);
    const off = totalBlowerPower(100, 0);
    expect(on).toBeGreaterThan(1);
    expect(off).toBe(0);
  });
});

describe('ASM1 pH 与游离氨抑制', () => {
  it('碱度换算 pH 落在合理范围，并与碱度单调上升', () => {
    const low = phFromAlkalinity(3);
    const mid = phFromAlkalinity(7);
    const high = phFromAlkalinity(14);
    expect(low).toBeGreaterThanOrEqual(5.8);
    expect(mid).toBeGreaterThan(low);
    expect(high).toBeGreaterThan(mid);
    expect(high).toBeLessThanOrEqual(8.7);
  });

  it('pH 越高、温度越高，游离氨比例越高', () => {
    const lowPh = freeAmmoniaMgL(30, 7.0, 20);
    const highPh = freeAmmoniaMgL(30, 8.5, 20);
    const warm = freeAmmoniaMgL(30, 8.5, 30);
    expect(highPh).toBeGreaterThan(lowPh);
    expect(warm).toBeGreaterThan(highPh);
  });

  it('基准 pH 下不额外惩罚自养菌，低 pH 明显抑制硝化', () => {
    const state = emptyAsm1State({ S_NH: 30 });
    const neutral = processInhibition('aerobic_growth_autotrophs', state, 7.2, 20);
    const acidic = processInhibition('aerobic_growth_autotrophs', state, 6.0, 20);
    expect(neutral).toBeGreaterThan(0.9);
    expect(acidic).toBeLessThan(0.2);
  });

  it('高 pH + 高氨氮时游离氨抑制自养菌', () => {
    const lowNh = processInhibition('aerobic_growth_autotrophs', emptyAsm1State({ S_NH: 5 }), 8.6, 25);
    const highNh = processInhibition('aerobic_growth_autotrophs', emptyAsm1State({ S_NH: 80 }), 8.6, 25);
    expect(highNh).toBeLessThan(lowNh);
  });

  it('温度修正进入反应速率：低温硝化速率低于高温', () => {
    const s = emptyAsm1State({
      S_S: 70,
      X_S: 200,
      X_B_H: 2500,
      X_B_A: 150,
      S_O: 2,
      S_NO: 5,
      S_NH: 30,
      S_ND: 5,
      X_ND: 10,
    });
    const cold = buildRates(ASM1_PARAMS, 12).aerobic_growth_autotrophs(s);
    const warm = buildRates(ASM1_PARAMS, 25).aerobic_growth_autotrophs(s);
    expect(warm).toBeGreaterThan(cold);
    expect(cold).toBeGreaterThan(0);

    const rCold = reactionRates(s, ASM1_PARAMS, 12);
    const rWarm = reactionRates(s, ASM1_PARAMS, 25);
    expect(rWarm.S_NH).toBeLessThan(rCold.S_NH);
  });
});
