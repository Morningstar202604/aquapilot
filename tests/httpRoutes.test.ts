import { describe, expect, it } from 'vitest';
import { isApiPath, isPublicApiPath, isReadMethod, pathnameOf, shouldFallbackToIndex } from '../src/server/httpRoutes';

/**
 * 路由判定回归。
 *
 * 这些用例锁定的是真实发生过的问题：
 * - `/api/nope` 掉进静态分支，返回 200 + index.html，客户端把 HTML 当 JSON 解析
 * - `/api/snapshot-evil` 被 startsWith 当成 `/api/snapshot`
 * - `/assets/missing.js` 回落到首页，浏览器把 HTML 当脚本执行
 */

describe('路径判定', () => {
  it('去掉查询串', () => {
    expect(pathnameOf('/api/metrics?format=json')).toBe('/api/metrics');
    expect(pathnameOf('/a?b=1?c=2')).toBe('/a');
    expect(pathnameOf(undefined)).toBe('/');
  });

  it('只有 /api 与 /api/ 前缀算 API', () => {
    expect(isApiPath('/api')).toBe(true);
    expect(isApiPath('/api/snapshot')).toBe(true);
    expect(isApiPath('/apiary')).toBe(false);
    expect(isApiPath('/')).toBe(false);
  });

  it('健康检查与 auth-required 免鉴权', () => {
    expect(isPublicApiPath('/api/health')).toBe(true);
    expect(isPublicApiPath('/api/auth-required')).toBe(true);
    expect(isPublicApiPath('/api/healthz')).toBe(false);
    expect(isPublicApiPath('/api/snapshot')).toBe(false);
  });

  it('只有无扩展名的前端路由才回落 index.html', () => {
    expect(shouldFallbackToIndex('/')).toBe(true);
    expect(shouldFallbackToIndex('/replay')).toBe(true);
    expect(shouldFallbackToIndex('/assets/index-abc123.js')).toBe(false);
    expect(shouldFallbackToIndex('/assets/missing.js')).toBe(false);
    expect(shouldFallbackToIndex('/favicon.ico')).toBe(false);
    expect(shouldFallbackToIndex('/api/nope')).toBe(false);
  });

  it('只读方法只认 GET/HEAD', () => {
    expect(isReadMethod('GET')).toBe(true);
    expect(isReadMethod('HEAD')).toBe(true);
    expect(isReadMethod('POST')).toBe(false);
    expect(isReadMethod('DELETE')).toBe(false);
    expect(isReadMethod(undefined)).toBe(false);
  });
});

describe('pathnameOf 规范化', () => {
  /**
   * 旧实现只切查询串，`//api/x` 和 `/API/x` 都不会命中 API 分支，
   * 会落到静态文件兜底返回 SPA 的 index.html（200 + HTML）。
   * 客户端把 HTML 当 JSON 解析时报的错与真实原因毫无关系。
   */
  it('折叠重复斜杠', () => {
    expect(pathnameOf('//api/snapshot')).toBe('/api/snapshot');
    expect(pathnameOf('///api/metrics')).toBe('/api/metrics');
  });

  it('解析 . 与 .. 段', () => {
    expect(pathnameOf('/api/./snapshot')).toBe('/api/snapshot');
    expect(pathnameOf('/x/../api/snapshot')).toBe('/api/snapshot');
    expect(pathnameOf('/api/a/../../api/snapshot')).toBe('/api/snapshot');
  });

  it('保留查询串以外的原样路径段', () => {
    expect(pathnameOf('/api/snapshot?from=1&to=2')).toBe('/api/snapshot');
    expect(pathnameOf('/')).toBe('/');
    expect(pathnameOf(undefined)).toBe('/');
  });

  it('顶层 .. 不会逃出根', () => {
    expect(pathnameOf('/../../etc/passwd')).toBe('/etc/passwd');
  });
});

describe('isApiPath 大小写与规范化', () => {
  it('大小写不敏感', () => {
    expect(isApiPath('/api/snapshot')).toBe(true);
    expect(isApiPath('/API/snapshot')).toBe(true);
    expect(isApiPath('/Api')).toBe(true);
  });

  it('规范化后的路径同样命中', () => {
    expect(isApiPath(pathnameOf('//api/snapshot'))).toBe(true);
    expect(isApiPath(pathnameOf('/x/../api/snapshot'))).toBe(true);
  });

  it('非 API 路径不受影响', () => {
    expect(isApiPath('/assets/index.js')).toBe(false);
    expect(isApiPath('/apix/snapshot')).toBe(false);
  });
});
