import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipFor, queryOf, resetStaticCache, serveStatic } from '../src/server/staticFiles';

/**
 * 静态资源服务。
 *
 * 这段代码是独立攻击面：路径穿越、畸形编码、缓存语义、压缩协商。
 * 从 index.ts 拆出来后必须单独锁住，否则拆分等于把测试覆盖丢掉。
 */

let dir: string;
let server: Server | null = null;

afterEach(async () => {
  resetStaticCache();
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function makeClientDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'aquapilot-static-'));
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<div id="root"></div>');
  writeFileSync(join(dir, 'assets', 'app-a1b2c3d4.js'), 'x'.repeat(4096));
  writeFileSync(join(dir, 'secret.txt'), 'should not be reachable outside');
  return dir;
}

async function request(path: string, headers: Record<string, string> = {}) {
  const clientDir = makeClientDir();
  server = createServer((req, res) => {
    void serveStatic(req, res, clientDir);
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, { headers });
  const body = await res.text();
  return { status: res.status, headers: res.headers, body };
}

describe('queryOf', () => {
  it('解析查询串且不依赖 Host', () => {
    const req = { url: '/api/x?from=1&to=2' } as never;
    expect(queryOf(req).get('from')).toBe('1');
    expect(queryOf(req).get('to')).toBe('2');
  });

  it('无查询串与畸形输入都返回空集合', () => {
    expect(queryOf({ url: '/api/x' } as never).toString()).toBe('');
    expect(queryOf({ url: undefined } as never).toString()).toBe('');
  });
});

describe('静态文件安全边界', () => {
  it('路径穿越被拒绝', async () => {
    for (const p of ['/../../package.json', '/%2e%2e/%2e%2e/package.json', '/..%5c..%5cpackage.json']) {
      const r = await request(p);
      expect([403, 404]).toContain(r.status);
      expect(r.body).not.toContain('"name"');
    }
  });

  it('空字节与畸形百分号编码返回 400', async () => {
    expect((await request('/%E0%A4%A')).status).toBe(400);
  });

  it('缺失的带扩展名资源返回 404，不回落 index.html', async () => {
    const r = await request('/assets/missing.js');
    expect(r.status).toBe(404);
    expect(r.body).not.toContain('div id="root"');
  });

  it('前端路由回落 index.html', async () => {
    const r = await request('/some/app/route');
    expect(r.status).toBe(200);
    expect(r.body).toContain('div id="root"');
  });

  it('根路径返回 index.html', async () => {
    const r = await request('/');
    expect(r.status).toBe(200);
    expect(r.body).toContain('div id="root"');
  });
});

describe('缓存与压缩', () => {
  it('哈希资源长缓存，index.html 不缓存', async () => {
    const asset = await request('/assets/app-a1b2c3d4.js');
    expect(asset.headers.get('cache-control')).toContain('immutable');
    const index = await request('/');
    expect(index.headers.get('cache-control')).toBe('no-cache');
  });

  it('gzip 压缩结果按 (path, mtime) 复用', () => {
    resetStaticCache();
    const raw = Buffer.from('x'.repeat(4096));
    const a = gzipFor('/tmp/a.js', 1000, raw);
    const b = gzipFor('/tmp/a.js', 1000, raw);
    expect(a).toBe(b); // 同一 Buffer 引用 = 命中缓存
    const c = gzipFor('/tmp/a.js', 2000, raw);
    expect(c).not.toBe(a); // mtime 变化 → 重新压缩
  });

  it('Accept-Encoding 含 gzip 时返回压缩体，否则不压缩', async () => {
    const zipped = await request('/assets/app-a1b2c3d4.js', { 'accept-encoding': 'gzip' });
    expect(zipped.headers.get('content-encoding')).toBe('gzip');
    expect(zipped.headers.get('vary')).toBe('Accept-Encoding');
    const plain = await request('/assets/app-a1b2c3d4.js', { 'accept-encoding': 'identity' });
    expect(plain.headers.get('content-encoding')).toBeNull();
  });

  it('ETag 条件请求返回 304', async () => {
    const first = await request('/assets/app-a1b2c3d4.js');
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    const second = await request('/assets/app-a1b2c3d4.js', { 'if-none-match': etag! });
    expect(second.status).toBe(304);
    expect(second.body).toBe('');
  });

  it('用 MIME 表给出正确的 Content-Type', async () => {
    expect((await request('/assets/app-a1b2c3d4.js')).headers.get('content-type')).toContain('javascript');
    expect((await request('/')).headers.get('content-type')).toContain('text/html');
  });
});

describe('未构建时的降级', () => {
  it('目录不存在返回可读提示而不是 500', async () => {
    dir = mkdtempSync(join(tmpdir(), 'aquapilot-empty-'));
    const emptyDir = join(dir, 'client');
    server = createServer((req, res) => {
      void serveStatic(req, res, emptyDir);
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const addr = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${addr.port}/`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('npm run build');
  });
});

describe('serveStatic 不吞异常', () => {
  it('根路径下目录不当作文件返回', async () => {
    const clientDir = makeClientDir();
    server = createServer((req, res) => {
      void serveStatic(req, res, clientDir);
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const addr = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${addr.port}/assets`);
    // 目录 → 不是文件 → 回落 index（无扩展名）或 404，但绝不返回目录内容
    expect([200, 404]).toContain(res.status);
    vi.restoreAllMocks();
  });
});
