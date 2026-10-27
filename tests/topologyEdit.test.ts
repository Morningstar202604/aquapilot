import { describe, expect, it } from 'vitest';
import { PLANT_TOPOLOGY, ProcessTopology } from '../src/model/topology';
import { deleteUnits, moveUnitsTo, setRoute } from '../src/model/topologyEdit';

/**
 * 拓扑编辑的纯函数。
 *
 * 这些规则决定「批量删除会不会留下断头线」「折点存不存得下」「方向键是不是
 * 从眼前的位置起跳」。放在组件里只能靠点页面验证，拆出来可以逐条断言。
 */

const clone = (): ProcessTopology => JSON.parse(JSON.stringify(PLANT_TOPOLOGY));

describe('批量删除', () => {
  it('删除多个单元及所有相连物流，主序列与坐标一起清理', () => {
    const topo: ProcessTopology = {
      ...clone(),
      positions: { aerobic1: { x: 700, y: 200 }, aerobic2: { x: 900, y: 200 }, blower: { x: 40, y: 600 } },
      routes: { 'c-aerobic1-aerobic2': [{ x: 820, y: 260 }] },
    };
    const next = deleteUnits(topo, ['aerobic1', 'aerobic2']);
    expect(next.units.some((u) => u.id === 'aerobic1')).toBe(false);
    expect(next.units.some((u) => u.id === 'aerobic2')).toBe(false);
    expect(next.train).toEqual(['anaerobic', 'anoxic', 'aerobic3']);
    expect(next.connections.some((c) => c.from.unit === 'aerobic1' || c.to.unit === 'aerobic1')).toBe(false);
    expect(next.connections.some((c) => c.from.unit === 'aerobic2' || c.to.unit === 'aerobic2')).toBe(false);
    expect(next.positions?.aerobic1).toBeUndefined();
    expect(next.positions?.blower).toEqual({ x: 40, y: 600 });
    expect(next.routes?.['c-aerobic1-aerobic2']).toBeUndefined();
  });

  it('不修改传入的拓扑（撤销栈里每步都是独立快照）', () => {
    const topo = clone();
    const before = JSON.stringify(topo);
    deleteUnits(topo, ['aerobic1']);
    expect(JSON.stringify(topo)).toBe(before);
  });

  it('忽略不存在的 id，返回等价拓扑', () => {
    const topo = clone();
    const next = deleteUnits(topo, ['nope']);
    expect(next.units).toHaveLength(topo.units.length);
    expect(next.connections).toHaveLength(topo.connections.length);
  });

  it('删掉二沉池后拓扑仍可被校验拒绝（不是静默通过）', () => {
    const next = deleteUnits(clone(), ['clarifier']);
    expect(next.units.some((u) => u.kind === 'clarifier')).toBe(false);
  });
});

describe('连线折点', () => {
  it('写入折点并按整数保存', () => {
    const next = setRoute(clone(), 'c-aerobic1-aerobic2', [{ x: 812.6, y: 260.2 }]);
    expect(next.routes?.['c-aerobic1-aerobic2']).toEqual([{ x: 813, y: 260 }]);
  });

  it('null 清除折点，其他连线的折点保留', () => {
    const base = setRoute(clone(), 'c-aerobic1-aerobic2', [{ x: 800, y: 200 }]);
    const withTwo = setRoute(base, 'c-aerobic2-aerobic3', [{ x: 1000, y: 240 }]);
    const cleared = setRoute(withTwo, 'c-aerobic1-aerobic2', null);
    expect(cleared.routes?.['c-aerobic1-aerobic2']).toBeUndefined();
    expect(cleared.routes?.['c-aerobic2-aerobic3']).toEqual([{ x: 1000, y: 240 }]);
  });

  it('折点数量与坐标被限制，避免脏数据进入布局', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ x: i * 10, y: i * 5 }));
    const next = setRoute(clone(), 'c-aerobic1-aerobic2', many);
    expect(next.routes!['c-aerobic1-aerobic2'].length).toBeLessThanOrEqual(8);
    for (const p of next.routes!['c-aerobic1-aerobic2']) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
    }
  });

  it('未知连接不产生空路由条目', () => {
    const next = setRoute(clone(), 'nope', [{ x: 10, y: 10 }]);
    expect(next.routes?.nope).toBeUndefined();
  });
});

describe('绝对位移', () => {
  it('按给定坐标移动多个单元，并清理负坐标', () => {
    const next = moveUnitsTo(clone(), {
      aerobic1: { x: -30, y: 120 },
      aerobic2: { x: 640, y: 120 },
    });
    expect(next.positions?.aerobic1).toEqual({ x: 0, y: 120 });
    expect(next.positions?.aerobic2).toEqual({ x: 640, y: 120 });
  });

  it('未知单元不写入坐标', () => {
    const next = moveUnitsTo(clone(), { nope: { x: 10, y: 10 } });
    expect(next.positions?.nope).toBeUndefined();
  });
});
