import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_VERSION } from '../src/shared/version';

/**
 * 版本单一事实源。
 *
 * 这条测试存在的原因是一个真实缺陷：MCP 的 serverInfo 曾用
 * `process.env.npm_package_version ?? '0.6.0'`，非 `npm run` 启动时
 * 一律回落 0.6.0，而当时实际版本是 0.7.2。运行时常量改了之后，
 * 唯一能防止再次漂移的就是这里——直接读 package.json 比对。
 */
describe('APP_VERSION', () => {
  it('是三段式 semver', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('与 package.json 完全一致', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
    expect(APP_VERSION).toBe(pkg.version);
  });

  it('与 CITATION.cff 一致', () => {
    const cff = readFileSync('CITATION.cff', 'utf8');
    const declared = cff.match(/^version:\s*"?([^"\n]+)"?\s*$/m)?.[1];
    expect(declared).toBe(APP_VERSION);
  });

  it('与 CHANGELOG 顶部版本一致', () => {
    const log = readFileSync('CHANGELOG.md', 'utf8');
    const first = log.match(/^## \[([^\]]+)\]/m)?.[1];
    expect(first).toBe(APP_VERSION);
  });
});
