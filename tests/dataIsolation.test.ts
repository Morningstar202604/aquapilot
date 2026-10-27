import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 测试与工具脚本不得写开发者真实的 data/ 目录。
 *
 * 真实污染（2026-10-27 实测）：`data/topology-history.json` 被撑到 66 KB，
 * 里面是「第一版 / 第二版 / 自定义厂」这类测试厂。三个来源：
 * 1. `npm run e2e` 点了「应用到仿真」——`AQUAPILOT_PERSIST=0` 只关 SQLite；
 * 2. `npm run media` 同理；
 * 3. `tests/topologyStore.test.ts` 只传了第一个构造参数，历史路径回落到默认值。
 *
 * 这里用源码扫描锁住：任何会起服务端或构造存储的入口，都必须显式指定
 * 临时路径，不能依赖默认的 `data/`。
 */

const read = (p: string) => fs.readFileSync(path.join(...p.split('/')), 'utf8');

describe('运行隔离', () => {
  it('e2e 脚本把四类配置都指向临时目录', () => {
    const src = read('scripts/e2e-ci.ts');
    for (const key of [
      'AQUAPILOT_TOPOLOGY',
      'AQUAPILOT_TOPOLOGY_HISTORY',
      'AQUAPILOT_LLM_CONFIG',
      'AQUAPILOT_AGENT_CONFIG',
    ]) {
      expect(src, `e2e 未隔离 ${key}`).toContain(key);
    }
    expect(src).toMatch(/out\/e2e-data/);
  });

  it('media 脚本同样隔离（它要开持久化，更容易写脏）', () => {
    const src = read('scripts/media.ts');
    for (const key of [
      'AQUAPILOT_TOPOLOGY',
      'AQUAPILOT_TOPOLOGY_HISTORY',
      'AQUAPILOT_LLM_CONFIG',
      'AQUAPILOT_AGENT_CONFIG',
    ]) {
      expect(src, `media 未隔离 ${key}`).toContain(key);
    }
  });

  it('TopologyStore 的测试都传了显式历史路径', () => {
    const files = ['tests/topologyStore.test.ts', 'tests/topologyHistory.test.ts'];
    for (const file of files) {
      const src = read(file);
      // 先去掉注释行，避免把说明文字里的示例当成真实调用
      const code = src
        .split(String.fromCharCode(10))
        .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
        .join(String.fromCharCode(10));
      const calls = code.match(/new TopologyStore\([^)]*\)/g) ?? [];
      expect(calls.length, `${file} 没有构造任何 store`).toBeGreaterThan(0);
      for (const call of calls) {
        // 单参数构造 = 历史路径回落到真实 data/
        expect(call, `${file}: ${call}`).toMatch(/new TopologyStore\([^,)]+,/);
      }
    }
  });

  it('运行结束后 data/ 里没有测试拓扑残留', () => {
    // 该断言在测试进程内跑：若前序测试写过真实路径，这里能看到
    const dataDir = path.join('data');
    for (const name of ['topology.json', 'topology-history.json']) {
      const p = path.join(dataDir, name);
      if (!fs.existsSync(p)) continue;
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as { versions?: { name?: string }[]; name?: string };
      const names = (parsed.versions ?? []).map((v) => v.name ?? '').concat(parsed.name ?? '');
      expect(names.join(' '), `data/${name} 含测试厂数据`).not.toMatch(/第一版|第二版|自定义厂|持久化测试厂/);
    }
  });
});
