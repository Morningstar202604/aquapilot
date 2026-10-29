import { describe, expect, it } from 'vitest';
import { massBalanceAudit, paretoFrontier, sensitivityAnalysis } from '../src/sim/analysis';
import { createNetworkState, networkModel, spinUpNetwork } from '../src/sim/networkEngine';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import { LIMITS } from '../src/sim/config';

/**
 * 运行分析三件套。
 *
 * 这些都是"运营真问题"，不是展示字段：
 * - 灵敏度：调哪个旋钮真的有效；
 * - Pareto：达标与省钱之间的真实取舍；
 * - 质量平衡：累计口径是否自洽（模型可信度底线）。
 */

const makeModel = () => {
  const net = createNetworkState(PLANT_TOPOLOGY, { seed: 20261019 });
  spinUpNetwork(net, PLANT_TOPOLOGY, 30);
  return { net, model: networkModel(PLANT_TOPOLOGY, net) };
};

describe('参数灵敏度', () => {
  it('返回全部连续可调量，按有效性降序', () => {
    const { model } = makeModel();
    const rows = sensitivityAnalysis(model, 120);
    expect(rows.length).toBeGreaterThanOrEqual(6);
    expect(rows.map((r) => r.key)).toContain('doSetpoint');
    for (let i = 1; i < rows.length; i++) {
      expect(Math.abs(rows[i - 1].normalized)).toBeGreaterThanOrEqual(Math.abs(rows[i].normalized));
    }
  });

  it('每行都带可展示的结论，且数值有限', () => {
    const { model } = makeModel();
    for (const r of sensitivityAnalysis(model, 120)) {
      expect(Number.isFinite(r.slope)).toBe(true);
      expect(Number.isFinite(r.normalized)).toBe(true);
      expect(r.verdict.length).toBeGreaterThan(0);
    }
  });

  it('提高溶解氧对氨氮硝化有正效应（物理方向正确）', () => {
    const { model } = makeModel();
    const state = model.snapshot();
    const low = model.predict({ ...state.controls, doSetpoint: 1.5 }, 240, 30);
    const high = model.predict({ ...state.controls, doSetpoint: 3.0 }, 240, 30);
    const nhLow = low.points.at(-1)!.effluent.nh;
    const nhHigh = high.points.at(-1)!.effluent.nh;
    expect(nhHigh).toBeLessThanOrEqual(nhLow + 1e-9);
  });
});

describe('Pareto 前沿', () => {
  it('前沿内不存在互相支配的点', () => {
    const { model } = makeModel();
    const all = paretoFrontier(model, 120);
    const front = all.filter((p) => !p.dominated);
    for (const a of front) {
      for (const b of front) {
        if (a === b) continue;
        const bBetter = b.worstRatio <= a.worstRatio && b.costDelta <= a.costDelta;
        const strict = b.worstRatio < a.worstRatio || b.costDelta < a.costDelta;
        expect(bBetter && strict).toBe(false);
      }
    }
  });

  it('包含「维持现状」作为基准，且至少有一个非支配解', () => {
    const { model } = makeModel();
    const all = paretoFrontier(model, 120);
    expect(all.some((p) => p.label === '维持现状')).toBe(true);
    expect(all.filter((p) => !p.dominated).length).toBeGreaterThan(0);
    expect(all.length).toBeGreaterThan(10);
  });

  it('所有方案的出水比值都是有限正数', () => {
    const { model } = makeModel();
    for (const p of paretoFrontier(model, 60)) {
      expect(Number.isFinite(p.worstRatio)).toBe(true);
      expect(p.worstRatio).toBeGreaterThan(0);
      expect(Number.isFinite(p.costDelta)).toBe(true);
    }
  });
});

describe('质量平衡审计', () => {
  const effluent = { flow: 1800, cod: 30, bod: 8, ss: 5, nh: 1, tn: 8, tp: 0.2, ph: 7, temperature: 20 };

  it('样本不足时明确标注，而不是把 0/0 判成自洽', () => {
    const r = massBalanceAudit({
      totals: { inflowM3: 0, wasteSludgeKg: 0 },
      effluent,
      biomassKg: 0,
      influentCodAvg: 300,
    });
    expect(r.selfConsistent).toBe(false);
    expect(r.note).toMatch(/样本不足/);
  });

  it('进出接近时判自洽', () => {
    // 进水 300 mg/L、出水 30 mg/L、排泥 100 kg → 出水占 10%，仍有 90% 差额
    // 构造一个真正闭合的样本：排泥补足剩余
    const inflow = 1000; // m³
    const influentCodAvg = 300; // mg/L → 300 kg
    const effluentCodKg = (inflow * 30) / 1000; // 30 kg
    const wastedKg = (300 - effluentCodKg) / 1.42; // 190.14 kg
    const r = massBalanceAudit({
      totals: { inflowM3: inflow, wasteSludgeKg: wastedKg },
      effluent,
      biomassKg: 1000,
      influentCodAvg,
    });
    expect(r.selfConsistent).toBe(true);
    expect(Math.abs(r.closurePct)).toBeLessThan(1);
  });

  it('只有出水没有排泥时报出未解释的差额', () => {
    const r = massBalanceAudit({
      totals: { inflowM3: 1000, wasteSludgeKg: 0 },
      effluent,
      biomassKg: 1000,
      influentCodAvg: 300,
    });
    expect(r.selfConsistent).toBe(false);
    expect(r.closurePct).toBeGreaterThan(80);
    expect(r.note).toMatch(/未被出水或排泥解释/);
  });

  it('出水限值口径与主模型一致', () => {
    expect(LIMITS.cod).toBe(50);
    expect(LIMITS.nh).toBe(5);
  });
});
