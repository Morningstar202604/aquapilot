import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 文档数字与基准表对账。
 *
 * README headline 曾写「TSS +5.1%」，而 docs/BENCHMARKS.md 与实测都是
 * −7.4%；CI 只锁测试数量徽章，锁不住指标数字。这组断言故意写死当前
 * 基准值：重新标定导致数字变化时，测试会失败并提醒同步两份 README，
 * 而不是让旧数字继续对外。
 */
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('README 基准数字', () => {
  it('英文 README 引用当前 BSM1 偏差，不再出现旧的 +5.1%', () => {
    const readme = read('README.md');
    expect(readme).toContain('S_NH at **−10.8%**');
    expect(readme).toContain('TSS sits at **−7.4%**');
    expect(readme).not.toContain('+5.1%');
  });

  it('中文 README 与英文口径一致', () => {
    const readme = read('README.zh-CN.md');
    expect(readme).toContain('S_NH **−10.8%**');
    expect(readme).toContain('TSS 为 **−7.4%**');
    expect(readme).not.toContain('+5.1%');
  });

  it('BENCHMARKS 表保留同样的偏差与门槛', () => {
    const bench = read('docs/BENCHMARKS.md');
    expect(bench).toMatch(/S_NH.*−10\.8 %.*±25 %/);
    expect(bench).toMatch(/TSS.*−7\.4 %/);
  });
});
