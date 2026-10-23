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
