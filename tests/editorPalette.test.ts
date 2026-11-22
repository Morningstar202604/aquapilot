import { describe, expect, it } from 'vitest';
import {
  PALETTE,
  PALETTE_GROUPS,
  duplicateTopologyUnit,
  insertPaletteUnit,
  nextUnitId,
} from '../src/model/editorPalette';
import { PLANT_TOPOLOGY, findUnit } from '../src/model/topology';

const clone = () => structuredClone(PLANT_TOPOLOGY);
const entry = (kind: string) => PALETTE.find((p) => p.kind === kind)!;

describe('编辑器组件库', () => {
  it('分组从条目派生，没有空组', () => {
    expect(PALETTE_GROUPS).toEqual(['预处理', '生物处理', '固液分离', '调蓄', '公用工程', '污泥']);
    for (const group of PALETTE_GROUPS) {
      expect(PALETTE.some((p) => p.group === group)).toBe(true);
    }
  });

  it('非生物单元只新增单元，不改主序列', () => {
    const before = clone();
    const result = insertPaletteUnit(before, entry('screening'));
    expect(result.id).toBe('screening1');
    expect(result.topology.units).toHaveLength(before.units.length + 1);
    expect(result.topology.train).toEqual(before.train);
    expect(result.topology.connections).toHaveLength(before.connections.length);
    expect(findUnit(result.topology, result.id)?.kind).toBe('screening');
  });

  it('生物池自动接入主序列，并把原下游改接到新池', () => {
    const before = clone();
    const last = before.train[before.train.length - 1];
    const downstream = before.connections.find((c) => c.from.unit === last && !c.recycle)!;
    const result = insertPaletteUnit(before, entry('aerobic'));
    const id = result.id;
    expect(id).toBe(nextUnitId(before, 'aerobic'));
    expect(result.topology.train[result.topology.train.length - 1]).toBe(id);
    expect(result.topology.connections).toHaveLength(before.connections.length + 1);
    expect(result.topology.connections.find((c) => c.id === downstream.id)?.from.unit).toBe(id);
    expect(result.topology.connections.some((c) => c.from.unit === last && c.to.unit === id)).toBe(true);
  });

  it('复制单元保留规格，位置右下偏移并追加到主序列', () => {
    const before = clone();
    const result = duplicateTopologyUnit(before, 'aerobic1')!;
    expect(result).not.toBeNull();
    const copy = findUnit(result.topology, result.id)!;
    expect(copy.name).toBe(`${findUnit(before, 'aerobic1')!.name}·副本`);
    expect(copy.volume).toBe(findUnit(before, 'aerobic1')!.volume);
    expect(result.topology.positions?.[result.id]).toEqual({ x: 120, y: 120 });
    expect(result.topology.train[result.topology.train.length - 1]).toBe(result.id);
  });

  it('复制不存在的单元返回 null', () => {
    expect(duplicateTopologyUnit(clone(), 'nope')).toBeNull();
  });
});
