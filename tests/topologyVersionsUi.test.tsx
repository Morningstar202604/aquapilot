// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ProcessEditor } from '../src/client/components/ProcessEditor';
import { PLANT_TOPOLOGY, ProcessTopology } from '../src/model/topology';
import { makeSnapshot } from './fixtures/snapshot';
import { useState } from 'react';

/**
 * 拓扑版本页。
 *
 * 设计约定：版本列表只展示摘要（revision / 名称 / 标签 / 单元与物流数），
 * 完整拓扑留在服务端；回滚按钮把 revision 交给服务端，由服务端走
 * 与「应用到仿真」完全相同的校验与预热。
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

function Harness({ onChange = vi.fn() }: { onChange?: (t: ProcessTopology) => void }) {
  const [topo, setTopo] = useState(PLANT_TOPOLOGY);
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
    />
  );
}

const versions = [
  { revision: 3, savedAt: new Date(0).toISOString(), label: '回滚到 v1', name: '澄川 A²/O', units: 17, connections: 23 },
  { revision: 2, savedAt: new Date(0).toISOString(), label: '切换模板：A²/O 强化脱氮', name: '强化脱氮', units: 17, connections: 23 },
  { revision: 1, savedAt: new Date(0).toISOString(), label: '应用自定义拓扑', name: '自定义厂', units: 18, connections: 25 },
];

describe('拓扑版本页', () => {
  it('没有回调时不显示版本页（监视/受限用法不受影响）', () => {
    render(<Harness />);
    expect(screen.queryByRole('button', { name: '版本' })).toBeNull();
  });

  it('点版本页请求列表并展示摘要', () => {
    const onRequestVersions = vi.fn();
    render(
      <ProcessEditor
        snap={makeSnapshot()}
        topology={PLANT_TOPOLOGY}
        onChange={vi.fn()}
        onApply={vi.fn()}
        dirty={false}
        canUndo={false}
        canRedo={false}
        onUndo={vi.fn()}
        onRedo={vi.fn()}
        versions={versions}
        onRequestVersions={onRequestVersions}
        onRevertVersion={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '版本' }));
    expect(onRequestVersions).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/拓扑版本（最近 3 版）/)).toBeTruthy();
    expect(document.querySelectorAll('[data-version]')).toHaveLength(3);
    expect(screen.getByText(/v3 · 澄川 A²\/O/)).toBeTruthy();
    expect(screen.getByText(/回滚到 v1/)).toBeTruthy();
  });

  it('每行带单元与物流数，回滚按钮回传对应 revision', () => {
    const onRevertVersion = vi.fn();
    render(
      <ProcessEditor
        snap={makeSnapshot()}
        topology={PLANT_TOPOLOGY}
        onChange={vi.fn()}
        onApply={vi.fn()}
        dirty={false}
        canUndo={false}
        canRedo={false}
        onUndo={vi.fn()}
        onRedo={vi.fn()}
        versions={versions}
        onRequestVersions={vi.fn()}
        onRevertVersion={onRevertVersion}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '版本' }));
    expect(screen.getByText('18 单元 / 25 物流')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '回滚到第 1 版' }));
    expect(onRevertVersion).toHaveBeenCalledWith(1);
  });

  it('空历史给出可读提示而不是空白', () => {
    render(
      <ProcessEditor
        snap={makeSnapshot()}
        topology={PLANT_TOPOLOGY}
        onChange={vi.fn()}
        onApply={vi.fn()}
        dirty={false}
        canUndo={false}
        canRedo={false}
        onUndo={vi.fn()}
        onRedo={vi.fn()}
        versions={[]}
        onRequestVersions={vi.fn()}
        onRevertVersion={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '版本' }));
    expect(screen.getByText(/还没有版本记录/)).toBeTruthy();
  });
});
