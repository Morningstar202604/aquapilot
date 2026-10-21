import { describe, expect, it } from 'vitest';
import {
  BSM1_SETTLER,
  createSettler,
  runSettlerToSteady,
  settlingVelocity,
  stepSettler,
  type SettlerConfig,
} from '../src/sim/takacs';

const cfg: SettlerConfig = { ...BSM1_SETTLER, area: 1500, depth: 4.0 };
const Q = 18446; // m³/d

describe('Takács 沉降速度', () => {
  it('浓度越高沉降越慢（双指数特性）', () => {
    const v500 = settlingVelocity(500, cfg);
    const v3000 = settlingVelocity(3000, cfg);
    const v8000 = settlingVelocity(8000, cfg);
    expect(v500).toBeGreaterThan(v3000);
    expect(v3000).toBeGreaterThan(v8000);
    expect(v8000).toBeGreaterThan(0);
  });

  it('零浓度时沉降速度为零', () => {
    expect(settlingVelocity(0, cfg)).toBe(0);
  });

  it('不超过最大沉降速度', () => {
    for (const x of [10, 100, 1000, 5000, 20000]) {
      expect(settlingVelocity(x, cfg)).toBeLessThanOrEqual(cfg.v0Max);
    }
  });
});

describe('Takács 稳态剖面', () => {
  it('BSM1 标准工况下出水 SS 与回流浓度落在合理范围', () => {
    const r = runSettlerToSteady(cfg, { flow: Q * 2, concentration: 3000 }, { flow: Q }, { maxDays: 60, dtDays: 1 / 1440 });
    // BSM1 报告出水 TSS 约 12-14 g/m³，折算 SS 约 5-8
    expect(r.xEffluent).toBeGreaterThan(0.5);
    expect(r.xEffluent).toBeLessThan(20);
    // 回流污泥应被浓缩
    expect(r.xUnderflow).toBeGreaterThan(2000);
    expect(r.xUnderflow).toBeLessThan(15000);
  });

  it('回流浓度不显著低于进料浓度（底层未塌陷）', () => {
    // 已知限制：当前实现下浓缩区的浓度梯度不足，回流浓度接近进料浓度
    // （真实二沉池应为进料的 2-4 倍）。记录为缺陷，见 docs/QUALITY-ROADMAP.md 第 15 节。
    const r = runSettlerToSteady(cfg, { flow: Q * 2, concentration: 3000 }, { flow: Q }, { maxDays: 40, dtDays: 1 / 1440 });
    expect(r.xUnderflow).toBeGreaterThan(2000);
  });

  it('顶层浓度低于底层（分层正确）', () => {
    const r = runSettlerToSteady(cfg, { flow: Q * 2, concentration: 3000 }, { flow: Q }, { maxDays: 40, dtDays: 1 / 1440 });
    expect(r.state.x[0]).toBeLessThan(r.state.x[r.state.x.length - 1]);
  });

  it('池面积翻倍改善出水水质', () => {
    const small = runSettlerToSteady(cfg, { flow: Q * 2, concentration: 4000 }, { flow: Q }, { maxDays: 40, dtDays: 1 / 1440 });
    const big = runSettlerToSteady(
      { ...cfg, area: 3000 },
      { flow: Q * 2, concentration: 4000 },
      { flow: Q },
      { maxDays: 40, dtDays: 1 / 1440 },
    );
    expect(big.xEffluent).toBeLessThan(small.xEffluent);
    expect(big.solidsLoading).toBeLessThan(small.solidsLoading);
  });

  it('回流比降低使回流浓度升高（浓缩更强）', () => {
    const high = runSettlerToSteady(cfg, { flow: Q * 2, concentration: 3000 }, { flow: Q }, { maxDays: 40, dtDays: 1 / 1440 });
    const low = runSettlerToSteady(cfg, { flow: Q * 1.5, concentration: 3000 }, { flow: Q * 0.5 }, { maxDays: 40, dtDays: 1 / 1440 });
    expect(low.xUnderflow).toBeGreaterThan(high.xUnderflow);
  });

  it('固体负荷单位正确（kg/(m²·h)）', () => {
    const r = runSettlerToSteady(cfg, { flow: Q * 2, concentration: 3000 }, { flow: Q }, { maxDays: 20, dtDays: 1 / 1440 });
    // 典型市政二沉池 3-6 kg/(m²·h)
    expect(r.solidsLoading).toBeGreaterThan(1);
    expect(r.solidsLoading).toBeLessThan(12);
  });

  it('稳态不产生负浓度或 NaN', () => {
    const r = runSettlerToSteady(cfg, { flow: Q * 2, concentration: 5000 }, { flow: Q }, { maxDays: 30, dtDays: 1 / 1440 });
    for (const v of r.state.x) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it('相同输入可复现', () => {
    const a = runSettlerToSteady(cfg, { flow: Q * 2, concentration: 3000 }, { flow: Q }, { maxDays: 20, dtDays: 1 / 1440 });
    const b = runSettlerToSteady(cfg, { flow: Q * 2, concentration: 3000 }, { flow: Q }, { maxDays: 20, dtDays: 1 / 1440 });
    expect(a.xEffluent).toBeCloseTo(b.xEffluent, 8);
  });
});

describe('Takács 质量守恒', () => {
  it('单一时间步内固体总量变化有界', () => {
    const state = createSettler(cfg, 3000);
    const before = state.x.reduce((a, v) => a + v, 0);
    const r = stepSettler(state, cfg, { flow: Q * 2, concentration: 3000 }, { flow: Q }, 1 / 1440);
    const after = r.state.x.reduce((a, v) => a + v, 0);
    // 一步之内不应发生数量级变化
    expect(after).toBeGreaterThan(before * 0.5);
    expect(after).toBeLessThan(before * 2);
  });

  it('长时间运行保持有界', () => {
    const state = createSettler(cfg, 3000);
    let cur = state;
    for (let i = 0; i < 500; i++) {
      cur = stepSettler(cur, cfg, { flow: Q * 2, concentration: 3000 }, { flow: Q }, 1 / 1440).state;
    }
    for (const v of cur.x) {
      expect(v).toBeLessThan(cfg.xMax);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('Takács 质量守恒（回归：曾因上边界通量写错导致出水 SS 翻倍）', () => {
  const cases = [
    { label: 'BSM1 标准', mlss: 3000, ras: 1.0 },
    { label: '低负荷', mlss: 2000, ras: 1.0 },
    { label: '高负荷', mlss: 5000, ras: 1.0 },
    { label: '低回流', mlss: 3000, ras: 0.4 },
  ];

  it('进出固体总量守恒（误差 < 3%）', () => {
    for (const c of cases) {
      const Qf = Q * (1 + c.ras);
      const Qu = Q * c.ras;
      const Qe = Qf - Qu;
      const r = runSettlerToSteady(cfg, { flow: Qf, concentration: c.mlss }, { flow: Qu }, { maxDays: 80, dtDays: 1 / 1440 });
      const inKg = (Qf * c.mlss) / 1000;
      const outKg = (Qe * r.xEffluent + Qu * r.xUnderflow) / 1000;
      const errPct = (Math.abs(inKg - outKg) / inKg) * 100;
      expect(errPct, `${c.label} 守恒误差 ${errPct.toFixed(2)}%`).toBeLessThan(3);
    }
  });

  it('回流污泥被浓缩（2–5 倍于进料）', () => {
    for (const c of cases) {
      const Qf = Q * (1 + c.ras);
      const Qu = Q * c.ras;
      const r = runSettlerToSteady(cfg, { flow: Qf, concentration: c.mlss }, { flow: Qu }, { maxDays: 80, dtDays: 1 / 1440 });
      const ratio = r.xUnderflow / c.mlss;
      expect(ratio, `${c.label} 浓缩比 ${ratio.toFixed(2)}`).toBeGreaterThan(1.8);
      expect(ratio).toBeLessThan(5);
    }
  });

  it('出水悬浮物在合理范围（< 20 g/m³）', () => {
    for (const c of cases) {
      const r = runSettlerToSteady(cfg, { flow: Q * (1 + c.ras), concentration: c.mlss }, { flow: Q * c.ras }, { maxDays: 80, dtDays: 1 / 1440 });
      expect(r.xEffluent, `${c.label} 出水 SS ${r.xEffluent.toFixed(1)}`).toBeLessThan(20);
    }
  });

  it('回流比越低，回流浓度越高', () => {
    const high = runSettlerToSteady(cfg, { flow: Q * 2, concentration: 3000 }, { flow: Q }, { maxDays: 60, dtDays: 1 / 1440 });
    const low = runSettlerToSteady(cfg, { flow: Q * 1.4, concentration: 3000 }, { flow: Q * 0.4 }, { maxDays: 60, dtDays: 1 / 1440 });
    expect(low.xUnderflow).toBeGreaterThan(high.xUnderflow);
  });
});

describe('压缩屈服项（保守性）', () => {
  it('加入压缩项后质量守恒仍成立', () => {
    const cases = [
      { mlss: 3000, ras: 1.0 },
      { mlss: 5000, ras: 1.0 },
      { mlss: 3000, ras: 0.4 },
    ];
    for (const c of cases) {
      const Qf = Q * (1 + c.ras);
      const Qu = Q * c.ras;
      const Qe = Qf - Qu;
      const r = runSettlerToSteady(cfg, { flow: Qf, concentration: c.mlss }, { flow: Qu }, { maxDays: 80, dtDays: 1 / 1440 });
      const inKg = (Qf * c.mlss) / 1000;
      const outKg = (Qe * r.xEffluent + Qu * r.xUnderflow) / 1000;
      expect(Math.abs(inKg - outKg) / inKg).toBeLessThan(0.05);
    }
  });

  it('压缩项不改变关键输出：出水 SS 与回流浓度仍在合理范围', () => {
    const r = runSettlerToSteady(cfg, { flow: Q * 2, concentration: 3000 }, { flow: Q }, { maxDays: 60, dtDays: 1 / 1440 });
    expect(r.xEffluent).toBeLessThan(20);
    expect(r.xUnderflow).toBeGreaterThan(2000);
    expect(r.xUnderflow).toBeLessThan(15000);
  });
});
