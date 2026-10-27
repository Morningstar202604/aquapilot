import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import { TopologyStore } from '../src/server/topologyStore';

/**
 * 拓扑快照的持久化。
 *
 * 真实缺陷：服务重启后编排成果全部丢失、静默回到标准厂。
 * 这里锁三件事：能存能取、损坏文件回退而不是崩、非法拓扑被拒。
 */

let dir: string;
let path: string;
let historyPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aquapilot-topo-'));
  path = join(dir, 'topology.json');
  /**
   * 必须同时给 historyPath。
   *
   * `new TopologyStore(path)` 的第二个参数默认是真实的 `data/topology-history.json`，
   * 只传第一个参数会让每个测试用例都往开发者工作区写版本历史——
   * 实测该文件被测试数据撑到 66 KB（含"第一版/第二版/自定义厂"）。
   */
  historyPath = join(dir, 'topology-history.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('TopologyStore', () => {
  it('没有文件时使用标准厂', () => {
    const store = new TopologyStore(path, historyPath);
    const r = store.load();
    expect(r.restored).toBe(false);
    expect(r.topology.id).toBe(PLANT_TOPOLOGY.id);
  });

  it('保存后能原样读回（含坐标与折点）', () => {
    const store = new TopologyStore(path, historyPath);
    const topo = {
      ...PLANT_TOPOLOGY,
      name: '自定义厂',
      positions: { anaerobic: { x: 300, y: 120 } },
      routes: { 'c-aerobic1-aerobic2': [{ x: 1100, y: 180 }] },
    };
    store.save(topo, 3);
    const r = new TopologyStore(path, historyPath).load();
    expect(r.restored).toBe(true);
    expect(r.topology.name).toBe('自定义厂');
    expect(r.topology.positions?.anaerobic).toEqual({ x: 300, y: 120 });
    expect(r.topology.routes?.['c-aerobic1-aerobic2']).toEqual([{ x: 1100, y: 180 }]);
  });

  it('损坏文件回退到标准厂并给出告警', () => {
    writeFileSync(path, '{not json', 'utf8');
    const r = new TopologyStore(path, historyPath).load();
    expect(r.restored).toBe(false);
    expect(r.warning).toBeTruthy();
    expect(r.topology.units.length).toBe(PLANT_TOPOLOGY.units.length);
  });

  it('结构非法的快照被拒绝（不能让坏图进入引擎）', () => {
    writeFileSync(path, JSON.stringify({ savedAt: '', revision: 1, topology: { units: [null] } }), 'utf8');
    const r = new TopologyStore(path, historyPath).load();
    expect(r.restored).toBe(false);
    expect(r.warning).toContain('不合法');
  });

  it('覆盖保存后只保留最新一份', () => {
    const store = new TopologyStore(path, historyPath);
    store.save({ ...PLANT_TOPOLOGY, name: '第一版' }, 1);
    store.save({ ...PLANT_TOPOLOGY, name: '第二版' }, 2);
    const r = new TopologyStore(path, historyPath).load();
    expect(r.topology.name).toBe('第二版');
  });
});
