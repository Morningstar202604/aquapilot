// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { PlantCanvas } from '../src/client/components/PlantCanvas';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import { makeSnapshot } from './fixtures/snapshot';

/**
 * 画布组件（渲染层）。
 *
 * 布局几何已由 layoutManual 覆盖；这里锁定「渲染出来的东西对不对」：
 * 编辑模式必须画出端口圆点、非编辑模式不能有、节点点击走回调、
 * 拖动会按图纸坐标提交。
 *
 * jsdom 没有布局引擎（getBoundingClientRect 全 0），所以这里不测像素位移，
 * 只测结构与回调；真实拖拽已在浏览器里实测。
 */

afterEach(cleanup);

/**
 * jsdom 没有 ResizeObserver。
 *
 * 组件用它做尺寸自适应（全览缩放比）；在测试里给一个空实现即可，
 * 不改变被测逻辑（布局几何由 layoutTopology 决定，与观察器无关）。
 */
beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

describe('PlantCanvas 渲染', () => {
  it('渲染全部工艺单元与物流', () => {
    const { container } = render(
      <PlantCanvas snap={makeSnapshot()} topo={PLANT_TOPOLOGY} selected={null} onSelect={vi.fn()} />,
    );
    expect(container.querySelectorAll('[data-unit-node]')).toHaveLength(PLANT_TOPOLOGY.units.length);
    expect(container.querySelectorAll('.plant-node')).toHaveLength(PLANT_TOPOLOGY.units.length);
    // 每条连接一条 path（含动画副本，所以只校验 ≥ 连接数）
    expect(container.querySelectorAll('path').length).toBeGreaterThanOrEqual(PLANT_TOPOLOGY.connections.length);
  });

  it('监视模式不画端口圆点（只读视图保持干净）', () => {
    const { container } = render(
      <PlantCanvas snap={makeSnapshot()} topo={PLANT_TOPOLOGY} selected={null} onSelect={vi.fn()} />,
    );
    expect(container.querySelectorAll('.port-dot')).toHaveLength(0);
  });

  it('编排模式为每个端口画一个圆点', () => {
    const { container } = render(
      <PlantCanvas snap={makeSnapshot()} topo={PLANT_TOPOLOGY} selected={null} onSelect={vi.fn()} editable />,
    );
    const portCount = PLANT_TOPOLOGY.units.reduce((n, u) => n + u.ports.length, 0);
    expect(container.querySelectorAll('.port-dot')).toHaveLength(portCount);
  });

  it('端口按物流类型着色', () => {
    const { container } = render(
      <PlantCanvas snap={makeSnapshot()} topo={PLANT_TOPOLOGY} selected={null} onSelect={vi.fn()} editable />,
    );
    const dots = Array.from(container.querySelectorAll('.port-dot')) as SVGCircleElement[];
    const air = dots.find((d) => d.getAttribute('data-stream') === 'air');
    expect(air?.style.stroke).toBe('#38a8c9');
    // 不同物流的端口不能同色（否则靠颜色区分水位/回流就失效了）
    const grey = dots.find((d) => d.getAttribute('data-stream') === 'influent');
    expect(grey?.style.stroke).toBe('#3d7fd9');
  });

  it('点端口回调带上单元、端口与方向', () => {
    const onPortClick = vi.fn();
    const { container } = render(
      <PlantCanvas
        snap={makeSnapshot()}
        topo={PLANT_TOPOLOGY}
        selected={null}
        onSelect={vi.fn()}
        editable
        onPortClick={onPortClick}
      />,
    );
    const first = container.querySelector('.port-dot') as SVGCircleElement;
    fireEvent.click(first);
    expect(onPortClick).toHaveBeenCalledTimes(1);
    expect(onPortClick.mock.calls[0][0]).toBe(PLANT_TOPOLOGY.units[0].id);
    expect(onPortClick.mock.calls[0][2]).toBe(PLANT_TOPOLOGY.units[0].ports[0].kind);
  });

  it('选中单元用高亮描边', () => {
    const target = PLANT_TOPOLOGY.units[0].id;
    const { container } = render(
      <PlantCanvas snap={makeSnapshot()} topo={PLANT_TOPOLOGY} selected={target} onSelect={vi.fn()} />,
    );
    const node = container.querySelector(`[data-unit-node="${target}"] rect`);
    expect(node?.getAttribute('stroke')).toBe('var(--water)');
  });

  it('多选时标记 data-multi', () => {
    const ids = PLANT_TOPOLOGY.units.slice(0, 2).map((u) => u.id);
    const { container } = render(
      <PlantCanvas
        snap={makeSnapshot()}
        topo={PLANT_TOPOLOGY}
        selected={ids[0]}
        onSelect={vi.fn()}
        selection={ids}
        onSelectionChange={vi.fn()}
      />,
    );
    expect(container.querySelectorAll('.plant-node[data-multi="true"]')).toHaveLength(2);
  });

  it('1:1 细读模式下每个单元标题前有工艺图标', () => {
    /**
     * 全览模式不画图标：24px 标题才是读图主线，图标只占宽度。
     * 小屏默认 1:1（fitToWindow=false），用这个模式验证图标层仍在。
     */
    const original = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true });
    try {
      const { container } = render(
        <PlantCanvas snap={makeSnapshot()} topo={PLANT_TOPOLOGY} selected={null} onSelect={vi.fn()} />,
      );
      expect(container.querySelectorAll('.unit-icon')).toHaveLength(PLANT_TOPOLOGY.units.length);
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: original, configurable: true });
    }
  });

  it('全览模式标题按节点宽度收缩，长名字不越界', () => {
    const { container } = render(
      <PlantCanvas snap={makeSnapshot()} topo={PLANT_TOPOLOGY} selected={null} onSelect={vi.fn()} />,
    );
    const titles = [...container.querySelectorAll('.unit-title-lg')] as SVGTextElement[];
    expect(titles.length).toBe(PLANT_TOPOLOGY.units.length);
    // 长名字必须降过字号（24px 是短名字的上限）
    const thickener = titles.find((t) => t.textContent === '污泥浓缩池');
    expect(thickener).toBeTruthy();
    expect(Number(thickener!.style.fontSize.replace('px', ''))).toBeLessThan(24);
  });
});
