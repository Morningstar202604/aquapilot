import { describe, expect, it } from 'vitest';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import { sanitizeTopologyInput } from '../src/model/topologyInput';

/**
 * 拓扑输入校验（信任边界）。
 *
 * WebSocket 帧里的 topology 是任意 JSON：一个 null 单元、NaN 容积或超长
 * 数组都会进入引擎，轻则整厂停摆，重则每 tick 抛错。这里逐类锁定拒绝行为。
 */

const clone = () => JSON.parse(JSON.stringify(PLANT_TOPOLOGY));

const ok = (value: unknown) => {
  const r = sanitizeTopologyInput(value);
  if (!r.ok) throw new Error(`期望通过但被拒绝：${r.error}`);
  return r.topology;
};

describe('拓扑输入校验', () => {
  it('接受标准厂并保留结构', () => {
    const topo = ok(clone());
    expect(topo.units).toHaveLength(PLANT_TOPOLOGY.units.length);
    expect(topo.connections).toHaveLength(PLANT_TOPOLOGY.connections.length);
    expect(topo.train).toEqual(PLANT_TOPOLOGY.train);
  });

  it('拒绝 null / 数组 / 非对象', () => {
    expect(sanitizeTopologyInput(null).ok).toBe(false);
    expect(sanitizeTopologyInput([]).ok).toBe(false);
    expect(sanitizeTopologyInput('x').ok).toBe(false);
  });

  it('拒绝 units 里的 null 元素', () => {
    const t = clone();
    t.units.push(null);
    expect(sanitizeTopologyInput(t).ok).toBe(false);
  });

  it('拒绝未知单元类型', () => {
    const t = clone();
    t.units[0].kind = 'nuclear';
    expect(sanitizeTopologyInput(t).ok).toBe(false);
  });

  it('拒绝 NaN / 无穷 / 负容积', () => {
    for (const volume of [Number.NaN, Infinity, -1]) {
      const t = clone();
      t.units.find((u: { id: string }) => u.id === 'aerobic1').volume = volume;
      expect(sanitizeTopologyInput(t).ok).toBe(false);
    }
  });

  it('拒绝不存在的端口引用', () => {
    const t = clone();
    t.connections[0].from.port = 'ghost';
    expect(sanitizeTopologyInput(t).ok).toBe(false);
  });

  it('拒绝未定义的主序列单元', () => {
    const t = clone();
    t.train.push('ghost');
    expect(sanitizeTopologyInput(t).ok).toBe(false);
  });

  it('拒绝超量单元（防止内存与求解被拖垮）', () => {
    const t = clone();
    const unit = t.units[0];
    t.units = Array.from({ length: 81 }, (_, i) => ({ ...unit, id: `u${i}`, name: `u${i}` }));
    t.connections = [];
    t.train = [];
    expect(sanitizeTopologyInput(t).ok).toBe(false);
  });

  it('坐标被夹紧/取整，脏坐标不进入布局', () => {
    const t = clone();
    t.positions = { inlet: { x: Number.NaN, y: 1e12 }, aerobic1: { x: 12.7, y: 40.2 } };
    const topo = ok(t);
    expect(topo.positions?.inlet).toBeUndefined();
    expect(topo.positions?.aerobic1).toEqual({ x: 13, y: 40 });
  });

  it('折点被限制数量并取整，未知连线被丢弃', () => {
    const t = clone();
    t.routes = {
      'c-aerobic1-aerobic2': Array.from({ length: 30 }, () => ({ x: 10.4, y: 20.6 })),
      ghost: [{ x: 1, y: 2 }],
    };
    const topo = ok(t);
    expect(topo.routes?.['c-aerobic1-aerobic2']).toHaveLength(8);
    expect(topo.routes?.['c-aerobic1-aerobic2'][0]).toEqual({ x: 10, y: 21 });
    expect(topo.routes?.ghost).toBeUndefined();
  });

  it('拒绝超长 id / 名称', () => {
    const t = clone();
    t.units[0].id = 'x'.repeat(200);
    expect(sanitizeTopologyInput(t).ok).toBe(false);
  });

  it('拒绝端口方向非法', () => {
    const t = clone();
    t.units[0].ports[0].kind = 'sideways';
    expect(sanitizeTopologyInput(t).ok).toBe(false);
  });
});
