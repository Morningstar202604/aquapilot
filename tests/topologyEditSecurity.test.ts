import { describe, expect, it } from 'vitest';
import { deleteUnits, safeDelete, setRoute } from '../src/model/topologyEdit';
import { PLANT_TOPOLOGY } from '../src/model/topology';

/**
 * 原型污染防线（客户端编辑路径）。
 *
 * `delete positions[id]` / `delete routes[connectionId]` 的键来自拓扑文档。
 * 键为 `__proto__` 时删除作用在原型链上而不是自有属性——对象看起来没变化，
 * 但 `Object.prototype` 可能被改写，影响所有对象。
 */

describe('safeDelete', () => {
  it('删除普通自有属性', () => {
    const obj: Record<string, number> = { a: 1, b: 2 };
    safeDelete(obj, 'a');
    expect(obj).toEqual({ b: 2 });
  });

  it('拒绝原型链关键字，且不改动原型', () => {
    const obj: Record<string, number> = { a: 1 };
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      safeDelete(obj, key);
    }
    expect(obj).toEqual({ a: 1 });
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
  });

  it('不删除继承属性', () => {
    const obj = Object.create({ inherited: 1 }) as Record<string, number>;
    obj.own = 2;
    safeDelete(obj, 'inherited');
    expect((obj as unknown as { inherited: number }).inherited).toBe(1);
  });
});

describe('deleteUnits 不接受原型污染键', () => {
  it('删除真实单元仍然生效（回归）', () => {
    const id = PLANT_TOPOLOGY.units[0].id;
    const next = deleteUnits(PLANT_TOPOLOGY, [id]);
    expect(next.units.some((u) => u.id === id)).toBe(false);
  });

  it('传入 __proto__ 不会污染 Object.prototype，也不破坏拓扑', () => {
    const next = deleteUnits(PLANT_TOPOLOGY, ['__proto__', 'constructor', 'prototype']);
    expect(next.units.length).toBe(PLANT_TOPOLOGY.units.length);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('setRoute 不接受原型污染键', () => {
  it('__proto__ 作为连线 id 不改变 routes', () => {
    const next = setRoute(PLANT_TOPOLOGY, '__proto__', [{ x: 0, y: 0 }]);
    const routes = (next.routes ?? {}) as Record<string, unknown>;
    expect(Object.keys(routes)).not.toContain('__proto__');
  });
});
