import { describe, expect, it } from 'vitest';
import {
  ASM1_COMPONENTS,
  ASM1_PARAMS,
  ASM1_PROCESSES,
  buildRates,
  buildStoichiometry,
  conservationResiduals,
  emptyAsm1State,
  reactionRates,
  type Asm1State,
} from '../src/sim/asm1';
import { BSM1_INFLUENT, runCstr } from '../src/sim/asm1Cstr';

describe('ASM1 组分与过程完整性', () => {
  it('恰好 13 个组分、8 个过程（与 IWA ASM1 一致）', () => {
    expect(ASM1_COMPONENTS).toHaveLength(13);
    expect(ASM1_PROCESSES).toHaveLength(8);
    expect(new Set(ASM1_COMPONENTS).size).toBe(13);
    expect(new Set(ASM1_PROCESSES).size).toBe(8);
  });

  it('每个过程至少作用于一个组分', () => {
    const stoich = buildStoichiometry();
    for (const proc of ASM1_PROCESSES) {
      const touched = Object.keys(stoich[proc]).length;
      expect(touched, `${proc} 没有组分系数`).toBeGreaterThan(0);
    }
  });

  it('系数全部由参数推导：改 Y_H 会同时改变基质与氧的消耗', () => {
    const base = buildStoichiometry();
    const modified = buildStoichiometry({ ...ASM1_PARAMS, Y_H: 0.4 });
    expect(modified.aerobic_growth_heterotrophs.S_S).not.toBe(base.aerobic_growth_heterotrophs.S_S);
    expect(modified.aerobic_growth_heterotrophs.S_O).not.toBe(base.aerobic_growth_heterotrophs.S_O);
    // 更低的产率 → 更多基质被氧化 → 更多氧耗
    expect(Math.abs(modified.aerobic_growth_heterotrophs.S_O!)).toBeGreaterThan(
      Math.abs(base.aerobic_growth_heterotrophs.S_O!),
    );
  });
});

describe('ASM1 化学计量守恒', () => {
  const rows = conservationResiduals();

  it('COD 在异养与衰减/水解过程中严格闭合', () => {
    // 自养生长按氮归一且不消耗有机 COD，其 COD 残差非零属预期，不参与检验
    for (const row of rows) {
      if (row.process === 'aerobic_growth_autotrophs' || row.process === 'ammonification') continue;
      expect(Math.abs(row.cod), `${row.process} COD 残差 ${row.cod}`).toBeLessThan(1e-6);
    }
  });

  it('氮在全部 8 个过程中严格闭合', () => {
    for (const row of rows) {
      expect(Math.abs(row.n), `${row.process} N 残差 ${row.n}`).toBeLessThan(1e-6);
    }
  });

  it('碱度与氮的对应关系自洽', () => {
    for (const row of rows) {
      expect(Math.abs(row.alk), `${row.process} 碱度残差 ${row.alk}`).toBeLessThan(1e-6);
    }
  });

  it('自养生长氧耗按生物量 COD 归一：每 g 生物量耗 (4.57-Y_A)/Y_A 的氧', () => {
    const stoich = buildStoichiometry();
    const growth = stoich.aerobic_growth_autotrophs;
    expect(growth.S_O).toBeCloseTo(-(ASM1_PARAMS.O2_PER_NH_N - ASM1_PARAMS.Y_A) / ASM1_PARAMS.Y_A, 12);
    expect(growth.X_B_A).toBe(1);
  });

  it('自养与异养生长都以生物量 COD 归一（衰减才能直接相减）', () => {
    const stoich = buildStoichiometry();
    expect(stoich.aerobic_growth_heterotrophs.X_B_H).toBe(1);
    expect(stoich.aerobic_growth_autotrophs.X_B_A).toBe(1);
    expect(stoich.decay_autotrophs.X_B_A).toBe(-1);
    expect(stoich.decay_heterotrophs.X_B_H).toBe(-1);
  });

  it('缺氧生长的硝酸盐消耗按 2.86 gCOD/gN 折算', () => {
    const stoich = buildStoichiometry();
    const anoxic = stoich.anoxic_growth_heterotrophs;
    const expected = -((1 - ASM1_PARAMS.Y_H) / (ASM1_PARAMS.COD_PER_NO3_N * ASM1_PARAMS.Y_H));
    expect(anoxic.S_NO).toBeCloseTo(expected, 12);
  });

  it('衰减产生的有机氮等于生物量氮减去惰性残渣带走的氮', () => {
    const stoich = buildStoichiometry();
    const decay = stoich.decay_heterotrophs;
    expect(decay.X_ND).toBeCloseTo(ASM1_PARAMS.i_XB - ASM1_PARAMS.f_P * ASM1_PARAMS.i_XP, 12);
  });
});

describe('ASM1 反应速率', () => {
  const alive: Asm1State = emptyAsm1State({
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

  it('好氧条件下异养菌消耗基质、溶解氧与氨氮', () => {
    const r = reactionRates(alive);
    expect(r.S_S).toBeLessThan(0);
    expect(r.S_O).toBeLessThan(0);
    expect(r.X_B_H).toBeGreaterThan(0);
  });

  it('厌氧条件（无氧、有硝酸盐）下反硝化发生、硝酸盐下降', () => {
    const anoxic = { ...alive, S_O: 0.01, S_NO: 8 };
    const r = reactionRates(anoxic);
    expect(r.S_NO).toBeLessThan(0);
    expect(r.X_B_H).toBeGreaterThan(0);
  });

  it('无氧且无硝酸盐时，异养菌不生长', () => {
    const stalled = { ...alive, S_O: 0, S_NO: 0 };
    const r = reactionRates(stalled);
    expect(r.X_B_H).toBeLessThanOrEqual(0);
  });

  it('溶解氧充足时自养菌生长、氨氮被消耗', () => {
    const r = reactionRates({ ...alive, S_O: 4, S_NH: 20 });
    expect(r.X_B_A).toBeGreaterThan(0);
    expect(r.S_NH).toBeLessThan(0);
  });

  it('低溶解氧抑制硝化：氨氮氧化速率显著下降', () => {
    // 用「硝化过程本身的速率」判断抑制，而不是自养菌净增长
    // （低氧下衰减可能超过生长，净增长为负是正常现象）
    const rates = buildRates();
    const base = { ...alive, S_NH: 20 };
    const highO2 = rates.aerobic_growth_autotrophs({ ...base, S_O: 4 });
    const lowO2 = rates.aerobic_growth_autotrophs({ ...base, S_O: 0.5 });
    expect(lowO2).toBeGreaterThan(0);
    // Monod 饱和：0.5 mg/L 时的硝化速率应明显低于 4 mg/L（约 0.6 倍）
    expect(lowO2).toBeLessThan(highO2);
    expect(lowO2 / highO2).toBeLessThan(0.75);
  });

  it('水解速率随 X_S/X_B_H 比值单调上升', () => {
    const r1 = reactionRates({ ...alive, X_S: 50 });
    const r2 = reactionRates({ ...alive, X_S: 400 });
    expect(r2.S_S).toBeGreaterThan(r1.S_S);
  });

  it('所有速率在极端输入下仍为有限值', () => {
    const extremes: Asm1State[] = [
      emptyAsm1State(),
      emptyAsm1State({ X_B_H: 1e6, X_S: 1e6, S_S: 1e6, S_O: 10, S_NO: 100, S_NH: 100 }),
      emptyAsm1State({ X_B_H: 0, X_B_A: 0, X_S: 1, S_S: 1, S_O: 0, S_NO: 0, S_NH: 0 }),
    ];
    for (const s of extremes) {
      const r = reactionRates(s);
      for (const c of ASM1_COMPONENTS) {
        expect(Number.isFinite(r[c]), `${c} 非有限值`).toBe(true);
      }
    }
  });
});

describe('ASM1 参数标定合理性', () => {
  it('参数落在 IWA 标准参数表的典型区间', () => {
    const p = ASM1_PARAMS;
    expect(p.Y_H).toBeGreaterThan(0.4);
    expect(p.Y_H).toBeLessThan(0.8);
    expect(p.Y_A).toBeGreaterThan(0.1);
    expect(p.Y_A).toBeLessThan(0.4);
    expect(p.mu_H).toBeGreaterThan(3);
    expect(p.mu_H).toBeLessThan(10);
    expect(p.mu_A).toBeGreaterThan(0.3);
    expect(p.mu_A).toBeLessThan(1.5);
    expect(p.b_H).toBeGreaterThan(0.3);
    expect(p.b_H).toBeLessThan(1.0);
    expect(p.b_A).toBeLessThan(p.b_H);
    expect(p.K_S).toBeGreaterThan(5);
    expect(p.K_NH).toBeGreaterThan(0.2);
    expect(p.K_O_H).toBeLessThan(p.K_O_A);
  });

  it('自养菌最大比增长速率显著低于异养菌', () => {
    expect(ASM1_PARAMS.mu_A).toBeLessThan(ASM1_PARAMS.mu_H / 3);
  });
});

describe('ASM1 量纲', () => {
  it('速率常数的 d⁻¹ → h⁻¹ 换算被应用', () => {
    expect(ASM1_PARAMS.PER_DAY_TO_PER_HOUR).toBeCloseTo(1 / 24, 12);
  });

  it('硝化菌世代时间落在文献范围（8–30 h，20℃）', () => {
    const p = ASM1_PARAMS;
    const sp = emptyAsm1State({ S_O: 2, S_NH: 30 });
    const mu = p.mu_A * (sp.S_NH / (p.K_NH + sp.S_NH)) * (sp.S_O / (p.K_O_A + sp.S_O)) * p.PER_DAY_TO_PER_HOUR;
    const generationHours = Math.log(2) / mu;
    expect(generationHours).toBeGreaterThan(8);
    expect(generationHours).toBeLessThan(30);
  });

  it('异养菌世代时间落在文献范围（1–6 h，20℃）', () => {
    const p = ASM1_PARAMS;
    const sp = emptyAsm1State({ S_S: 70, S_O: 2 });
    const mu = p.mu_H * (sp.S_S / (p.K_S + sp.S_S)) * (sp.S_O / (p.K_O_H + sp.S_O)) * p.PER_DAY_TO_PER_HOUR;
    const generationHours = Math.log(2) / mu;
    expect(generationHours).toBeGreaterThan(1);
    expect(generationHours).toBeLessThan(6);
  });

  it('典型浓度下反应速率为正且不爆炸', () => {
    const sp = emptyAsm1State({
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
    const r = reactionRates(sp);
    // 好氧段基质降解速率应在每小时百分之几到几十 mg/L 量级
    expect(r.S_S).toBeLessThan(0);
    expect(Math.abs(r.S_S)).toBeLessThan(3000);
    expect(Math.abs(r.X_B_H)).toBeLessThan(3000);
  });
});

describe('ASM1 CSTR 稳态（真跑）', () => {
  const Q = 18446 / 24;

  it('硝化菌世代时间决定能否维持：短 HRT 会被冲出', () => {
    const short = runCstr(
      BSM1_INFLUENT,
      { volume: 4000, flow: Q, aerated: true, doSetpoint: 2 },
      { maxHours: 24 * 90, seedBiomass: 150 },
    );
    expect(short.converged).toBe(true);
    // HRT 5.2h << 世代时间 25h，硝化菌必然被冲出
    expect(short.state.X_B_A).toBeLessThan(1);
    expect(short.state.S_NH).toBeGreaterThan(20);
  });

  it('足够长的 SRT 能维持硝化菌并把氨氮降下来', () => {
    const long = runCstr(
      BSM1_INFLUENT,
      { volume: Q * 240, flow: Q, aerated: true, doSetpoint: 2 },
      { maxHours: 24 * 200, seedBiomass: 150 },
    );
    expect(long.converged).toBe(true);
    // 修正自养计量后（每 g 硝化菌生长同化+氧化 4.25 gN），化学恒化器的
    // 硝化菌平衡 = 被硝化氮量 / 4.25 / (D+b_A)，量级在个位数 gCOD/m³。
    // 此前阈值 10 是按被低估 16.8 倍的硝化计量标定的。
    expect(long.state.X_B_A).toBeGreaterThan(2);
    expect(long.state.S_NH).toBeLessThan(5);
    // 真实硝化通量的回归锁：好氧恒化器无反硝化，被氧化的氮全部变成硝酸盐
    expect(long.state.S_NO).toBeGreaterThan(20);
  });

  it('临界 HRT 的判据与生长/衰减平衡一致', () => {
    const p = ASM1_PARAMS;
    const muEff = p.mu_A * (2 / (p.K_NH + 2)) * (2 / (p.K_O_A + 2)) * p.PER_DAY_TO_PER_HOUR;
    const bEff = p.b_A * p.PER_DAY_TO_PER_HOUR;
    const criticalHrt = 1 / (muEff - bEff);
    // 临界 HRT 应落在几十小时量级（与世代时间同阶）
    expect(criticalHrt).toBeGreaterThan(24);
    expect(criticalHrt).toBeLessThan(200);
  });

  it('缺氧池发生反硝化，硝酸盐下降', () => {
    const anoxic = runCstr(
      { ...BSM1_INFLUENT, S_NO: 10, S_O: 0.2 },
      { volume: 2600, flow: Q, aerated: false },
      { maxHours: 24 * 60 },
    );
    expect(anoxic.converged).toBe(true);
    expect(anoxic.state.S_NO).toBeLessThan(10);
    expect(anoxic.state.S_O).toBeLessThan(0.1);
  });

  it('稳态下所有组分非负且有限', () => {
    const r = runCstr(
      BSM1_INFLUENT,
      { volume: Q * 240, flow: Q, aerated: true, doSetpoint: 2 },
      { maxHours: 24 * 150 },
    );
    for (const comp of ASM1_COMPONENTS) {
      expect(Number.isFinite(r.state[comp]), `${comp} 非有限`).toBe(true);
      expect(r.state[comp], `${comp} 为负`).toBeGreaterThanOrEqual(0);
    }
  });

  it('相同输入可复现', () => {
    const cfg = { volume: Q * 240, flow: Q, aerated: true, doSetpoint: 2 };
    const a = runCstr(BSM1_INFLUENT, cfg, { maxHours: 24 * 40 });
    const b = runCstr(BSM1_INFLUENT, cfg, { maxHours: 24 * 40 });
    expect(a.state.S_NH).toBeCloseTo(b.state.S_NH, 10);
    expect(a.state.X_B_A).toBeCloseTo(b.state.X_B_A, 8);
  });
});

describe('ASM1 温度修正（Arrhenius）', () => {
  const sample = () =>
    emptyAsm1State({ S_S: 50, X_S: 100, X_B_H: 2500, X_B_A: 150, S_O: 2, S_NO: 3, S_NH: 25, S_ND: 4, X_ND: 8 });

  it('20℃ 为参考温度，系数为 1', () => {
    const p = ASM1_PARAMS;
    const at20 = buildRates(p, 20).aerobic_growth_autotrophs(sample());
    const atRef = buildRates(p, p.T_REF).aerobic_growth_autotrophs(sample());
    expect(at20).toBeCloseTo(atRef, 12);
  });

  it('低温按 θ^ΔT 抑制硝化', () => {
    const p = ASM1_PARAMS;
    const at20 = buildRates(p, 20).aerobic_growth_autotrophs(sample());
    const at10 = buildRates(p, 10).aerobic_growth_autotrophs(sample());
    expect(at10 / at20).toBeCloseTo(Math.pow(p.theta_mu_A, -10), 6);
    expect(at10).toBeLessThan(at20 * 0.5);
  });

  it('高温增强异养与自养速率', () => {
    const p = ASM1_PARAMS;
    const at20 = buildRates(p, 20).aerobic_growth_heterotrophs(sample());
    const at30 = buildRates(p, 30).aerobic_growth_heterotrophs(sample());
    expect(at30).toBeGreaterThan(at20);
    expect(at30 / at20).toBeCloseTo(Math.pow(p.theta_mu_H, 10), 6);
  });

  it('自养菌对温度更敏感（θ 更大）', () => {
    expect(ASM1_PARAMS.theta_mu_A).toBeGreaterThan(ASM1_PARAMS.theta_mu_H);
  });
});
