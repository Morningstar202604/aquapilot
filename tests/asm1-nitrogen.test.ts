import { describe, expect, it } from 'vitest';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import { createNetworkState, spinUpNetwork, stepNetwork } from '../src/sim/networkEngine';
import { LIMITS } from '../src/sim/config';

/**
 * ASM1 氮素与生物量的回归测试。
 *
 * 这一组锁住一个真实根因：污泥回流（RAS）若按未浓缩的池内浓度补给颗粒物，
 * 每个反应池的生物量都会被持续稀释，进而导致
 *   缺氧池断碳 → 反硝化失败 → 硝酸盐累积 → 出水 TN 超标
 * 三个看似独立的"工艺缺陷"，其实是同一个编码错误。
 */

function runAsm1(days = 20) {
  return spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 42, model: 'asm1' }), PLANT_TOPOLOGY, days);
}

describe('ASM1 氮素（生产路径）', () => {
  it('出水总氮达标', () => {
    const s = runAsm1(20);
    expect(s.effluent.tn, `TN ${s.effluent.tn.toFixed(2)}`).toBeLessThan(LIMITS.tn);
  });

  it('出水氨氮达标', () => {
    const s = runAsm1(20);
    expect(s.effluent.nh).toBeLessThan(LIMITS.nh);
  });

  it('缺氧池确实发生反硝化（硝酸盐被消耗）', () => {
    const s = runAsm1(20);
    const anoxic = s.reactors.find((r) => r.kind === 'anoxic')!;
    expect(anoxic.asm1!.S_NO).toBeLessThan(4);
  });

  it('自养菌维持在合理量级（不是 0，也不是数千）', () => {
    const s = runAsm1(20);
    const aerobic = s.reactors.find((r) => r.kind === 'aerobic')!;
    const xba = aerobic.asm1!.X_B_A;
    expect(xba).toBeGreaterThan(100);
    expect(xba).toBeLessThan(3000);
  });

  it('异养菌不衰减到零', () => {
    const s = runAsm1(20);
    for (const r of s.reactors) {
      if (!r.asm1) continue;
      expect(r.asm1.X_B_H, `${r.name} 异养菌 ${r.asm1.X_B_H.toFixed(1)}`).toBeGreaterThan(50);
    }
  });

  it('长期运行不漂移：第 15 天与第 25 天的生物量接近', () => {
    const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 42, model: 'asm1' }), PLANT_TOPOLOGY, 15);
    const at15 = s.reactors[0].asm1!.X_B_H;
    for (let m = 0; m < 10 * 1440; m++) stepNetwork(s, PLANT_TOPOLOGY, 1);
    const at25 = s.reactors[0].asm1!.X_B_H;
    const drift = Math.abs(at25 - at15) / Math.max(1, at15);
    expect(drift, `漂移 ${(drift * 100).toFixed(1)}%`).toBeLessThan(0.15);
  });

  it('多点进水（stepFeed）把碳源送入缺氧区', () => {
    const noFeed = createNetworkState(PLANT_TOPOLOGY, { seed: 42, model: 'asm1', controls: { stepFeed: 0 } });
    const withFeed = createNetworkState(PLANT_TOPOLOGY, { seed: 42, model: 'asm1', controls: { stepFeed: 0.3 } });
    const a = spinUpNetwork(noFeed, PLANT_TOPOLOGY, 15);
    const b = spinUpNetwork(withFeed, PLANT_TOPOLOGY, 15);
    const anoxicA = a.reactors.find((r) => r.kind === 'anoxic')!.asm1!.S_S;
    const anoxicB = b.reactors.find((r) => r.kind === 'anoxic')!.asm1!.S_S;
    expect(anoxicB).toBeGreaterThan(anoxicA);
  });
});
