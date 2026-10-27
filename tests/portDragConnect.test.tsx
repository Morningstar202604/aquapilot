// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { PlantCanvas } from '../src/client/components/PlantCanvas';
import { PLANT_TOPOLOGY } from '../src/model/topology';
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
