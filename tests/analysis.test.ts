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
      storedParticulateCodKg: 0,
      influentCodAvg: 300,
    });
    expect(r.selfConsistent).toBe(false);
    expect(r.note).toMatch(/样本不足/);
  });

  it('出水 + 排泥 + 氧化 + 库存 四路合计接近进水时判自洽', () => {
    // 进水 1000 m³ × 300 mg/L = 300 kg COD
    const inflow = 1000;
    const influentCodKg = 300;
    const effluentCodKg = (inflow * 30) / 1000; // 30 kg
    const oxidizedCodKg = 150; // 氧化
    const storedCodKg = 60; // 库存
    const wastedCodKg = influentCodKg - effluentCodKg - oxidizedCodKg - storedCodKg; // 补足剩余
    const r = massBalanceAudit({
      totals: { inflowM3: inflow, wasteSludgeKg: wastedCodKg / 1.42, oxidizedCodKg },
      effluent,
      storedParticulateCodKg: storedCodKg,
      influentCodAvg: 300,
    });
    expect(r.selfConsistent).toBe(true);
    expect(Math.abs(r.closurePct)).toBeLessThan(0.01);
  });

  it('氧化量是最大去向：漏记它会报出巨额假差额（回归）', () => {
    const inflow = 1000;
    const base = {
      totals: { inflowM3: inflow, wasteSludgeKg: 100, oxidizedCodKg: 0 },
      effluent,
      storedParticulateCodKg: 40,
      influentCodAvg: 300,
    };
    const withoutOxidation = massBalanceAudit(base);
    const withOxidation = massBalanceAudit({ ...base, totals: { ...base.totals, oxidizedCodKg: 120 } });
    expect(withoutOxidation.closurePct).toBeGreaterThan(withOxidation.closurePct + 30);
    expect(withOxidation.closurePct).toBeLessThan(20);
  });

  it('库存项不能漏：漏记会把存货误报成泄漏（回归）', () => {
    const inflow = 1000;
    const base = {
      totals: { inflowM3: inflow, wasteSludgeKg: 40, oxidizedCodKg: 100 },
      effluent,
      influentCodAvg: 300,
    };
    const noStorage = massBalanceAudit({ ...base, storedParticulateCodKg: 0 });
    const withStorage = massBalanceAudit({ ...base, storedParticulateCodKg: 120 });
    expect(withStorage.closurePct).toBeLessThan(noStorage.closurePct);
    expect(withStorage.selfConsistent).toBe(true);
  });

  it('只有出水没有排泥/氧化时报出未解释的差额', () => {
    const r = massBalanceAudit({
      totals: { inflowM3: 1000, wasteSludgeKg: 0, oxidizedCodKg: 0 },
      effluent,
      storedParticulateCodKg: 0,
      influentCodAvg: 300,
    });
    expect(r.selfConsistent).toBe(false);
    expect(r.closurePct).toBeGreaterThan(80);
    expect(r.note).toMatch(/未被出水、排泥或氧化解释/);
  });

  it('ASM1 近似模式使用更宽门限并明确说明不能当守恒证明', () => {
    // 进水 300 kg；出水 30 + 排泥 142 + 氧化 100 + 库存 40 = 312 → 差额 -4%
    // 需要落在 (5%, 20%] 区间才能体现两种口径的差异
    const base = {
      totals: { inflowM3: 1000, wasteSludgeKg: 80, oxidizedCodKg: 100 },
      effluent,
      storedParticulateCodKg: 40,
      influentCodAvg: 300,
    };
    const strict = massBalanceAudit(base);
    const approx = massBalanceAudit({ ...base, approximate: true });
    // 同一组数据：严谨模式判不自洽，近似模式判在口径内
    expect(strict.mode).toBe('strict');
    expect(approx.mode).toBe('approximate');
    expect(Math.abs(strict.closurePct)).toBeGreaterThan(5);
    expect(approx.selfConsistent).toBe(true);
    expect(approx.note).toMatch(/不能当作严格守恒证明/);
  });

  it('近似模式超出 ±20% 仍然报警', () => {
    const r = massBalanceAudit({
      totals: { inflowM3: 1000, wasteSludgeKg: 0, oxidizedCodKg: 0 },
      effluent,
      storedParticulateCodKg: 0,
      influentCodAvg: 300,
      approximate: true,
    });
    expect(r.selfConsistent).toBe(false);
    expect(r.note).toMatch(/超出近似口径/);
  });

  it('出水限值口径与主模型一致', () => {
    expect(LIMITS.cod).toBe(50);
    expect(LIMITS.nh).toBe(5);
  });
});
