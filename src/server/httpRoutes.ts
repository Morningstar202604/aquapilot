/**
 * HTTP 路由判定（纯函数，便于单测）。
 *
 * 为什么单独拆出来：`src/server/index.ts` 里的路由是一串 startsWith，
 * 这类前缀匹配会把 `/api/snapshot-evil` 当成 `/api/snapshot`，而且未知
 * `/api/*` 会掉进静态文件分支返回 index.html（200），客户端拿到 HTML
 * 当 JSON 解析。判定逻辑必须是可测的纯函数，而不是埋在 IO 代码里。
 */

const API_PREFIX = '/api/';

/**
 * 规范化请求路径，返回**用于路由判定**的路径。
 *
 * 只去查询串是不够的：Node 的 `req.url` 是客户端原始写法，
 * `//api/snapshot`、`/x/../api/snapshot`、`/API/snapshot` 都能到达这里。
 * 旧实现按字面前缀判断，于是：
 * - `//api/*` 与 `/API/*` 不被认作 API → 落到静态分支 → 返回 SPA 的
 *   index.html 且 200。客户端 `fetch('/api/...')` 一旦写成双斜杠就会拿到
 *   HTML 当 JSON 解析，报一个与真实原因无关的语法错误；更糟的是
 *   任何「按 /api 前缀做鉴权」的中间件都会漏掉这些写法。
 * - `/x/../api/snapshot` 依赖下游是否规范化，行为不可预期。
 *
 * 处理：补齐前导斜杠 → 折叠重复斜杠 → 解析 `.`/`..` → 统一小写比较用前缀。
 * 不做 URL 解码（解码由静态文件层负责，避免二次解码绕过）。
 */
export function pathnameOf(url: string | undefined): string {
  const raw = url ?? '/';
  const q = raw.indexOf('?');
  const path = q >= 0 ? raw.slice(0, q) : raw;
  // 折叠重复斜杠，但不能把开头的 "//" 当成协议相对 URL
  const collapsed = path.replace(/\/{2,}/g, '/');
  const segments: string[] = [];
  for (const segment of collapsed.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return '/' + segments.join('/');
}

/** 大小写不敏感：`/API/snapshot` 与 `/api/snapshot` 必须走同一条路径 */
export function isApiPath(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  return lower === '/api' || lower.startsWith(API_PREFIX);
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
