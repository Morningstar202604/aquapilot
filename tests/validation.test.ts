import { describe, expect, it } from 'vitest';
import { PLANT_TOPOLOGY, ProcessTopology, validateTopology } from '../src/model/topology';
import { checkRunReadiness } from '../src/sim/topologyEngine';

/**
 * 拓扑校验回归测试。
 *
 * 每一条对应独立评审实测出的一个漏洞：
 * 流股不兼容能保存、重复连线不拦截、删掉鼓风机仍判可运行、
 * 第二个二沉池被引擎静默忽略。
 */

const clone = (): ProcessTopology => JSON.parse(JSON.stringify(PLANT_TOPOLOGY));
const errors = (t: ProcessTopology) => validateTopology(t).filter((i) => i.severity === 'error');

describe('拓扑校验（评审漏洞回归）', () => {
  it('标准厂无结构错误且可运行', () => {
    expect(errors(PLANT_TOPOLOGY)).toHaveLength(0);
    expect(checkRunReadiness(PLANT_TOPOLOGY).ready).toBe(true);
  });

  it('流股不兼容被拦截（原水直连二沉池）', () => {
    const t = clone();
    t.connections.push({
      id: 'bad-stream',
      from: { unit: 'screening', port: 'out' },
      to: { unit: 'clarifier', port: 'in' },
      stream: 'influent',
    });
    expect(errors(t).some((i) => i.code === 'STREAM_MISMATCH')).toBe(true);
  });

  it('重复连接被拦截', () => {
    const t = clone();
    t.connections.push({ ...t.connections[0], id: 'dup' });
    expect(errors(t).some((i) => i.code === 'DUPLICATE_LINK')).toBe(true);
  });

  it('删除鼓风机后不可运行', () => {
    const t = clone();
    t.units = t.units.filter((u) => u.kind !== 'blower');
    t.connections = t.connections.filter((c) => c.from.unit !== 'blower');
    const r = checkRunReadiness(t);
    expect(r.ready).toBe(false);
    expect(r.blockers.join()).toContain('鼓风机');
  });

  it('鼓风机存在但未接线也不可运行', () => {
    const t = clone();
    t.connections = t.connections.filter((c) => c.from.unit !== 'blower');
    const r = checkRunReadiness(t);
    expect(r.ready).toBe(false);
    expect(r.blockers.join()).toContain('没有连接到任何好氧池');
  });

  it('第二个二沉池被拒绝（而不是静默忽略）', () => {
    const t = clone();
    t.units.push({
      id: 'clar2',
      kind: 'clarifier',
      name: '二沉池 2',
      role: '泥水分离',
      area: 2400,
      depth: 4.5,
      ports: [
        { id: 'in', kind: 'in', stream: 'mixed_liquor' },
        { id: 'out', kind: 'out', stream: 'effluent' },
      ],
    });
    const r = checkRunReadiness(t);
    expect(r.ready).toBe(false);
    expect(r.blockers.join()).toContain('只支持一个二沉池');
  });

  it('缺氧池有独立的原水入口（多点进水）', () => {
    const anoxic = PLANT_TOPOLOGY.units.find((u) => u.id === 'anoxic')!;
    const feedPort = anoxic.ports.find((p) => p.id === 'feed');
    expect(feedPort).toBeDefined();
    expect(feedPort!.stream).toBe('influent');
  });
});
