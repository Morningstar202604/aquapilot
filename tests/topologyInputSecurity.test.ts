import { describe, expect, it } from 'vitest';
import { isSafeId, sanitizeTopologyInput } from '../src/model/topologyInput';
import { PLANT_TOPOLOGY } from '../src/model/topology';

/**
 * 用真实拓扑做变异，而不是手搓最小 JSON。
 *
 * 手搓版本会因缺必填字段被拒，那样「危险 id 被拒」的断言其实是
 * 因为别的原因通过——反证时整组测试不会变红，等于没测到目标规则。
 * 下面每个用例都从可被接受的真实拓扑出发，只改 id 及其引用。
 */
function withRenamedUnit(oldId: string, newId: string) {
  const clone = JSON.parse(JSON.stringify(PLANT_TOPOLOGY));
  clone.units[0].id = newId;
  clone.train = clone.train.map((t: string) => (t === oldId ? newId : t));
  for (const c of clone.connections) {
    if (c.from.unit === oldId) c.from.unit = newId;
    if (c.to.unit === oldId) c.to.unit = newId;
  }
  return clone;
}

function withRenamedPort(unitIndex: number, newId: string) {
  const clone = JSON.parse(JSON.stringify(PLANT_TOPOLOGY));
  const unit = clone.units[unitIndex];
  const oldPort = unit.ports[0].id;
  unit.ports[0].id = newId;
  for (const c of clone.connections) {
    if (c.from.unit === unit.id && c.from.port === oldPort) c.from.port = newId;
    if (c.to.unit === unit.id && c.to.port === oldPort) c.to.port = newId;
  }
  return clone;
}

/**
 * 原型污染防线。
 *
 * CodeQL 在 `delete positions[id]` / `delete routes[connId]` 处报了
 * remote-property-injection。这些 id 来自客户端提交的拓扑 JSON，
 * 旧校验只要求"非空且不超长"，所以 `__proto__` 能作为单元 id 通过，
 * 之后被当作对象键写入——这是一条真实可构造的原型污染路径，不是风格问题。
 */

describe('isSafeId', () => {
  it('接受界面生成的真实 id 形态', () => {
    for (const id of ['aerobic1', 'anoxic-1', 'unit_2', 'a1']) {
      expect(isSafeId(id)).toBe(true);
    }
  });

  it('拒绝原型链关键字（大小写不敏感）', () => {
    for (const id of ['__proto__', 'constructor', 'prototype', 'PROTOTYPE', '__PROTO__']) {
      expect(isSafeId(id)).toBe(false);
    }
  });

  it('拒绝非法字符与超长 id', () => {
    expect(isSafeId('a b')).toBe(false);
    expect(isSafeId('a/b')).toBe(false);
    expect(isSafeId('a.b')).toBe(false);
    expect(isSafeId('')).toBe(false);
    expect(isSafeId('x'.repeat(65))).toBe(false);
    expect(isSafeId(42)).toBe(false);
    expect(isSafeId(null)).toBe(false);
  });
});

describe('sanitizeTopologyInput 拒绝危险 id（基于真实拓扑变异）', () => {
  const firstId = PLANT_TOPOLOGY.units[0].id;

  it('基线：未变异的真实拓扑必须被接受', () => {
    expect(sanitizeTopologyInput(JSON.parse(JSON.stringify(PLANT_TOPOLOGY))).ok).toBe(true);
  });

  it('单元 id 为原型链关键字时整体被拒', () => {
    for (const bad of ['__proto__', 'constructor', 'prototype']) {
      expect(sanitizeTopologyInput(withRenamedUnit(firstId, bad)).ok).toBe(false);
    }
  });

  it('单元 id 含空白/斜杠等非法字符时被拒', () => {
    for (const bad of ['a b', 'a/b', 'a.b']) {
      expect(sanitizeTopologyInput(withRenamedUnit(firstId, bad)).ok).toBe(false);
    }
  });

  it('端口 id 同样受白名单约束', () => {
    expect(sanitizeTopologyInput(withRenamedPort(0, '__proto__')).ok).toBe(false);
  });
});
