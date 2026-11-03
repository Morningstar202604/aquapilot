// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { PlantCanvas } from '../src/client/components/PlantCanvas';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import { layoutTopology, portAnchors } from '../src/model/layout';
import { makeSnapshot } from './fixtures/snapshot';

/**
 * 拖拽连线。
 *
 * 与「点出口 → 点入口」并存的第二条入口。锁三件事：
 * 1. 从出口拖到入口松手 → 回调拿到正确的 from/to；
 * 2. 位移不足 6 px 视为点击（不能把一次点击变成一条线）；
 * 3. 拖拽完成后紧跟的 click 被吞掉（否则会再进一次点击连线模式）。
 */

afterEach(() => {
  cleanup();
  delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
});

/**
 * jsdom 没有布局，elementFromPoint 恒为 null；拖拽连线的目标命中依赖它。
 * 这里用一个显式的"指针位置 -> 元素"映射替代，让测试能覆盖命中与未命中两条路径。
 */
const stubElementFromPoint = (target: Element | null) => {
  (document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => target;
};

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (!('PointerEvent' in globalThis)) {
    class PointerEventPolyfill extends MouseEvent {
      pointerId: number;
      constructor(type: string, params: MouseEventInit & { pointerId?: number } = {}) {
        super(type, params);
        this.pointerId = params.pointerId ?? 1;
      }
    }
    (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventPolyfill;
  }
});

/** 端口圆点按渲染顺序取；测试只关心 kind，不依赖具体单元 */
const dotsOf = (container: HTMLElement) => Array.from(container.querySelectorAll('.port-dot')) as SVGCircleElement[];

describe('拖拽连线', () => {
  it('从出口拖到入口松手，回调拿到 from/to', () => {
    const onPortDragConnect = vi.fn();
    const { container } = render(
      <PlantCanvas
        snap={makeSnapshot()}
        topo={PLANT_TOPOLOGY}
        selected={null}
        onSelect={vi.fn()}
        editable
        onPortDragConnect={onPortDragConnect}
      />,
    );
    const wrap = container.querySelector('.canvas-wrap') as HTMLElement;
    const dots = dotsOf(container);
    const out = dots.find((d) => d.getAttribute('data-kind') === 'out')!;
    const inn = dots.find((d) => d.getAttribute('data-kind') === 'in')!;
    stubElementFromPoint(inn);
    fireEvent.pointerDown(out, { clientX: 10, clientY: 10, bubbles: true, pointerId: 1 });
    fireEvent.pointerMove(wrap, { clientX: 60, clientY: 60, bubbles: true, pointerId: 1 });
    fireEvent.pointerUp(wrap, { clientX: 120, clientY: 120, bubbles: true, pointerId: 1 });
    expect(onPortDragConnect).toHaveBeenCalledTimes(1);
    const [from, to] = onPortDragConnect.mock.calls[0];
    expect(from.unitId).toBeTruthy();
    expect(to.unitId).toBeTruthy();
    expect(from.unitId).not.toBe(to.unitId);
  });

  it('位移不足 6px 视为点击，不产生连线', () => {
    const onPortDragConnect = vi.fn();
    const { container } = render(
      <PlantCanvas
        snap={makeSnapshot()}
        topo={PLANT_TOPOLOGY}
        selected={null}
        onSelect={vi.fn()}
        editable
        onPortDragConnect={onPortDragConnect}
      />,
    );
    const wrap = container.querySelector('.canvas-wrap') as HTMLElement;
    const dots = dotsOf(container);
    const out = dots.find((d) => d.getAttribute('data-kind') === 'out')!;
    const inn = dots.find((d) => d.getAttribute('data-kind') === 'in')!;
    stubElementFromPoint(inn);
    fireEvent.pointerDown(out, { clientX: 10, clientY: 10, bubbles: true, pointerId: 1 });
    fireEvent.pointerMove(wrap, { clientX: 11, clientY: 11, bubbles: true, pointerId: 1 });
    fireEvent.pointerUp(wrap, { clientX: 11, clientY: 11, bubbles: true, pointerId: 1 });
    expect(onPortDragConnect).not.toHaveBeenCalled();
  });

  it('拖拽后的 click 被吞掉，不会同时进入点击连线模式', () => {
    const onPortClick = vi.fn();
    const onPortDragConnect = vi.fn();
    const { container } = render(
      <PlantCanvas
        snap={makeSnapshot()}
        topo={PLANT_TOPOLOGY}
        selected={null}
        onSelect={vi.fn()}
        editable
        onPortClick={onPortClick}
        onPortDragConnect={onPortDragConnect}
      />,
    );
    const wrap = container.querySelector('.canvas-wrap') as HTMLElement;
    const dots = dotsOf(container);
    const out = dots.find((d) => d.getAttribute('data-kind') === 'out')!;
    const inn = dots.find((d) => d.getAttribute('data-kind') === 'in')!;
    stubElementFromPoint(inn);
    fireEvent.pointerDown(out, { clientX: 10, clientY: 10, bubbles: true, pointerId: 1 });
    fireEvent.pointerMove(wrap, { clientX: 70, clientY: 70, bubbles: true, pointerId: 1 });
    fireEvent.pointerUp(wrap, { clientX: 70, clientY: 70, bubbles: true, pointerId: 1 });
    fireEvent.click(out, { bubbles: true });
    expect(onPortDragConnect).toHaveBeenCalledTimes(1);
    expect(onPortClick).not.toHaveBeenCalled();
  });

  it('松手时不在入口圆点上（命中空白/出口）不产生连线', () => {
    const onPortDragConnect = vi.fn();
    const { container } = render(
      <PlantCanvas
        snap={makeSnapshot()}
        topo={PLANT_TOPOLOGY}
        selected={null}
        onSelect={vi.fn()}
        editable
        onPortDragConnect={onPortDragConnect}
      />,
    );
    const wrap = container.querySelector('.canvas-wrap') as HTMLElement;
    const dots = dotsOf(container);
    const out = dots.find((d) => d.getAttribute('data-kind') === 'out')!;
    stubElementFromPoint(container.querySelector('.plant-canvas'));
    fireEvent.pointerDown(out, { clientX: 10, clientY: 10, bubbles: true, pointerId: 1 });
    fireEvent.pointerMove(wrap, { clientX: 70, clientY: 70, bubbles: true, pointerId: 1 });
    fireEvent.pointerUp(wrap, { clientX: 70, clientY: 70, bubbles: true, pointerId: 1 });
    expect(onPortDragConnect).not.toHaveBeenCalled();
  });

  it('未提供 onPortDragConnect 时拖拽不产生任何回调（只读模式不受影响）', () => {
    const { container } = render(
      <PlantCanvas snap={makeSnapshot()} topo={PLANT_TOPOLOGY} selected={null} onSelect={vi.fn()} />,
    );
    expect(container.querySelectorAll('.port-dot')).toHaveLength(0);
  });
});

/** 与 PlantCanvas 相同参数的布局：吸附测试按锚点真实坐标落点 */
const inAnchors = (() => {
  const layout = layoutTopology(PLANT_TOPOLOGY, { laneGap: 96 });
  const list: { unitId: string; portId: string; x: number; y: number }[] = [];
  for (const n of layout.nodes) {
    for (const a of portAnchors(n)) {
      if (a.kind === 'in') list.push({ unitId: n.unit.id, portId: a.port.id, x: a.x, y: a.y });
    }
  }
  return list;
})();

describe('拖拽连线的端口吸附', () => {
  it('指针进入吸附半径时目标端口高亮，松手即连线（无需像素级命中）', () => {
    const onPortDragConnect = vi.fn();
    const { container } = render(
      <PlantCanvas
        snap={makeSnapshot()}
        topo={PLANT_TOPOLOGY}
        selected={null}
        onSelect={vi.fn()}
        editable
        onPortDragConnect={onPortDragConnect}
      />,
    );
    const wrap = container.querySelector('.canvas-wrap') as HTMLElement;
    const dots = dotsOf(container);
    const out = dots.find((d) => d.getAttribute('data-kind') === 'out')!;
    const outUnit = out.closest('.port-layer')!.getAttribute('data-unit')!;
    const target = inAnchors.find((a) => a.unitId !== outUnit)!;
    stubElementFromPoint(null); // 证明连线由吸附完成，而不是 elementFromPoint
    fireEvent.pointerDown(out, { clientX: 10, clientY: 10, bubbles: true, pointerId: 1 });
    fireEvent.pointerMove(wrap, { clientX: target.x + 2, clientY: target.y + 2, bubbles: true, pointerId: 1 });
    const snapped = container.querySelector('.port-dot[data-snap="true"]') as SVGCircleElement | null;
    expect(snapped).not.toBeNull();
    expect(snapped!.closest('.port-layer')!.getAttribute('data-unit')).toBe(target.unitId);
    expect(snapped!.getAttribute('data-port')).toBe(target.portId);
    fireEvent.pointerUp(wrap, { clientX: target.x + 2, clientY: target.y + 2, bubbles: true, pointerId: 1 });
    expect(onPortDragConnect).toHaveBeenCalledTimes(1);
    const [from, to] = onPortDragConnect.mock.calls[0];
    expect(to).toEqual({ unitId: target.unitId, portId: target.portId });
    expect(from.unitId).toBe(outUnit);
  });

  it('指针在吸附半径之外时不吸附、不高亮', () => {
    const onPortDragConnect = vi.fn();
    const { container } = render(
      <PlantCanvas
        snap={makeSnapshot()}
        topo={PLANT_TOPOLOGY}
        selected={null}
        onSelect={vi.fn()}
        editable
        onPortDragConnect={onPortDragConnect}
      />,
    );
    const wrap = container.querySelector('.canvas-wrap') as HTMLElement;
    const dots = dotsOf(container);
    const out = dots.find((d) => d.getAttribute('data-kind') === 'out')!;
    stubElementFromPoint(null);
    fireEvent.pointerDown(out, { clientX: 10, clientY: 10, bubbles: true, pointerId: 1 });
    // 远离所有入口锚点（最近的在 y=48 以上，取 y=350 的空白带）
    fireEvent.pointerMove(wrap, { clientX: 700, clientY: 350, bubbles: true, pointerId: 1 });
    expect(container.querySelector('.port-dot[data-snap="true"]')).toBeNull();
    fireEvent.pointerUp(wrap, { clientX: 700, clientY: 350, bubbles: true, pointerId: 1 });
    expect(onPortDragConnect).not.toHaveBeenCalled();
  });

  it('起点单元自己的入口不吸附（不允许连回同一个池）', () => {
    const onPortDragConnect = vi.fn();
    const { container } = render(
      <PlantCanvas
        snap={makeSnapshot()}
        topo={PLANT_TOPOLOGY}
        selected={null}
        onSelect={vi.fn()}
        editable
        onPortDragConnect={onPortDragConnect}
      />,
    );
    const wrap = container.querySelector('.canvas-wrap') as HTMLElement;
    const dots = dotsOf(container);
    const out = dots.find((d) => d.getAttribute('data-kind') === 'out')!;
    const outUnit = out.closest('.port-layer')!.getAttribute('data-unit')!;
    const ownIn = inAnchors.find((a) => a.unitId === outUnit);
    if (!ownIn) return; // 该单元没有入口端口则跳过
    stubElementFromPoint(null);
    fireEvent.pointerDown(out, { clientX: 10, clientY: 10, bubbles: true, pointerId: 1 });
    fireEvent.pointerMove(wrap, { clientX: ownIn.x, clientY: ownIn.y, bubbles: true, pointerId: 1 });
    const snapped = container.querySelector('.port-dot[data-snap="true"]');
    if (snapped) {
      const unit = snapped.closest('.port-layer')!.getAttribute('data-unit');
      expect(unit).not.toBe(outUnit);
    }
    fireEvent.pointerUp(wrap, { clientX: ownIn.x, clientY: ownIn.y, bubbles: true, pointerId: 1 });
    const calls = onPortDragConnect.mock.calls as [[{ unitId: string }, { unitId: string }]];
    for (const [, to] of calls) expect(to.unitId).not.toBe(outUnit);
  });
});
