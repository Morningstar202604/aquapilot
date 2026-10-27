import { describe, expect, it } from 'vitest';
import { ALARM_RULES, BLANKET_MARGIN_M, DO_FLOOR_MG_L, SRT_FLOOR_D, evaluateAlarms } from '../src/sim/alarmRules';
import { LIMITS } from '../src/sim/config';
import type { EffluentState } from '../src/sim/plantTypes';

/**
 * 告警规则的唯一来源。
 *
 * 真实漂移：引擎里一份「推进历史数组」、服务端一份「重算活跃列表」，
 * 两边的阈值与文案各改各的，曾经出现同一次超标在历史里是「超一级A」、
 * 在活跃列表里是「超限」。这里锁住规则表本身与触发边界。
 */

const clean: EffluentState = {
  flow: 2000,
  cod: 20,
  bod: 5,
  ss: 5,
  nh: 1,
  tn: 10,
  tp: 0.2,
  ph: 7,
  temperature: 20,
};

const base = { effluent: clean, lastDo: 2, srtDays: 15, blanketM: 1, depth: 4.5, atMin: 100 };

describe('告警规则表', () => {
  it('每个规则都有唯一 code 与可读文案', () => {
    const codes = ALARM_RULES.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const rule of ALARM_RULES) {
      expect(rule.message(base).length).toBeGreaterThan(6);
      expect(rule.metric.length).toBeGreaterThan(0);
    }
  });

  it('六项出水限值全部有对应规则', () => {
    const codes = new Set(ALARM_RULES.map((r) => r.code));
    for (const c of ['EFF_COD', 'EFF_BOD', 'EFF_SS', 'EFF_NH', 'EFF_TN', 'EFF_TP']) expect(codes.has(c)).toBe(true);
  });
});

describe('触发边界', () => {
  it('刚好等于限值不触发（超限才报）', () => {
    const alarms = evaluateAlarms({
      ...base,
      effluent: {
        ...clean,
        nh: LIMITS.nh,
        cod: LIMITS.cod,
        ss: LIMITS.ss,
        tn: LIMITS.tn,
        tp: LIMITS.tp,
        bod: LIMITS.bod,
      },
    });
    expect(alarms).toHaveLength(0);
  });

  it('超过限值才触发，并带上指标与数值', () => {
    const alarms = evaluateAlarms({ ...base, effluent: { ...clean, nh: LIMITS.nh + 0.01 } });
    expect(alarms).toHaveLength(1);
    expect(alarms[0].code).toBe('EFF_NH');
    expect(alarms[0].severity).toBe('critical');
    expect(alarms[0].metric).toBe('nh');
    expect(alarms[0].value).toBeCloseTo(LIMITS.nh + 0.01, 5);
    expect(alarms[0].at).toBe(100);
  });

  it('DO 下限与泥位余量使用具名常量', () => {
    expect(evaluateAlarms({ ...base, lastDo: DO_FLOOR_MG_L - 0.01 }).map((a) => a.code)).toContain('DO_LOW');
    expect(evaluateAlarms({ ...base, lastDo: DO_FLOOR_MG_L }).map((a) => a.code)).not.toContain('DO_LOW');
    const depth = 4.5;
    expect(evaluateAlarms({ ...base, depth, blanketM: depth - BLANKET_MARGIN_M }).map((a) => a.code)).not.toContain(
      'SLUDGE_BLANKET',
    );
    expect(evaluateAlarms({ ...base, depth, blanketM: depth - BLANKET_MARGIN_M + 0.01 }).map((a) => a.code)).toContain(
      'SLUDGE_BLANKET',
    );
  });

  it('SRT 偏低触发警告', () => {
    expect(evaluateAlarms({ ...base, srtDays: SRT_FLOOR_D - 0.1 }).map((a) => a.code)).toContain('SRT_LOW');
  });

  it('多个指标同时超标时按规则表顺序返回全部', () => {
    const alarms = evaluateAlarms({
      ...base,
      effluent: { ...clean, nh: 9, cod: 90, ss: 20 },
    });
    expect(alarms.map((a) => a.code)).toEqual(expect.arrayContaining(['EFF_NH', 'EFF_COD', 'EFF_SS']));
  });
});
