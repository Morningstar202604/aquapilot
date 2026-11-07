import type { IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { shouldFallbackToIndex } from './httpRoutes';

/**
 * 静态资源服务。
 *
 * 从 server/index.ts 抽出的原因：这段逻辑有独立的攻击面（路径穿越、畸形
 * 百分号编码、缓存语义、压缩协商），和仿真编排没有任何耦合。单独成文件后
 * 边界清晰、可单独审阅，且不会因为入口文件变长而没人愿意读。
 */

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

export interface StaticCacheEntry {
  body: Buffer;
  etag: string;
  mtimeMs: number;
  contentType: string;
  hashedAsset: boolean;
}

/**
 * 压缩缓存。
 *
 * 旧实现对每个请求现场 `gzipSync`：900 kB 的 JS 每次导航都重压一遍，
 * 主线程同步阻塞（CI 实测单次 12–18 ms，并发抓取时线性叠加）。
 * 构建产物按内容哈希命名，内容不变 → 压缩结果可以永久复用；
 * 用 mtime 做键的一部分，开发期覆盖同名文件时自动失效。
 */
const gzipCache = new Map<string, { mtimeMs: number; gzipped: Buffer }>();
const GZIP_CACHE_LIMIT = 64;

export function gzipFor(filePath: string, mtimeMs: number, raw: Buffer): Buffer {
  const hit = gzipCache.get(filePath);
  if (hit && hit.mtimeMs === mtimeMs) return hit.gzipped;
  const gzipped = gzipSync(raw, { level: 6 });
  if (gzipCache.size >= GZIP_CACHE_LIMIT) {
    const oldest = gzipCache.keys().next().value;
    if (oldest !== undefined) gzipCache.delete(oldest);
  }
  gzipCache.set(filePath, { mtimeMs, gzipped });
  return gzipped;
}

/** 解析请求的查询串；绝不使用客户端可控的 Host 头构造基址 */
export function queryOf(req: IncomingMessage): URLSearchParams {
  const raw = req.url ?? '/';
  const q = raw.indexOf('?');
  if (q < 0) return new URLSearchParams();
  try {
    return new URLSearchParams(raw.slice(q + 1));
  } catch {
    return new URLSearchParams();
  }
}

export async function serveStatic(
  req: IncomingMessage,
  res: import('node:http').ServerResponse,
  clientDir = resolve(process.cwd(), 'dist/client'),
): Promise<void> {
  let urlPath: string;
  try {
    urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  } catch {
    // 畸形百分号编码（如 /%E0%A4%A）会让 decodeURIComponent 抛 URIError
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('bad request');
    return;
  }

  // 拒绝空字节与路径穿越片段
  if (urlPath.includes('\u0000')) {
    res.writeHead(400);
    res.end('bad request');
    return;
  }

  let filePath = normalize(join(clientDir, urlPath === '/' ? 'index.html' : urlPath));

  // 前缀校验必须带分隔符，否则 dist/clientX 会通过 startsWith('dist/client')
  const withSep = clientDir.endsWith(sep) ? clientDir : clientDir + sep;
  if (filePath !== clientDir && !filePath.startsWith(withSep)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  if (!existsSync(filePath)) {
    // 只有前端路由才回落首页；缺资源必须 404，否则浏览器把 HTML 当 JS 执行
    if (!shouldFallbackToIndex(urlPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    filePath = join(clientDir, 'index.html');
  }
  try {
    /**
     * 先 open 再 fstat/read：不要在 stat 与 readFile 之间留 TOCTOU 窗口。
     *
     * stat 通过只说明那一刻路径指向普通文件；两次系统调用之间它可能被换成
     * 目录、FIFO 或指向别处的符号链接，随后 readFile 会按新目标读取。
     * 这里用同一个句柄完成「确认类型 + 读内容」，句柄在 close 之前不会改指。
     */
    const handle = await open(filePath, 'r');
    let raw: Buffer;
    let info: Awaited<ReturnType<typeof handle.stat>>;
    try {
      info = await handle.stat();
      if (!info.isFile()) throw new Error('not a file');
      raw = await handle.readFile();
    } finally {
      await handle.close();
    }

    /**
     * 缓存与压缩规则：
     * - `assets/` 下是 Vite 的哈希文件名 → 内容寻址，可以 immutable 长缓存；
     * - `index.html` 必须 no-cache，否则升级后仍引用旧 chunk；
     * - 文本类按 Accept-Encoding 压缩，结果按 (path, mtime) 缓存。
     */
    const ext = extname(filePath);
    const compressible = ['.js', '.css', '.html', '.json', '.svg'].includes(ext);
    const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    // Vite 产物名形如 index-CSCN34Vd.js / index-Ce2X6dJr.css：带内容哈希才允许长缓存
    const hashedAsset = urlPath.startsWith('/assets/') && /-[A-Za-z0-9_-]{6,}\.[a-z0-9]+$/.test(urlPath);
    const etag = `"${createHash('sha1').update(raw).digest('base64url').slice(0, 20)}"`;
    // 条件请求：内容没变就 304，浏览器复用本地副本，省掉一次完整下载
    if (String(req.headers['if-none-match'] ?? '') === etag) {
      res.writeHead(304, {
        ETag: etag,
        'Cache-Control': hashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
      res.end();
      return;
    }
    const headers: Record<string, string> = {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': hashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
      ETag: etag,
      'Last-Modified': info.mtime.toUTCString(),
    };
    let body: Buffer = raw;
    if (compressible && acceptsGzip && raw.length > 1024) {
      body = gzipFor(filePath, info.mtimeMs, raw);
      headers['Content-Encoding'] = 'gzip';
      headers.Vary = 'Accept-Encoding';
    }
    headers['Content-Length'] = String(body.length);
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('客户端尚未构建，请先运行 npm run build');
  }
}

/** 测试用：清空压缩缓存，避免用例之间共享大 Buffer */
export function resetStaticCache(): void {
  gzipCache.clear();
}
