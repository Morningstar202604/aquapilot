import { describe, expect, it } from 'vitest';
import { createNetworkState, networkModel, spinUpNetwork } from '../src/sim/networkEngine';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import { SCENARIOS, type ScenarioSpec } from '../src/sim/scenarios';
import { aerationCapacityOf, scenarioEnvelope } from '../src/sim/forcing';

/**
 * 事故推演（what-if）必须真的模拟该事故。
 *
 * 真实缺陷：预测克隆把 `magnitude` 写死成 1。
 * - `blower_failure.magnitude` 的语义是「剩余供气能力」，1 = 没有故障，
 *   于是「如果鼓风机坏了会怎样」的推演结果与基线逐位相同；
 * - `winter.magnitude` 是目标水温 ℃，写 1 会被夹到 8 ℃，比默认的 12 ℃ 更离谱；
 * - `power_outage` 默认只持续 45 min，而推演窗口 240 min，最后一个采样点
 *   已经恢复，看起来像"停电没事"。
 *
 * 这里锁三件事：故障类推演必须与基线显著不同、冬季必须落到目标水温、
 * 推演窗口内的场景必须持续覆盖整个窗口。
 */

const steady = () => spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 7 }), PLANT_TOPOLOGY, 30);
const model = (s: ReturnType<typeof steady>) => networkModel(PLANT_TOPOLOGY, s);

describe('aerationCapacityOf 的边界', () => {
  const blower = (magnitude: number) =>
    aerationCapacityOf(
      { type: 'blower_failure', durationMin: 600, magnitude, startedAt: 0 } satisfies ScenarioSpec,
      300,
    );

  it('magnitude 是「剩余能力」：0.5 降到一半，1 表示没有故障', () => {
    expect(blower(0.5)).toBeCloseTo(0.5, 5);
    expect(blower(1)).toBeCloseTo(1, 5);
    expect(blower(0)).toBeCloseTo(0, 5);
  });

  it('超出 0–1 的输入被夹紧，不会把供氧放大到 3000%', () => {
    expect(blower(30)).toBeLessThanOrEqual(1);
    expect(blower(-5)).toBeGreaterThanOrEqual(0);
    expect(blower(Number.NaN)).toBeGreaterThanOrEqual(0);
  });

  it('包络为 0 时恢复到 1（故障结束）', () => {
    const spec: ScenarioSpec = { type: 'blower_failure', durationMin: 120, magnitude: 0.5, startedAt: 0 };
    expect(aerationCapacityOf(spec, 0)).toBeCloseTo(1, 5);
    expect(aerationCapacityOf(spec, 180)).toBeCloseTo(1, 5);
  });
});

describe('what-if 推演', () => {
  it('鼓风机故障推演的氨氮明显高于基线', () => {
    const s = steady();
    const m = model(s);
    const base = m.predict(s.controls, 240, 60);
    const failed = m.predictWithScenario(s.controls, 240, 60, 'blower_failure');
    const baseNh = base.points[base.points.length - 1].effluent.nh;
    const failNh = failed.points[failed.points.length - 1].effluent.nh;
    expect(failNh).toBeGreaterThan(baseNh * 2);
    // 故障期间溶解氧必须掉下来
    expect(failed.points[failed.points.length - 1].doLevel).toBeLessThan(1);
  });

  it('停电推演的溶解氧趋近于零', () => {
    const s = steady();
    const fc = model(s).predictWithScenario(s.controls, 120, 60, 'power_outage');
    expect(fc.points[fc.points.length - 1].doLevel).toBeLessThan(0.2);
  });

  it('冬季推演落到场景目标水温（默认 12 ℃），而不是被夹到 8 ℃', () => {
    const s = steady();
    const fc = model(s).predictWithScenario(s.controls, 240, 60, 'winter');
    const t = fc.points[fc.points.length - 1].effluent.temperature;
    expect(t).toBeGreaterThan(10);
    expect(t).toBeLessThan(14);
  });

  it('毒性推演使氨氮升高且出现超标采样点', () => {
    const s = steady();
    const fc = model(s).predictWithScenario(s.controls, 240, 60, 'toxic');
    expect(fc.violations.length).toBeGreaterThan(0);
    const last = fc.points[fc.points.length - 1].effluent.nh;
    const base = model(s).predict(s.controls, 240, 60).points.at(-1)!.effluent.nh;
    expect(last).toBeGreaterThan(base);
  });

  it('推演窗口内场景持续覆盖（短时场景不会被"跑完就恢复"掩盖）', () => {
    const s = steady();
    // power_outage 默认 45 min，但推演 240 min：最后一个采样点仍应处于停曝气状态
    const fc = model(s).predictWithScenario(s.controls, 240, 60, 'power_outage');
    for (const p of fc.points) expect(p.doLevel).toBeLessThan(2);
  });

  it('每个场景的默认强度都在合理范围（0–1 或目标数值）', () => {
    for (const [type, meta] of Object.entries(SCENARIOS)) {
      expect(meta.defaultMagnitude, type).toBeGreaterThanOrEqual(0);
      if (type === 'blower_failure') expect(meta.defaultMagnitude).toBeLessThanOrEqual(1);
    }
  });

  it('场景包络在推演窗口内始终 > 0（不会提前结束）', () => {
    const spec: ScenarioSpec = { type: 'power_outage', durationMin: 300, magnitude: 0, startedAt: 0 };
    for (const t of [1, 60, 120, 240]) expect(scenarioEnvelope(spec, t)).toBeGreaterThan(0);
  });
});
