/**
 * HTTP 路由判定（纯函数，便于单测）。
 *
 * 为什么单独拆出来：`src/server/index.ts` 里的路由是一串 startsWith，
 * 这类前缀匹配会把 `/api/snapshot-evil` 当成 `/api/snapshot`，而且未知
 * `/api/*` 会掉进静态文件分支返回 index.html（200），客户端拿到 HTML
 * 当 JSON 解析。判定逻辑必须是可测的纯函数，而不是埋在 IO 代码里。
 */

const API_PREFIX = '/api/';

/** 只取路径部分，去掉查询串；畸形 URL 原样返回 */
export function pathnameOf(url: string | undefined): string {
  const raw = url ?? '/';
  const q = raw.indexOf('?');
  return q >= 0 ? raw.slice(0, q) : raw;
}

export function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith(API_PREFIX);
}

/** 健康检查与「是否需要认证」必须免鉴权，否则前端无法判断该不该弹登录框 */
export function isPublicApiPath(pathname: string): boolean {
  return pathname === '/api/health' || pathname === '/api/auth-required';
}

/**
 * 静态资源是否应该回落到 index.html。
 *
 * 只有「看起来像前端路由」的路径才回落（无扩展名）；
 * `/assets/missing.js` 这类带扩展名的请求必须 404，
 * 否则浏览器会把 HTML 当 JS 执行，报一堆看不懂的语法错误。
 */
export function shouldFallbackToIndex(pathname: string): boolean {
  if (pathname === '/') return true;
  if (isApiPath(pathname)) return false;
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  return !lastSegment.includes('.');
}

/** 只读端点只接受 GET/HEAD */
export function isReadMethod(method: string | undefined): boolean {
  return method === 'GET' || method === 'HEAD';
}
