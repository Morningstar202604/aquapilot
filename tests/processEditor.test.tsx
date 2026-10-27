// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ProcessEditor } from '../src/client/components/ProcessEditor';
import { PLANT_TOPOLOGY, ProcessTopology } from '../src/model/topology';
import { makeSnapshot } from './fixtures/snapshot';

/**
 * 编排器交互。
 *
 * 纯函数行为在 topologyEdit.test.ts 覆盖；这里只验证按钮/回调真的连上了，
 * 以及多选删除、折点拖动确实走 onChange 写回拓扑。
 */

afterEach(cleanup);

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  /**
   * jsdom 没有 PointerEvent，@testing-library 会退回基础 Event，
   * clientX/clientY 直接丢失（拖动测试会拿到 NaN）。用 MouseEvent 兜底。
   */
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

/** 受控编辑器外壳：真实 App 里选中与草稿都存在父层 */
function Harness({
  onChange,
  initial = PLANT_TOPOLOGY,
}: {
  onChange: (topo: ProcessTopology) => void;
  initial?: ProcessTopology;
}) {
  const [topo, setTopo] = useState(initial);
  const [selection, setSelection] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <ProcessEditor
      snap={makeSnapshot()}
      topology={topo}
      onChange={(next) => {
        setTopo(next);
        onChange(next);
      }}
      onApply={vi.fn()}
      dirty={false}
      canUndo={false}
      canRedo={false}
      onUndo={vi.fn()}
      onRedo={vi.fn()}
      selectedId={selected}
      onSelectedChange={setSelected}
      selectionIds={selection}
      onSelectionChange={setSelection}
    />
  );
}

const nodeOf = (id: string) => document.querySelector(`[data-unit-node="${id}"]`)!;

describe('ProcessEditor', () => {
  it('工具栏提供批量删除入口', () => {
    render(<Harness onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: '批量删除' })).toBeTruthy();
  });

  it('批量删除一次移除全部选中单元与相连物流', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.pointerDown(nodeOf('aerobic1'), { clientX: 10, clientY: 10, bubbles: true, pointerId: 1 });
    fireEvent.pointerDown(nodeOf('aerobic2'), { clientX: 20, clientY: 10, shiftKey: true, bubbles: true, pointerId: 1 });
    fireEvent.click(screen.getByRole('button', { name: '批量删除' }));
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls.at(-1)![0] as ProcessTopology;
    expect(next.units.some((u) => u.id === 'aerobic1')).toBe(false);
    expect(next.units.some((u) => u.id === 'aerobic2')).toBe(false);
    expect(next.connections.some((c) => c.from.unit === 'aerobic1' || c.to.unit === 'aerobic1')).toBe(false);
    expect(next.train).toEqual(['anaerobic', 'anoxic', 'aerobic3']);
  });

  it('折点拖动通过 onChange 写回 routes', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const handle = document.querySelector('.route-handle') as SVGCircleElement;
    expect(handle).toBeTruthy();
    const connectionId = handle.getAttribute('data-connection')!;
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, bubbles: true, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 128, clientY: 128, bubbles: true, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 128, clientY: 128, bubbles: true, pointerId: 1 });
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls.at(-1)![0] as ProcessTopology;
    expect(next.routes?.[connectionId]?.length).toBeGreaterThan(0);
  });

  it('折点复位按钮清除该连线的 routes', () => {
    const onChange = vi.fn();
    const topology: ProcessTopology = {
      ...PLANT_TOPOLOGY,
      routes: { 'c-aerobic1-aerobic2': [{ x: 1100, y: 180 }] },
    };
    render(<Harness onChange={onChange} initial={topology} />);
    const reset = document.querySelector('.route-reset') as SVGGElement;
    expect(reset).toBeTruthy();
    fireEvent.click(reset);
    const next = onChange.mock.calls.at(-1)![0] as ProcessTopology;
    expect(next.routes?.['c-aerobic1-aerobic2']).toBeUndefined();
  });
});
