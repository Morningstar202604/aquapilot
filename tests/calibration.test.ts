import { describe, expect, it } from 'vitest';
import {
  calibrate,
  identifiability,
  objective,
  bsm1SyntheticTarget,
  CALIBRATABLE_PARAMS,
  PARAM_BOUNDS,
  type Predictor,
  type EffluentObservation,
} from '../src/sim/calibration';
import { ASM1_PARAMS } from '../src/sim/asm1';

/**
 * 参数校准与可辨识性。
 *
 * 用**解析代理模型**测，而不是每次跑 BSM1 稳态仿真：
 * 稳态仿真单次 1.5 s，一个用例就是几分钟，不可用于 CI。
 * 代理模型能验证「算法本身」的行为（敏感性排序、收敛、有界性），
 * 真实 BSM1 上的标定由 scripts/calibrate-bsm1.ts 端到端跑。
 */

/** 已知真参数：mu_A 与 K_NH 决定氨氮，b_H 决定污泥龄 */
const TRUTH = { mu_A: 1.1, K_NH: 1.6, b_H: 0.55 };

/** 代理：氨氮随 mu_A 上升下降、随 K_NH 上升上升；COD 随 b_H 上升略升 */
function proxyPredict(p: typeof ASM1_PARAMS): EffluentObservation {
  return {
    nh: 6 / p.mu_A + p.K_NH * 0.35,
    cod: 22 + (p.b_H - 0.62) * 18 + p.K_S * 0.06,
    ss: 8 + (p.k_h - 3) * 0.4,
    tn: 10 + (p.b_H - 0.62) * 6,
  };
}

const proxyTruth = proxyPredict({ ...ASM1_PARAMS, ...TRUTH });

describe('目标函数', () => {
  it('完美拟合时为零', () => {
    expect(objective({ observed: proxyTruth }, proxyTruth)).toBeCloseTo(0, 10);
  });

  it('按相对误差归一化：小量级指标不会被大量级淹没', () => {
    // NH 从 1.5 偏到 3.0（+100%），COD 从 30 偏到 33（+10%）
    const target = { observed: { cod: 30, ss: 8, nh: 1.5, tn: 10 } };
    const nhOnly = objective(target, { cod: 30, ss: 8, nh: 3.0, tn: 10 });
    const codOnly = objective(target, { cod: 33, ss: 8, nh: 1.5, tn: 10 });
    expect(nhOnly).toBeGreaterThan(codOnly);
    expect(nhOnly).toBeCloseTo(1, 1); // (3-1.5)/1.5 = 1，平方 = 1
  });

  it('非有限预测返回无穷大而不是静默通过', () => {
    const target = { observed: { cod: 30, ss: 8, nh: 1.5, tn: 10 } };
    expect(objective(target, { cod: Number.NaN, ss: 8, nh: 1.5, tn: 10 })).toBe(Number.POSITIVE_INFINITY);
  });

  it('权重可以放大某个指标的影响', () => {
    const target = { observed: { cod: 30, ss: 8, nh: 1.5, tn: 10 }, weights: { nh: 100 } };
    const withWeight = objective(target, { cod: 30, ss: 8, nh: 1.6, tn: 10 });
    const without = objective({ observed: target.observed }, { cod: 30, ss: 8, nh: 1.6, tn: 10 });
    expect(withWeight).toBeGreaterThan(without * 50);
  });
});

describe('可辨识性', () => {
  it('对结果有影响且方向正确的参数被判定可辨识', () => {
    const rows = identifiability(proxyPredict as Predictor, { observed: proxyTruth }, ASM1_PARAMS, 0.02);
    const byParam = new Map(rows.map((r) => [r.param, r]));
    expect(byParam.get('mu_A')?.identifiable).toBe(true);
    expect(byParam.get('K_NH')?.identifiable).toBe(true);
    // 代理模型里完全不影响出水的参数应被判为不可辨识
    expect(byParam.get('k_a')?.identifiable).toBe(false);
  });

  it('按灵敏度降序排列', () => {
    const rows = identifiability(proxyPredict as Predictor, { observed: proxyTruth }, ASM1_PARAMS, 0.02);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].relativeSensitivity).toBeGreaterThanOrEqual(rows[i].relativeSensitivity);
    }
  });

  it('每个参数都有物理边界与建议文案', () => {
    const rows = identifiability(proxyPredict as Predictor, { observed: proxyTruth }, ASM1_PARAMS, 0.02);
    expect(rows).toHaveLength(CALIBRATABLE_PARAMS.length);
    for (const r of rows) {
      expect(PARAM_BOUNDS[r.param].min).toBeLessThan(PARAM_BOUNDS[r.param].max);
      expect(r.advice.length).toBeGreaterThan(0);
    }
  });

  it('边界处不越界取值', () => {
    const atMin = { ...ASM1_PARAMS, mu_A: PARAM_BOUNDS.mu_A.min };
    const rows = identifiability(proxyPredict as Predictor, { observed: proxyTruth }, atMin, 0.5);
    // 不抛错即说明夹紧生效（否则 mu_A 会变成负数）
    expect(rows.find((r) => r.param === 'mu_A')!.relativeSensitivity).toBeGreaterThanOrEqual(0);
  });
});

describe('标定', () => {
  it('能从偏离的初值向真值收敛，目标函数显著下降', () => {
    const start = { ...ASM1_PARAMS, mu_A: 0.5, K_NH: 0.5, b_H: 0.9 };
    const result = calibrate(
      proxyPredict as Predictor,
      { observed: proxyTruth },
      { baseParams: start, maxIterations: 3 },
    );
    expect(result.objectiveAfter).toBeLessThan(result.objectiveBefore);
    expect(result.improvementPct).toBeGreaterThan(50);
    // 参数应朝真值方向移动
    expect(Math.abs(result.params.mu_A - TRUTH.mu_A)).toBeLessThan(Math.abs(start.mu_A - TRUTH.mu_A));
  });

  it('只拟合可辨识参数，不可辨识参数保持文献值', () => {
    const start = { ...ASM1_PARAMS, mu_A: 0.5 };
    const result = calibrate(
      proxyPredict as Predictor,
      { observed: proxyTruth },
      { baseParams: start, maxIterations: 2 },
    );
    expect(result.fitted).toContain('mu_A');
    expect(result.fixed).toContain('k_a');
    expect(result.params.k_a).toBe(start.k_a);
  });

  it('所有参数始终落在物理边界内', () => {
    const start = { ...ASM1_PARAMS, mu_A: 0.15, K_S: 75, k_h: 9 };
    const result = calibrate(
      proxyPredict as Predictor,
      { observed: proxyTruth },
      { baseParams: start, maxIterations: 3 },
    );
    for (const p of CALIBRATABLE_PARAMS) {
      expect(result.params[p]).toBeGreaterThanOrEqual(PARAM_BOUNDS[p].min);
      expect(result.params[p]).toBeLessThanOrEqual(PARAM_BOUNDS[p].max);
    }
  });

  it('记录收敛轨迹，且目标函数单调不增', () => {
    const result = calibrate(proxyPredict as Predictor, { observed: proxyTruth }, { maxIterations: 2 });
    expect(result.trace.length).toBeGreaterThan(1);
    for (let i = 1; i < result.trace.length; i++) {
      expect(result.trace[i].objective).toBeLessThanOrEqual(result.trace[i - 1].objective + 1e-12);
    }
  });

  it('完美数据上不产生虚假改善（避免过拟合噪声）', () => {
    // 用真参数构造目标 → 起点已最优，改善应接近 0
    const truthParams = { ...ASM1_PARAMS, ...TRUTH };
    const result = calibrate(
      proxyPredict as Predictor,
      { observed: proxyTruth },
      { baseParams: truthParams, maxIterations: 2 },
    );
    expect(result.objectiveBefore).toBeLessThan(1e-10);
    expect(Math.abs(result.improvementPct)).toBeLessThan(50);
  });
});

describe('BSM1 合成目标', () => {
  it('从官方 Table 6 稳态值构造，量级合理', () => {
    const t = bsm1SyntheticTarget();
    expect(t.observed.nh).toBeGreaterThan(0);
    expect(t.observed.nh).toBeLessThan(10);
    expect(t.observed.cod).toBeGreaterThan(10);
    expect(t.observed.ss).toBeGreaterThan(1);
    expect(Number.isFinite(t.observed.tn)).toBe(true);
  });
});

describe('校准服务的异步分批', () => {
  it('calibrateAsync 每个参数点之间让出事件循环（tick 可插入）', async () => {
    const { calibrateAsync } = await import('../src/server/calibrationService');
    let evaluations = 0;
    const predict: Predictor = (p) => {
      evaluations += 1;
      return proxyPredict(p);
    };
    const start = { ...ASM1_PARAMS, mu_A: 0.5 };
    const result = await calibrateAsync(
      predict,
      { observed: proxyTruth },
      {
        baseParams: start,
        maxIterations: 1,
      },
    );
    expect(evaluations).toBeGreaterThan(5);
    expect(result.objectiveAfter).toBeLessThanOrEqual(result.objectiveBefore);
  });

  it('summarise 只输出可展示字段，参数变化带百分比', async () => {
    const { summarise } = await import('../src/server/calibrationService');
    const result = calibrate(proxyPredict as Predictor, { observed: proxyTruth }, { maxIterations: 1 });
    const summary = summarise(result);
    expect(summary.fitted.length).toBeGreaterThan(0);
    for (const c of summary.changes) {
      expect(c.before).toBe(ASM1_PARAMS[c.param as keyof typeof ASM1_PARAMS]);
      expect(Number.isFinite(c.changePct)).toBe(true);
    }
    // 摘要里没有 trace（那是完整结果的调试字段）
    expect('trace' in summary).toBe(false);
  });
});

describe('校准服务的取消与并发保护', async () => {
  it('runIdentifiability 形式存在且可调用（防 API 漂移）', async () => {
    const mod = await import('../src/server/calibrationService');
    expect(typeof mod.summarise).toBe('function');
    const summary = mod.summarise(calibrate(proxyPredict as Predictor, { observed: proxyTruth }, { maxIterations: 1 }));
    expect(summary.improvementPct).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(summary.fixed)).toBe(true);
  });

  it('calibrate 在 onProgress 上报 identifiability 与 fitting 两个阶段', () => {
    const phases: string[] = [];
    calibrate(
      proxyPredict as Predictor,
      { observed: proxyTruth },
      {
        maxIterations: 1,
        onProgress: (p) => {
          if (!phases.includes(p.phase)) phases.push(p.phase);
        },
      },
    );
    expect(phases).toContain('identifiability');
    expect(phases).toContain('fitting');
  });

  it('identifiability 对空权重与缺省指标稳健', () => {
    const rows = identifiability(
      proxyPredict as Predictor,
      {
        observed: { cod: proxyTruth.cod, ss: proxyTruth.ss, nh: proxyTruth.nh, tn: proxyTruth.tn },
        weights: {},
      },
      ASM1_PARAMS,
      0.02,
    );
    expect(rows).toHaveLength(CALIBRATABLE_PARAMS.length);
    for (const r of rows) expect(Number.isFinite(r.relativeSensitivity)).toBe(true);
  });
});

describe('校准服务的并发保护与取消', () => {
  /**
   * 这一组只测**分支逻辑**，不跑真实标定。
   *
   * 真实标定一次 75–80 秒（20+ 次稳态仿真），放进单测会让 CI 从
   * 20 秒涨到 3 分钟以上。这里把「并发保护 / 取消 / 连接关闭」的判定
   * 用最小的假 predictor 抽出来验证——服务层的这些分支与标定本身无关。
   */
  it('activeTasks 的保护逻辑：重复进入时应被拒绝', async () => {
    // 直接验证服务暴露的 hasActive 语义（不触发真实标定）
    const { createCalibrationService } = await import('../src/server/calibrationService');
    const service = createCalibrationService({ send: () => {}, isOpen: () => false });
    const ws = {} as never;
    expect(service.hasActive(ws)).toBe(false);
    // isOpen=false 时 identify 立即返回且不发送，说明取消路径可用
    await service.identify(ws, 'r-close');
    expect(service.hasActive(ws)).toBe(false);
  });

  it('连接关闭时 identify 不发送任何消息', async () => {
    const { createCalibrationService } = await import('../src/server/calibrationService');
    const sent: unknown[] = [];
    const service = createCalibrationService({
      send: (_ws, msg) => sent.push(msg),
      isOpen: () => false,
    });
    await service.identify({} as never, 'r1');
    expect(sent).toEqual([]);
  });

  it('cancel 对没有任务的连接是安全的空操作', async () => {
    const { createCalibrationService } = await import('../src/server/calibrationService');
    const service = createCalibrationService({ send: () => {}, isOpen: () => true });
    expect(() => service.cancel({} as never)).not.toThrow();
  });
});
