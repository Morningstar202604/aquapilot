import { describe, expect, it } from 'vitest';
import { CONTROL_BOUNDS } from '../src/sim/config';
import { PLANT_TOPOLOGY, UNIT_KINDS } from '../src/model/topology';
import { PRESETS, buildPreset } from '../src/model/presets';

/**
 * 干预清单的完整性与可写性。
 *
 * 真实缺陷：`aerationOn` / `pumpSpeed` 被写进单元干预清单与编辑器调色板，
 * 但 `ControlSettings` 与 `CONTROL_BOUNDS` 都没有这两个键——检视器只能
 * 在渲染时显式过滤掉，等于对外宣布了一个"点了没反应"的控件。
 * 这里锁死：清单里的每个键必须能通过控制通道真正写入。
 */

describe('干预清单', () => {
  it('每个干预键都能在 CONTROL_BOUNDS 里找到（即真的可写）', () => {
    const writable = new Set(Object.keys(CONTROL_BOUNDS));
    for (const unit of PLANT_TOPOLOGY.units) {
      for (const key of unit.interventions ?? []) {
        expect(writable.has(key), `${unit.name} 声明了不可写的干预 ${key}`).toBe(true);
      }
    }
  });

  it('三个模板的干预清单同样只含可写键', () => {
    const writable = new Set(Object.keys(CONTROL_BOUNDS));
    for (const preset of PRESETS) {
      for (const unit of buildPreset(preset).units) {
        for (const key of unit.interventions ?? []) {
          expect(writable.has(key), `${preset.name}/${unit.name}: ${key}`).toBe(true);
        }
      }
    }
  });

  it('每个单元类型都有展示元数据（含新增类型）', async () => {
    const { UNIT_META } = await import('../src/shared/streamMeta');
    for (const kind of UNIT_KINDS) expect(UNIT_META[kind], kind).toBeTruthy();
  });

  it('检视器不再需要按名字排除幽灵键', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/client/components/UnitInspector.tsx', 'utf8');
    // 允许注释里提到历史包袱，但不能存在 `k !== 'xxx'` 这种按名排除的运行时过滤
    expect(src).not.toMatch(/!==\s*'(aerationOn|pumpSpeed)'/);
    expect(src).toMatch(/k in CONTROL_BOUNDS/);
  });
});
