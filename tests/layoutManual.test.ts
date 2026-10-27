import { describe, expect, it } from 'vitest';
import { layoutTopology, portAnchors } from '../src/model/layout';
import { PLANT_TOPOLOGY, ProcessTopology } from '../src/model/topology';

/**
 * 人工摆放与端口锚点。
 *
 * 这两件事是「可拖拽编排」的地基：
 * - positions 里的坐标必须覆盖自动布局，否则拖动没反应；
 * - 端口锚点必须落在节点边界上，否则连线端点与看到的圆点对不上。
 */

describe('人工摆放', () => {
  it('positions 覆盖自动布局坐标', () => {
    const topo: ProcessTopology = {
      ...PLANT_TOPOLOGY,
      positions: { anaerobic: { x: 900, y: 400 } },
    };
    const layout = layoutTopology(topo);
    const node = layout.nodes.find((n) => n.unit.id === 'anaerobic')!;
    expect(node.x).toBe(900);
    expect(node.y).toBe(400);
  });

  it('未摆放的单元保持自动布局', () => {
    const topo: ProcessTopology = { ...PLANT_TOPOLOGY, positions: { anaerobic: { x: 900, y: 400 } } };
    const layout = layoutTopology(topo);
    const other = layout.nodes.find((n) => n.unit.id === 'clarifier')!;
    const auto = layoutTopology(PLANT_TOPOLOGY).nodes.find((n) => n.unit.id === 'clarifier')!;
    expect(other.x).toBe(auto.x);
    expect(other.y).toBe(auto.y);
  });

  it('有人工摆放时 manual=true 且不画泳道参考线', () => {
    const layout = layoutTopology({ ...PLANT_TOPOLOGY, positions: { inlet: { x: 40, y: 40 } } });
    expect(layout.manual).toBe(true);
    expect(layout.lanes).toHaveLength(0);
  });

  it('无人工摆放时 manual=false 且保留泳道', () => {
    const layout = layoutTopology(PLANT_TOPOLOGY);
    expect(layout.manual).toBe(false);
    expect(layout.lanes.length).toBeGreaterThan(0);
  });

  it('非法坐标被忽略，不产生 NaN 布局', () => {
    const topo = {
      ...PLANT_TOPOLOGY,
      positions: { inlet: { x: Number.NaN, y: 10 } },
    } as ProcessTopology;
    const layout = layoutTopology(topo);
    const node = layout.nodes.find((n) => n.unit.id === 'inlet')!;
    expect(Number.isFinite(node.x)).toBe(true);
  });

  it('负坐标被夹到画布内', () => {
    const layout = layoutTopology({ ...PLANT_TOPOLOGY, positions: { inlet: { x: -500, y: -300 } } });
    const node = layout.nodes.find((n) => n.unit.id === 'inlet')!;
    expect(node.x).toBeGreaterThanOrEqual(0);
    expect(node.y).toBeGreaterThanOrEqual(0);
  });

  it('人工摆放后每条连接仍然有路径', () => {
    const layout = layoutTopology({
      ...PLANT_TOPOLOGY,
      positions: { anaerobic: { x: 1200, y: 500 }, aerobic1: { x: 1400, y: 500 } },
    });
    for (const edge of layout.edges) expect(edge.path.startsWith('M')).toBe(true);
  });

  it('公用工程与污泥单元的人工坐标同样生效', () => {
    const layout = layoutTopology({
      ...PLANT_TOPOLOGY,
      positions: { blower: { x: 500, y: 700 }, thickener: { x: 800, y: 900 } },
    });
    const blower = layout.nodes.find((n) => n.unit.id === 'blower')!;
    const thickener = layout.nodes.find((n) => n.unit.id === 'thickener')!;
    expect(blower.x).toBe(500);
    expect(blower.y).toBe(700);
    expect(thickener.x).toBe(800);
    expect(thickener.y).toBe(900);
  });

  it('连线折点被画成穿过该点的正交折线', () => {
    const layout = layoutTopology({
      ...PLANT_TOPOLOGY,
      routes: { 'c-aerobic1-aerobic2': [{ x: 1100, y: 180 }] },
    });
    const edge = layout.edges.find((e) => e.connection.id === 'c-aerobic1-aerobic2')!;
    expect(edge.path).toContain('H 1100');
    expect(edge.path).toContain('V 180');
  });

  it('折点路径不进入无关节点内部', () => {
    const layout = layoutTopology({
      ...PLANT_TOPOLOGY,
      // 折点落在主排与公用工程排之间的空白走廊里（用户可自由摆放，这里验证正交段不穿节点）
      routes: { 'c-aerobic1-aerobic2': [{ x: 1100, y: 180 }] },
    });
    const edge = layout.edges.find((e) => e.connection.id === 'c-aerobic1-aerobic2')!;
    const cmds = edge.path.match(/[MHV][^MHV]*/g) ?? [];
    const points: { x: number; y: number }[] = [];
    let x = 0;
    let y = 0;
    for (const cmd of cmds) {
      const nums = (cmd.slice(1).match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
      if (cmd[0] === 'M') {
        x = nums[0];
        y = nums[1];
        points.push({ x, y });
      } else if (cmd[0] === 'H') {
        x = nums[0];
        points.push({ x, y });
      } else {
        y = nums[0];
        points.push({ x, y });
      }
    }
    for (const node of layout.nodes) {
      if (node.unit.id === 'aerobic1' || node.unit.id === 'aerobic2') continue;
      for (let i = 1; i < points.length; i += 1) {
        const a = points[i - 1];
        const b = points[i];
        for (let k = 0; k <= 20; k += 1) {
          const px = a.x + ((b.x - a.x) * k) / 20;
          const py = a.y + ((b.y - a.y) * k) / 20;
          expect(px > node.x + 2 && px < node.x + node.w - 2 && py > node.y + 2 && py < node.y + node.h - 2).toBe(
            false,
          );
        }
      }
    }
  });
});

describe('端口锚点', () => {
  it('每个端口都有锚点，且入口在左边界、出口在右边界', () => {
    const layout = layoutTopology(PLANT_TOPOLOGY);
    for (const node of layout.nodes) {
      const anchors = portAnchors(node);
      expect(anchors).toHaveLength(node.unit.ports.length);
      for (const a of anchors) {
        expect(a.x).toBe(a.kind === 'in' ? node.x : node.x + node.w);
        expect(a.y).toBeGreaterThan(node.y);
        expect(a.y).toBeLessThan(node.y + node.h);
      }
    }
  });

  it('同侧多端口沿高度均分且不重叠', () => {
    const layout = layoutTopology(PLANT_TOPOLOGY);
    const clarifier = layout.nodes.find((n) => n.unit.id === 'clarifier')!;
    const outs = portAnchors(clarifier).filter((a) => a.kind === 'out');
    expect(outs.length).toBeGreaterThan(1);
    const ys = outs.map((o) => o.y).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i += 1) expect(ys[i] - ys[i - 1]).toBeGreaterThan(8);
  });

  it('连线端点取自同一套锚点（不会与端口圆点错位）', () => {
    const layout = layoutTopology(PLANT_TOPOLOGY);
    const edge = layout.edges.find((e) => e.connection.id === 'c-inlet-screen')!;
    const inlet = layout.nodes.find((n) => n.unit.id === 'inlet')!;
    const anchor = portAnchors(inlet).find((a) => a.port.id === 'out')!;
    const m = edge.path.match(/^M\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/)!;
    expect(Number(m[1])).toBeCloseTo(anchor.x, 5);
    expect(Number(m[2])).toBeCloseTo(anchor.y, 5);
  });
});
