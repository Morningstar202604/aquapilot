import { describe, expect, it } from 'vitest';
import { attributeAlarm, plantHealth, trendSlopes } from '../src/sim/alarmAttribution';
import { LIMITS } from '../src/sim/config';

/**
 * 告警归因与健康度的契约测试。
 *
 * 每个断言都对应操作员能看到的一句话：原因、动作、后果。没有归因的告警
 * 必须返回 null，界面保留原始告警而不是编一段解释。
 */

const baseEffluent = {
  flow: 1600,
  cod: 37,
  bod: 8.5,
  ss: 7.6,
  nh: 0.9,
  tn: 12.8,
  tp: 0.01,
  ph: 7.05,
  temperature: 17,
};

const base = {
  effluent: baseEffluent,
  srtDays: 20,
  lastDo: 2,
  doSetpoint: 2,
  blanketM: 0.5,
  depth: 4.5,
  temperature: 17,
  slopes: { nh: 0.01, cod: 0.01, tn: 0, tp: 0, ss: 0, bod: 0.004 },
};

describe('告警归因', () => {
  it('低溶解氧导致的氨氮超标归因到供氧，并给出可执行动作', () => {
    const a = attributeAlarm({ ...base, code: 'EFF_NH', lastDo: 0.8, effluent: { ...baseEffluent, nh: 6.1 } })!;
    expect(a.unit).toContain('好氧');
    expect(a.cause).toContain('溶解氧');
    expect(a.action).toContain('溶解氧设定');
    expect(a.consequence).toContain('4 小时后');
    expect(a.confidence).toBe('high');
  });

  it('低温时把氨氮归因到温度系数', () => {
    const a = attributeAlarm({ ...base, code: 'EFF_NH', temperature: 12, effluent: { ...baseEffluent, nh: 6 } })!;
    expect(a.cause).toContain('水温');
  });

  it('污泥龄偏短时归因到 SRT', () => {
    const a = attributeAlarm({ ...base, code: 'EFF_NH', srtDays: 6, effluent: { ...baseEffluent, nh: 6 } })!;
    expect(a.cause).toContain('污泥龄');
    expect(a.action).toContain('剩余污泥');
  });

  it('二沉池跑泥导致 SS 超标时归因到泥位', () => {
    const a = attributeAlarm({
      ...base,
      code: 'EFF_SS',
      blanketM: 4.3,
      effluent: { ...baseEffluent, ss: 14 },
    })!;
    expect(a.unit).toBe('二沉池');
    expect(a.cause).toContain('泥位');
    expect(a.confidence).toBe('high');
  });

  it('总磷与碳源/加药相关，给出 PAC 动作', () => {
    const a = attributeAlarm({ ...base, code: 'EFF_TP', effluent: { ...baseEffluent, tp: 0.8 } })!;
    expect(a.action).toContain('PAC');
  });

  it('毒性抑制优先于低溶解氧，归因到生物活性并给出排泥动作', () => {
    const a = attributeAlarm({
      ...base,
      code: 'EFF_NH',
      lastDo: 0.8,
      inhibition: 0.5,
      effluent: { ...baseEffluent, nh: 10 },
    })!;
    expect(a.cause).toContain('毒性抑制');
    expect(a.cause).toContain('50%');
    expect(a.action).toContain('排查');
    expect(a.confidence).toBe('high');
  });

  it('未知告警 code 返回 null，不伪造解释', () => {
    expect(attributeAlarm({ ...base, code: 'SOMETHING_NEW' })).toBeNull();
  });

  it('趋势外推写入后果句子且不出现 NaN', () => {
    const a = attributeAlarm({ ...base, code: 'EFF_COD', effluent: { ...baseEffluent, cod: 52 } })!;
    expect(a.consequence).toMatch(/4 小时后 COD 约 \d/);
    expect(a.consequence).not.toContain('NaN');
  });
});

describe('趋势斜率', () => {
  it('点太少时返回空对象', () => {
    expect(trendSlopes([], 5)).toEqual({});
    expect(
      trendSlopes([{ t: 0, effluentCod: 1, effluentNh: 1, effluentTn: 1, effluentTp: 1, effluentSs: 1 }], 5),
    ).toEqual({});
  });

  it('上升趋势得到正斜率，BOD 与 COD 同号', () => {
    const trends = Array.from({ length: 10 }, (_, i) => ({
      t: i * 10,
      effluentCod: 30 + i,
      effluentNh: 0.5 + i * 0.02,
      effluentTn: 10,
      effluentTp: 0.1,
      effluentSs: 5,
    }));
    const s = trendSlopes(trends, 8);
    expect(s.cod).toBeGreaterThan(0);
    expect(s.bod).toBeGreaterThan(0);
    expect(s.nh).toBeGreaterThan(0);
    expect(s.tn).toBe(0);
  });
});

describe('全厂健康度', () => {
  const healthy = {
    margins: [{ metric: 'BOD₅', ratio: 0.5 }],
    lastDo: 2,
    doSetpoint: 2,
    srtDays: 18,
    blanketM: 0.5,
    depth: 4.5,
    activeAlarms: 0,
  };

  it('正常工况得分高且分项权重和为 1', () => {
    const h = plantHealth(healthy);
    expect(h.score).toBeGreaterThan(85);
    expect(h.grade).toBe('good');
    expect(h.parts.reduce((s, p) => s + p.weight, 0)).toBeCloseTo(1, 6);
  });

  it('出水逼近限值时分数下降', () => {
    const h = plantHealth({ ...healthy, margins: [{ metric: 'SS', ratio: 0.98 }] });
    expect(h.score).toBeLessThan(plantHealth(healthy).score);
    expect(h.grade).not.toBe('good');
  });

  it('活跃告警与跑泥同时出现时判为风险', () => {
    const h = plantHealth({ ...healthy, blanketM: 4.4, activeAlarms: 3, margins: [{ metric: 'SS', ratio: 1.2 }] });
    expect(h.grade).toBe('bad');
  });

  it('健康度不会越界', () => {
    const worst = plantHealth({
      margins: [{ metric: 'SS', ratio: 5 }],
      lastDo: 0,
      doSetpoint: 4,
      srtDays: 0,
      blanketM: 10,
      depth: 4,
      activeAlarms: 10,
    });
    expect(worst.score).toBeGreaterThanOrEqual(0);
    expect(worst.score).toBeLessThanOrEqual(100);
  });

  it('限值来自同一份 config', () => {
    expect(LIMITS.ss).toBe(10);
  });
});
