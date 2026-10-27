import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import { MAX_TOPOLOGY_VERSIONS, TopologyStore } from '../src/server/topologyStore';

/**
 * 拓扑版本历史。
 *
 * 需求：每次应用/切换模板/回滚都要留痕，能列出版本并回滚到任意一版。
 * 历史必须是「只增不减的 revision」——回滚不是把指针拨回去，而是以旧内容
 * 创建一个新版本，否则客户端无法判断新旧、审计链也会断。
 */

let dir: string;
let path: string;
let historyPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aquapilot-topoh-'));
  path = join(dir, 'topology.json');
  historyPath = join(dir, 'topology-history.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const store = () => new TopologyStore(path, historyPath);

const topo = (name: string, volume = 5000) => {
  const t = structuredClone(PLANT_TOPOLOGY);
  t.name = name;
  const a1 = t.units.find((u) => u.id === 'aerobic1')!;
  a1.volume = volume;
  return t;
};

describe('版本记录', () => {
  it('保存后出现在历史里，最新在前', () => {
    const s = store();
    s.save(topo('v1'), 1, '应用拓扑');
    s.save(topo('v2'), 2, '切换模板');
    const history = s.history();
    expect(history.map((h) => h.revision)).toEqual([2, 1]);
    expect(history[0].name).toBe('v2');
    expect(history[0].label).toBe('切换模板');
    expect(history[0].units).toBe(PLANT_TOPOLOGY.units.length);
  });

  it('同一 revision 重复保存只保留一条（幂等）', () => {
    const s = store();
    s.save(topo('v1'), 1, '应用拓扑');
    s.save(topo('v1-again'), 1, '应用拓扑');
    const history = s.history();
    expect(history).toHaveLength(1);
    expect(history[0].name).toBe('v1-again');
  });

  it('超过上限时丢掉最旧的版本，保留最新 N 条', () => {
    const s = store();
    for (let i = 1; i <= MAX_TOPOLOGY_VERSIONS + 5; i += 1) s.save(topo(`v${i}`), i, '应用拓扑');
    const history = s.history();
    expect(history).toHaveLength(MAX_TOPOLOGY_VERSIONS);
    expect(history[0].revision).toBe(MAX_TOPOLOGY_VERSIONS + 5);
    expect(history.at(-1)!.revision).toBe(6);
  });

  it('能按 revision 取回完整拓扑', () => {
    const s = store();
    s.save(topo('v1', 4000), 1, '应用拓扑');
    s.save(topo('v2', 6000), 2, '应用拓扑');
    const v1 = s.version(1);
    expect(v1).not.toBeNull();
    expect(v1!.name).toBe('v1');
    expect(v1!.units.find((u) => u.id === 'aerobic1')!.volume).toBe(4000);
    expect(s.version(99)).toBeNull();
  });

  it('历史文件损坏时返回空列表而不是抛错', () => {
    const s = store();
    s.save(topo('v1'), 1, '应用拓扑');
    // 破坏历史文件
    writeFileSync(historyPath, '{broken', 'utf8');
    expect(new TopologyStore(path, historyPath).history()).toEqual([]);
  });

  it('历史条目里的拓扑同样过输入校验，坏条目被丢弃', () => {
    const s = store();
    s.save(topo('v1'), 1, '应用拓扑');
    const raw = JSON.parse(readFileSync(historyPath, 'utf8')) as { versions: unknown[] };
    raw.versions.push({ revision: 9, savedAt: new Date().toISOString(), label: 'x', topology: { units: [null] } });
    writeFileSync(historyPath, JSON.stringify(raw), 'utf8');
    const history = new TopologyStore(path, historyPath).history();
    expect(history.some((h) => h.revision === 9)).toBe(false);
    expect(history.some((h) => h.revision === 1)).toBe(true);
  });
});

describe('活动版本与历史解耦', () => {
  it('load() 只读活动拓扑，不读历史', () => {
    const s = store();
    s.save(topo('v1'), 1, '应用拓扑');
    s.save(topo('v2'), 2, '应用拓扑');
    expect(new TopologyStore(path, historyPath).load().topology.name).toBe('v2');
    expect(new TopologyStore(path, historyPath).history()).toHaveLength(2);
  });

  it('回滚语义：以旧内容保存为新 revision，历史继续增长', () => {
    const s = store();
    s.save(topo('v1'), 1, '应用拓扑');
    s.save(topo('v2'), 2, '应用拓扑');
    const old = s.version(1)!;
    s.save({ ...old, name: 'v1 (回滚)' }, 3, '回滚到 v1');
    const history = s.history();
    expect(history.map((h) => h.revision)).toEqual([3, 2, 1]);
    expect(history[0].label).toBe('回滚到 v1');
    expect(s.load().topology.name).toBe('v1 (回滚)');
  });
});

describe('启动基线', () => {
  it('seedBaseline 写入历史但不改活动文件', () => {
    const s = store();
    s.seedBaseline(topo('baseline'), 1, '启动基线');
    expect(s.history().map((h) => h.revision)).toEqual([1]);
    expect(s.history()[0].label).toBe('启动基线');
    // 活动文件不存在 → load() 仍回退标准厂
    expect(new TopologyStore(path, historyPath).load().restored).toBe(false);
  });

  it('seedBaseline 幂等：同一 revision 不重复写入，也不覆盖已有版本', () => {
    const s = store();
    s.save(topo('v1-applied'), 1, '应用自定义拓扑');
    s.seedBaseline(topo('later-baseline'), 1, '启动基线');
    const history = s.history();
    expect(history).toHaveLength(1);
    expect(history[0].label).toBe('应用自定义拓扑');
    expect(history[0].name).toBe('v1-applied');
  });
});
