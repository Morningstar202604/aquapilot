import { describe, expect, it } from 'vitest';
import { PLANT_TOPOLOGY, ProcessTopology } from '../src/model/topology';
import { buildTrainProfile, shouldShowTrainProfile } from '../src/model/trainProfile';
import type { TankState } from '../src/sim/plantTypes';

/**
 * 沿程剖面。
 *
 * 目的：操作员在单元检视器里不只看到"这个池子"，还要看到"整条主线的走势"。
 * 这里锁三件事：顺序严格按 train、缺失实时状态不崩溃且标记 live=false、
 * 当前单元有且只有一个高亮。
 */

const tank = (id: string, over: Partial<TankState> = {}): TankState => ({
  id,
  name: id,
  short: id,
  kind: 'aerobic',
  volume: 5000,
  cod: 30,
  nh: 1,
  no3: 8,
  tp: 0.2,
  do: 2,
  mlss: 3000,
  alkalinity: 200,
  temperature: 20,
  codRemoved: 0,
  nhRemoved: 0,
  o2Demand: 0,
  klaUsed: 0,
  ...over,
});

describe('沿程剖面', () => {
  it('按 train 顺序输出，不按快照里的顺序', () => {
    const tanks = [...PLANT_TOPOLOGY.train].reverse().map((id) => tank(id));
    const rows = buildTrainProfile(PLANT_TOPOLOGY, tanks, 'anoxic');
    expect(rows.map((r) => r.id)).toEqual(PLANT_TOPOLOGY.train);
    expect(rows.map((r) => r.index)).toEqual([1, 2, 3, 4, 5]);
  });

  it('当前单元有且只有一个高亮', () => {
    const tanks = PLANT_TOPOLOGY.train.map((id) => tank(id));
    const rows = buildTrainProfile(PLANT_TOPOLOGY, tanks, 'aerobic2');
    expect(rows.filter((r) => r.current)).toHaveLength(1);
    expect(rows.find((r) => r.current)!.id).toBe('aerobic2');
  });

  it('缺失实时状态时 live=false 且数值为 0（不抛错、不显示 NaN）', () => {
    const rows = buildTrainProfile(PLANT_TOPOLOGY, [tank('anaerobic')], 'anaerobic');
    const missing = rows.find((r) => r.id === 'anoxic')!;
    expect(missing.live).toBe(false);
    expect(missing.do).toBe(0);
    expect(Number.isNaN(missing.nh)).toBe(false);
    expect(Number.isFinite(missing.mlss)).toBe(true);
  });

  it('train 引用不存在的单元时跳过该行而不是造出空行', () => {
    const broken = { ...PLANT_TOPOLOGY, train: [...PLANT_TOPOLOGY.train, 'ghost'] } as ProcessTopology;
    const rows = buildTrainProfile(broken, [], 'anaerobic');
    expect(rows).toHaveLength(PLANT_TOPOLOGY.train.length);
    expect(rows.some((r) => r.id === 'ghost')).toBe(false);
  });

  it('非主序列单元（鼓风机）不输出任何行', () => {
    const rows = buildTrainProfile(PLANT_TOPOLOGY, [], 'blower');
    expect(rows.some((r) => r.id === 'blower')).toBe(false);
  });

  it('展示条件：至少两行、至少一行有实时数据、且当前单元在主序列里', () => {
    const tanks = PLANT_TOPOLOGY.train.map((id) => tank(id));
    expect(shouldShowTrainProfile(buildTrainProfile(PLANT_TOPOLOGY, tanks, 'aerobic1'))).toBe(true);
    expect(shouldShowTrainProfile(buildTrainProfile(PLANT_TOPOLOGY, [], 'aerobic1'))).toBe(false);
    // 当前单元不在主序列（鼓风机）：即便有实时数据也不展示
    expect(shouldShowTrainProfile(buildTrainProfile(PLANT_TOPOLOGY, tanks, 'blower'))).toBe(false);
  });
});
