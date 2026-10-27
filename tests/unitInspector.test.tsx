// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { UnitInspector } from '../src/client/components/UnitInspector';
import { PLANT_TOPOLOGY, findUnit } from '../src/model/topology';
import { makeSnapshot } from './fixtures/snapshot';

/**
 * 单元检视器。
 *
 * 「我去改参数都不行」是实测反馈里最直接的一条：点开一个池子必须能
 * 看到它自己的实时值，并且能就地改它支持的那几个控制量。
 */

afterEach(cleanup);

const renderInspector = (unitId: string, onChangeControls = vi.fn()) => {
  const unit = findUnit(PLANT_TOPOLOGY, unitId)!;
  const onEditTopology = vi.fn();
  render(
    <UnitInspector
      snap={makeSnapshot()}
      topo={PLANT_TOPOLOGY}
      unit={unit}
      onClose={vi.fn()}
      onSelect={vi.fn()}
      onChangeControls={onChangeControls}
      onEditTopology={onEditTopology}
    />,
  );
  return { onChangeControls, onEditTopology };
};

describe('UnitInspector', () => {
  it('好氧池显示容积、实时 DO/MLSS 与三个可调参数', () => {
    renderInspector('aerobic1');
    expect(screen.getByText('好氧池 A')).toBeTruthy();
    expect(screen.getByText('5,000 m³')).toBeTruthy();
    expect(document.getElementById('insp-doSetpoint')).toBeTruthy();
    expect(document.getElementById('insp-pacDose')).toBeTruthy();
    expect(document.getElementById('insp-alkDose')).toBeTruthy();
  });

  it('只列该单元自己支持的控制量（好氧池没有回流比）', () => {
    renderInspector('aerobic1');
    expect(document.getElementById('insp-rasRatio')).toBeNull();
    expect(document.getElementById('insp-wasRatio')).toBeNull();
  });

  it('二沉池只列回流比与排泥', () => {
    renderInspector('clarifier');
    expect(document.getElementById('insp-rasRatio')).toBeTruthy();
    expect(document.getElementById('insp-wasRatio')).toBeTruthy();
    expect(document.getElementById('insp-doSetpoint')).toBeNull();
  });

  it('拖动滑块回传正确的控制键与新值', () => {
    const { onChangeControls } = renderInspector('aerobic1');
    const slider = document.getElementById('insp-doSetpoint') as HTMLInputElement;
    fireEvent.change(slider, { target: { value: '1.6' } });
    expect(onChangeControls).toHaveBeenCalledWith({ doSetpoint: 1.6 });
  });

  it('没有可调参数的单元给出说明而不是空白', () => {
    renderInspector('inlet');
    expect(screen.getByText(/没有可直接调节的运行参数/)).toBeTruthy();
  });

  it('点「在工艺编排中编辑」进入编辑器', () => {
    const { onEditTopology } = renderInspector('aerobic1');
    fireEvent.click(screen.getByRole('button', { name: '在工艺编排中编辑' }));
    expect(onEditTopology).toHaveBeenCalled();
  });

  it('显示进出物流数量', () => {
    renderInspector('clarifier');
    expect(screen.getByText(/进 \d+ · 出 \d+/)).toBeTruthy();
  });

  it('二沉池显示十层浓度剖面并标出进料层', () => {
    const profile = [8, 12, 30, 90, 400, 900, 1600, 2400, 3200, 4200];
    const snap = makeSnapshot({
      clarifier: { ...makeSnapshot().clarifier, profile, feedLayer: 5 },
    });
    const unit = findUnit(PLANT_TOPOLOGY, 'clarifier')!;
    render(
      <UnitInspector
        snap={snap}
        topo={PLANT_TOPOLOGY}
        unit={unit}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onChangeControls={vi.fn()}
        onEditTopology={vi.fn()}
      />,
    );
    const layers = document.querySelectorAll('.settler-layer');
    expect(layers).toHaveLength(10);
    expect(document.querySelectorAll('.settler-layer[data-feed="true"]')).toHaveLength(1);
    expect(screen.getByText(/底层浓度决定回流污泥浓度/)).toBeTruthy();
  });

  it('快照没有剖面时不画假数据', () => {
    renderInspector('clarifier');
    expect(document.querySelectorAll('.settler-layer')).toHaveLength(0);
  });
});
