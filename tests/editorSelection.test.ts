import { describe, expect, it } from 'vitest';
import {
  alignNodes,
  boundsOf,
  distributeNodes,
  moveNodes,
  nextSelection,
  nodesInRect,
  rectsIntersect,
} from '../src/client/hooks/editorSelection';
import type { PlacedNode } from '../src/model/layout';

/**
 * 编排选择与对齐的纯几何。
 *
 * 这些规则决定"框选能不能选中""多选拖动是不是一起动""对齐后是不是真的平齐"，
 * 用固定矩形断言比点页面可靠得多。
 */

const node = (id: string, x: number, y: number, w = 100, h = 60): PlacedNode => ({
  unit: { id, kind: 'aerobic', name: id, role: '', ports: [] },
  x,
  y,
  w,
  h,
  layer: 'main',
  lane: 0,
});

const nodes = [node('a', 0, 0), node('b', 200, 40), node('c', 400, 80)];

describe('矩形与框选', () => {
  it('相交判定包含部分重叠、不含相邻不重叠', () => {
    expect(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
    expect(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 0, w: 10, h: 10 })).toBe(false);
  });

  it('框选返回与矩形相交的单元', () => {
    expect(nodesInRect(nodes, { x: -10, y: -10, w: 320, h: 120 })).toEqual(['a', 'b']);
    expect(nodesInRect(nodes, { x: 1000, y: 1000, w: 10, h: 10 })).toEqual([]);
  });

  it('空集合没有外接矩形', () => {
    expect(boundsOf(nodes, [])).toBeNull();
  });

  it('外接矩形覆盖所有选中节点', () => {
    const b = boundsOf(nodes, ['a', 'c'])!;
    expect(b).toEqual({ x: 0, y: 0, w: 500, h: 140 });
  });
});

describe('选择语义', () => {
  it('普通点击替换选择', () => {
    expect(nextSelection(['a', 'b'], 'c', false)).toEqual(['c']);
  });

  it('点已选中的单元保持整组（为多选拖动留手）', () => {
    expect(nextSelection(['a', 'b'], 'a', false)).toEqual(['a', 'b']);
  });

  it('加选与取消加选', () => {
    expect(nextSelection(['a'], 'b', true)).toEqual(['a', 'b']);
    expect(nextSelection(['a', 'b'], 'a', true)).toEqual(['b']);
  });
});

describe('对齐', () => {
  it('少于两个目标不产生移动', () => {
    expect(alignNodes(nodes, ['a'], 'left')).toEqual({});
  });

  it('左对齐把所有节点推到外接左边', () => {
    const moves = alignNodes(nodes, ['a', 'b', 'c'], 'left');
    expect(moves.a.x).toBe(0);
    expect(moves.b.x).toBe(0);
    expect(moves.c.x).toBe(0);
  });

  it('顶对齐保留各自的 x', () => {
    const moves = alignNodes(nodes, ['a', 'b'], 'top');
    expect(moves.a).toEqual({ x: 0, y: 0 });
    expect(moves.b).toEqual({ x: 200, y: 0 });
  });

  it('右对齐按各自宽度反推', () => {
    const wide = node('d', 0, 200, 160, 60);
    const moves = alignNodes([...nodes, wide], ['a', 'd'], 'right');
    // 外接右边 = max(100, 160) = 160
    expect(moves.a.x).toBe(60);
    expect(moves.d.x).toBe(0);
  });

  it('居中按外接框中心对齐', () => {
    const moves = alignNodes(nodes, ['a', 'c'], 'centerX');
    // 外接框 0..500，中心 250
    expect(moves.a.x).toBe(200);
    expect(moves.c.x).toBe(200);
  });
});

describe('等距分布', () => {
  it('少于三个不处理', () => {
    expect(distributeNodes(nodes, ['a', 'b'], 'x')).toEqual({});
  });

  it('两端不动，中间按中心点均分', () => {
    const mid = node('b', 250, 0);
    const moves = distributeNodes([node('a', 0, 0), mid, node('c', 600, 0)], ['a', 'b', 'c'], 'x');
    // 中心 50 与 650，中点是 350，节点宽 100 → x=300
    expect(moves.b.x).toBe(300);
    expect(moves.a).toBeUndefined();
    expect(moves.c).toBeUndefined();
  });
});

describe('批量位移', () => {
  it('吸附到栅格并按同一增量移动', () => {
    const moves = moveNodes(nodes, ['a', 'b'], 33, 20);
    expect(moves.a).toEqual({ x: 28, y: 14 });
    expect(moves.b).toEqual({ x: 228, y: 54 });
  });

  it('不会移动到负坐标', () => {
    const moves = moveNodes(nodes, ['a'], -500, -500);
    expect(moves.a).toEqual({ x: 0, y: 0 });
  });

  it('未选中的节点不在结果里', () => {
    expect(Object.keys(moveNodes(nodes, ['b'], 14, 14))).toEqual(['b']);
  });
});
