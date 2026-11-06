import { describe, expect, it } from 'vitest';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import {
  MAX_IMPORT_BYTES,
  TOPOLOGY_FORMAT,
  TOPOLOGY_FORMAT_VERSION,
  exportTopology,
  importTopology,
  suggestFileName,
} from '../src/model/topologyExchange';

/**
 * 拓扑交换格式测试。
 *
 * 重点不是"能导出能导入"，而是**坏输入必须被拒**：
 * 这份文件的输入来源是用户剪贴板与磁盘，任何"尽力修复"都会让
 * 坏拓扑进引擎，在 tick 里抛错。
 */

const roundTrip = () => exportTopology(PLANT_TOPOLOGY, '0.8.0');

describe('exportTopology', () => {
  it('产出带格式标识与版本的合法 JSON', () => {
    const parsed = JSON.parse(roundTrip()) as Record<string, unknown>;
    expect(parsed.format).toBe(TOPOLOGY_FORMAT);
    expect(parsed.formatVersion).toBe(TOPOLOGY_FORMAT_VERSION);
    expect(typeof parsed.exportedAt).toBe('string');
    expect(parsed.appVersion).toBe('0.8.0');
    expect(parsed.topology).toBeTruthy();
  });

  it('末尾带换行（POSIX 文本约定，diff 友好）', () => {
    expect(roundTrip().endsWith('\n')).toBe(true);
  });

  it('使用 2 空格缩进（这份文件主要给人读）', () => {
    expect(roundTrip()).toContain('\n  "format"');
  });
});

describe('importTopology', () => {
  it('导出再导入得到等价拓扑', () => {
    const r = importTopology(roundTrip());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.topology.units).toHaveLength(PLANT_TOPOLOGY.units.length);
    expect(r.topology.connections).toHaveLength(PLANT_TOPOLOGY.connections.length);
    expect(r.topology.train).toEqual(PLANT_TOPOLOGY.train);
    expect(r.meta.appVersion).toBe('0.8.0');
  });

  it('接受裸 ProcessTopology（第三方工具或手写）', () => {
    const r = importTopology(JSON.stringify(PLANT_TOPOLOGY));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.meta.appVersion).toBe('');
  });

  it('空内容被拒', () => {
    const r = importTopology('   ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('空');
  });

  it('非 JSON 被拒，错误信息里带原因', () => {
    const r = importTopology('{ not json');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('JSON');
  });

  it('顶层是数组时被拒', () => {
    const r = importTopology('[1,2,3]');
    expect(r.ok).toBe(false);
  });

  it('未知 format 被拒', () => {
    const r = importTopology(JSON.stringify({ format: 'other.tool', topology: PLANT_TOPOLOGY }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('不认识');
  });

  it('未来版本的 formatVersion 被拒（而不是猜着解析）', () => {
    const env = JSON.parse(roundTrip()) as Record<string, unknown>;
    env.formatVersion = TOPOLOGY_FORMAT_VERSION + 1;
    const r = importTopology(JSON.stringify(env));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('高于当前支持');
  });

  it('formatVersion 非正整数被拒', () => {
    const env = JSON.parse(roundTrip()) as Record<string, unknown>;
    env.formatVersion = 1.5;
    expect(importTopology(JSON.stringify(env)).ok).toBe(false);
  });

  it('信封缺 topology 字段被拒', () => {
    const r = importTopology(JSON.stringify({ format: TOPOLOGY_FORMAT, formatVersion: 1 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('topology');
  });

  it('超过大小上限被拒', () => {
    const huge = 'x'.repeat(MAX_IMPORT_BYTES + 1);
    const r = importTopology(huge);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('上限');
  });

  it('结构损坏（单元缺端口）被 sanitize 拦住', () => {
    const broken = JSON.parse(roundTrip()) as { topology: { units: { ports: unknown }[] } };
    broken.topology.units[0].ports = 'nope';
    expect(importTopology(JSON.stringify(broken)).ok).toBe(false);
  });

  it('引用不存在的单元被拒', () => {
    const broken = JSON.parse(roundTrip()) as { topology: { train: string[] } };
    broken.topology.train = ['ghost-unit'];
    const r = importTopology(JSON.stringify(broken));
    expect(r.ok).toBe(false);
  });

  it('主序列重复引用被拒', () => {
    const broken = JSON.parse(roundTrip()) as { topology: { train: string[] } };
    const first = broken.topology.train[0];
    broken.topology.train = [first, first];
    const r = importTopology(JSON.stringify(broken));
    expect(r.ok).toBe(false);
  });
});

describe('suggestFileName', () => {
  it('中文名保留，空格转连字符', () => {
    expect(suggestFileName('澄川 A²/O 再生水厂')).toBe('aquapilot-澄川-A²O-再生水厂.json');
  });

  it('去掉 Windows 非法字符', () => {
    expect(suggestFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('aquapilot-abcdefghij.json');
  });

  it('空名回落到默认', () => {
    expect(suggestFileName('   ')).toBe('aquapilot-topology.json');
  });

  it('超长名被截断', () => {
    const name = suggestFileName('长'.repeat(200));
    expect(name.length).toBeLessThanOrEqual('aquapilot-'.length + 60 + '.json'.length);
  });
});
