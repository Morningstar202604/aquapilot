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

  it('主序列单元显示沿程剖面，当前行唯一高亮', () => {
    const tanks = PLANT_TOPOLOGY.train.map((id, i) => ({
      id,
      name: id,
      short: id,
      kind: (i === 0 ? 'anaerobic' : i === 1 ? 'anoxic' : 'aerobic') as 'anaerobic' | 'anoxic' | 'aerobic',
      volume: 5000,
      cod: 30,
      nh: 5 - i,
      no3: 2 + i,
      tp: 0.2,
      do: i < 2 ? 0.05 : 2,
      mlss: 2500,
      alkalinity: 200,
      temperature: 20,
      codRemoved: 0,
      nhRemoved: 0,
      o2Demand: 0,
      klaUsed: 0,
    }));
    const snap = makeSnapshot({ tanks });
    const unit = findUnit(PLANT_TOPOLOGY, 'aerobic2')!;
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
    expect(screen.getByText(/主序列沿程（5 级）/)).toBeTruthy();
    expect(document.querySelectorAll('.train-row:not(.train-head)')).toHaveLength(5);
    expect(document.querySelectorAll('.train-row[data-current="true"]')).toHaveLength(1);
  });

  it('非主序列单元（鼓风机）不显示沿程剖面', () => {
    const tanks = PLANT_TOPOLOGY.train.map((id) => ({
      id,
      name: id,
      short: id,
      kind: 'aerobic' as const,
      volume: 5000,
      cod: 30,
      nh: 1,
      no3: 8,
      tp: 0.2,
      do: 2,
      mlss: 2500,
      alkalinity: 200,
      temperature: 20,
      codRemoved: 0,
      nhRemoved: 0,
      o2Demand: 0,
      klaUsed: 0,
    }));
    const unit = findUnit(PLANT_TOPOLOGY, 'blower')!;
    render(
      <UnitInspector
        snap={makeSnapshot({ tanks })}
        topo={PLANT_TOPOLOGY}
        unit={unit}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onChangeControls={vi.fn()}
        onEditTopology={vi.fn()}
      />,
    );
    expect(screen.queryByText(/主序列沿程/)).toBeNull();
  });

  it('快照没有实时反应器状态时不显示沿程剖面（只显示拓扑清单没有意义）', () => {
    renderInspector('aerobic1');
    expect(screen.queryByText(/主序列沿程/)).toBeNull();
  });
});
