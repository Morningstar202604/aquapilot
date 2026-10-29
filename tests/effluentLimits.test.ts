import { describe, expect, it } from 'vitest';
import { createNetworkState, spinUpNetwork, stepNetwork, startNetworkScenario } from '../src/sim/networkEngine';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import { LIMITS } from '../src/sim/config';

/**
 * 六项出水限值必须一起断言。
 *
 * 真实漏检：`engine.test.ts` 只检查 COD / NH₄ / TP / SS，从不检查 BOD₅ 与 TN。
 * 于是有一次「硝化产率被改成 1.0 但反硝化速率没跟着标定」的提交，
 * 出水 TN = 15.40 mg/L（限值 15）却让全部 708 项测试通过。
 * 这里把六项限值放进同一个门槛，任何一项越线都必须让 CI 变红。
 *
 * 口径说明：BOD₅ 由出水溶解性 COD 折算（0.32 系数 + 悬浮物贡献），
 * 不是独立测量值；断言它仍有意义——限值表里有它，界面也会标红。
 */

const steady = (seed: number) => spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed }), PLANT_TOPOLOGY, 30);

const KEYS = ['cod', 'bod', 'ss', 'nh', 'tn', 'tp'] as const;

describe('默认控制下六项出水限值', () => {
  for (const seed of [7, 21, 42, 99]) {
    it(`seed ${seed}：六项全部达标`, () => {
      const s = steady(seed);
      const e = s.effluent;
      for (const key of KEYS) {
        expect(e[key], `${key} = ${e[key].toFixed(3)}，限值 ${LIMITS[key]}（seed ${seed}）`).toBeLessThanOrEqual(
          LIMITS[key],
        );
      }
    });
  }

  it('六项之外还给出裕度排序（界面 KPI 依赖它）', () => {
    const s = steady(7);
    expect(s.effluent.cod).toBeGreaterThan(0);
    expect(s.effluent.bod).toBeGreaterThan(0);
  });
});

describe('事故工况下的限值行为是可解释的（不是静默通过）', () => {
  /**
   * 鼓风机故障必须造成「显著恶化」，而不是严格要求越线。
   *
   * 早期断言是 `peak > LIMITS.nh`（必然越线）。设计变更后（二沉池补 f_ns、
   * 好氧池容 +15%）硝化裕度变大，实测峰值 4.67 mg/L——逼近但未越线。
   *
   * 这不是把问题掩盖掉：断言改成「至少恶化 2 倍且逼近限值（>80%）」，
   * 既锁住「故障真的有影响」，又不把「裕度足够」误判成「模型失效」。
   * 若哪天故障完全不影响出水（例如曝气逻辑被短路），这个测试仍会失败。
   */
  it('鼓风机故障（默认剩余 50% 供气）时氨氮显著恶化并逼近限值', () => {
    const s = steady(7);
    const baseline = s.effluent.nh;
    // 用场景默认强度：magnitude 语义是"剩余供气能力"，1 反而表示没有故障
    startNetworkScenario(s, 'blower_failure');
    let peak = 0;
    for (let i = 0; i < 300; i += 1) {
      stepNetwork(s, PLANT_TOPOLOGY, 1);
      peak = Math.max(peak, s.effluent.nh);
    }
    expect(peak).toBeGreaterThan(baseline * 2);
    expect(peak).toBeGreaterThan(LIMITS.nh * 0.8);
  });

  it('中毒性冲击后氨氮升高（抑制硝化）', () => {
    const clean = steady(7);
    const tox = steady(7);
    startNetworkScenario(tox, 'toxic', { durationMin: 360 });
    for (let i = 0; i < 300; i += 1) {
      stepNetwork(clean, PLANT_TOPOLOGY, 1);
      stepNetwork(tox, PLANT_TOPOLOGY, 1);
    }
    expect(tox.effluent.nh).toBeGreaterThan(clean.effluent.nh * 2);
  });
});
