import { describe, expect, it } from 'vitest';
import { KINETICS } from '../src/sim/kinetics';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import { createNetworkState, spinUpNetwork, stepNetwork, startNetworkScenario } from '../src/sim/networkEngine';
import { LIMITS } from '../src/sim/config';

/**
 * 氮账与反硝化回归。
 *
 * 真实缺陷：硝化产率被写成 0.88——每氧化 1 g 氨氮只生成 0.88 g 硝酸盐，
 * 0.12 g 氮凭空消失。全厂氮账系统性偏低，出水 TN 比物理上应有的值少
 * 约 12% 的硝化量，于是「TN 达标」可以是假的。
 *
 * 修正为 1.0 后必须同步把 kDen 从 4.6 调到 8.0（否则缺氧区来不及反硝化，
 * TN 反而被推到 15 以上）。这两个系数是一对，不能只改一个。
 */

const steady = (seed = 7) => spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed }), PLANT_TOPOLOGY, 30);

describe('硝化产率', () => {
  it('化学计量上必须为 1.0（氮原子不增不减）', () => {
    expect(KINETICS.nitrateYieldPerNitrifiedN).toBe(1);
  });

  it('反硝化速率已按 1.0 产率重标（kDen ≥ 6）', () => {
    expect(KINETICS.kDen).toBeGreaterThanOrEqual(6);
  });
});

describe('稳态氮账', () => {
  it('出水 TN = 氨氮 + 硝酸盐 + 少量有机氮，且与限值的关系可复核', () => {
    const s = steady();
    const last = s.reactors[s.reactors.length - 1];
    const tn = s.effluent.tn;
    const reconstructed = s.effluent.nh + last.no3;
    expect(tn).toBeGreaterThanOrEqual(reconstructed - 0.05);
    expect(tn - reconstructed).toBeLessThan(1);
  });

  it('全厂氮去除率落在市政厂常见区间 60–85%', () => {
    const s = steady();
    const nIn = (s.influent.flow * s.influent.tn) / 1000;
    const nOut = (s.effluent.flow * s.effluent.tn) / 1000;
    const removal = (1 - nOut / nIn) * 100;
    expect(removal).toBeGreaterThan(60);
    expect(removal).toBeLessThan(85);
  });

  it('默认控制下出水 TN 不超限（1.0 产率 + 重标 kDen 后）', () => {
    for (const seed of [7, 21, 42]) {
      const s = steady(seed);
      expect(s.effluent.tn, `seed ${seed}`).toBeLessThan(LIMITS.tn);
    }
  });
});

describe('反硝化对工况的响应', () => {
  it('停掉内回流后硝酸盐回流减少、TN 变差或持平（不会变好）', () => {
    const base = steady(11);
    const noIr = spinUpNetwork(
      createNetworkState(PLANT_TOPOLOGY, { seed: 11, controls: { internalRecirc: 0 } }),
      PLANT_TOPOLOGY,
      30,
    );
    expect(noIr.effluent.tn).toBeGreaterThanOrEqual(base.effluent.tn - 0.2);
  });

  it('鼓风机故障时氨氮上升（硝化受供氧限制）', () => {
    const s = steady();
    const before = s.effluent.nh;
    startNetworkScenario(s, 'blower_failure', { durationMin: 240 });
    for (let i = 0; i < 180; i++) stepNetwork(s, PLANT_TOPOLOGY, 1);
    expect(s.effluent.nh).toBeGreaterThan(before * 2);
  });

  it('长期运行不出现 NaN 或负值', () => {
    const s = steady(5);
    for (let i = 0; i < 2880; i++) stepNetwork(s, PLANT_TOPOLOGY, 1);
    expect(Number.isFinite(s.effluent.tn)).toBe(true);
    expect(s.effluent.tn).toBeGreaterThan(0);
    for (const r of s.reactors) expect(r.no3).toBeGreaterThanOrEqual(0);
  });
});

describe('两引擎的硝化产率必须一致', () => {
  it('旧参考引擎与新引擎都从 KINETICS 取产率，不各自写死', async () => {
    const fs = await import('node:fs');
    for (const file of ['src/sim/networkEngine.ts', 'src/sim/engine.ts']) {
      const src = fs.readFileSync(file, 'utf8');
      expect(src, `${file} 仍写死 0.88`).not.toMatch(/nOxidized \* 0\.88/);
      expect(src, `${file} 未使用共享常数`).toMatch(/nitrateYieldPerNitrifiedN/);
    }
  });

  it('KINETICS 里不再有第二份产率常数', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/sim/kinetics.ts', 'utf8');
    const hits = src.match(/nitrateYieldPerNitrifiedN/g) ?? [];
    // 一处定义 + 注释里的一处引用
    expect(hits.length).toBeLessThanOrEqual(2);
  });
});
