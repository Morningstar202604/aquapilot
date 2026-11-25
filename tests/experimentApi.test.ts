import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import { ExperimentStore } from '../src/server/experimentStore';
import { ExperimentService } from '../src/server/experimentService';
import { createExperimentApi } from '../src/server/routes/experiments';

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

async function startApi() {
  const store = new ExperimentStore(join(mkdtempSync(join(tmpdir(), 'aquapilot-api-')), 'runs.db'));
  const service = new ExperimentService({
    topology: () => PLANT_TOPOLOGY,
    store,
    maxConcurrency: 1,
    maxQueue: 4,
    appVersion: '0.0.0-test',
  });
  await service.start();
  const api = createExperimentApi({ service, appVersion: '0.0.0-test' });
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (api.matches(pathname)) api.handle(req, res, pathname);
    else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  closers.push(() => {
    server.close();
    service.close();
  });
  return { base, service };
}

const BODY = {
  name: 'api-test',
  model: 'asm1',
  seed: 9,
  warmupDays: 1,
  durationMin: 60,
  sampleEveryMin: 30,
  plantEnabled: false,
  standardId: 'gb18918-1b',
  policy: 'fixed',
  validation: 'basic',
};

describe('实验 REST API', () => {
  it('创建返回 202 + Location，幂等重放返回 200', async () => {
    const { base, service } = await startApi();
    const first = await fetch(`${base}/api/v1/experiments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'key-1' },
      body: JSON.stringify(BODY),
    });
    expect(first.status).toBe(202);
    expect(first.headers.get('location')).toMatch(/^\/api\/v1\/experiments\/exp_/);
    const id = (await first.json()).id as string;
    const replay = await fetch(`${base}/api/v1/experiments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'key-1' },
      body: JSON.stringify(BODY),
    });
    expect(replay.status).toBe(200);
    const replayBody = await replay.json();
    expect(replayBody.id).toBe(id);
    expect(replayBody.status).toBeDefined();
    await service.idle();
  });

  it('同幂等键不同请求体返回 409', async () => {
    const { base } = await startApi();
    await fetch(`${base}/api/v1/experiments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'same' },
      body: JSON.stringify(BODY),
    });
    const conflict = await fetch(`${base}/api/v1/experiments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'same' },
      body: JSON.stringify({ ...BODY, seed: 10 }),
    });
    expect(conflict.status).toBe(409);
    expect(conflict.headers.get('content-type')).toContain('application/problem+json');
  });

  it('非法参数返回 422 且带 errors 列表', async () => {
    const { base } = await startApi();
    const res = await fetch(`${base}/api/v1/experiments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...BODY, durationMin: 5, controls: { doSetpoint: 99 } }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('EXPERIMENT_SPEC_INVALID');
    expect(body.errors.length).toBeGreaterThanOrEqual(1);
  });

  it('详情支持 ETag/304，CSV 与报告可下载', async () => {
    const { base, service } = await startApi();
    const created = await fetch(`${base}/api/v1/experiments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BODY),
    });
    const id = (await created.json()).id as string;
    await service.idle();

    const detail = await fetch(`${base}/api/v1/experiments/${id}`);
    expect(detail.status).toBe(200);
    const etag = detail.headers.get('etag');
    expect(etag).toBeTruthy();
    const cached = await fetch(`${base}/api/v1/experiments/${id}`, { headers: { 'if-none-match': etag! } });
    expect(cached.status).toBe(304);

    const csv = await fetch(`${base}/api/v1/experiments/${id}/samples.csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect((await csv.text()).split('\n').length).toBeGreaterThan(2);

    const md = await fetch(`${base}/api/v1/experiments/${id}/report.md`);
    expect(md.status).toBe(200);
    expect(await md.text()).toContain('AquaPilot 实验报告');
  });

  it('拒绝近似 JSON 媒体类型与超长幂等键', async () => {
    const { base } = await startApi();
    const wrongType = await fetch(`${base}/api/v1/experiments`, {
      method: 'POST',
      headers: { 'content-type': 'application/jsonp' },
      body: JSON.stringify(BODY),
    });
    expect(wrongType.status).toBe(415);
    expect(wrongType.headers.get('content-type')).toContain('application/problem+json');

    const longKey = await fetch(`${base}/api/v1/experiments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k'.repeat(129) },
      body: JSON.stringify(BODY),
    });
    expect(longKey.status).toBe(400);
    expect((await longKey.json()).code).toBe('IDEMPOTENCY_KEY_INVALID');
  });

  it('OpenAPI 3.1 契约包含实验资源', async () => {
    const { base } = await startApi();
    const res = await fetch(`${base}/api/openapi.json`);
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.paths['/api/v1/experiments'].post).toBeDefined();
    expect(doc.components.schemas.Problem).toBeDefined();
  });
});

describe('实验 REST API 边界', () => {
  it('集合与 OpenAPI 的非允许方法返回 405', async () => {
    const { base } = await startApi();
    const put = await fetch(`${base}/api/v1/experiments`, { method: 'PUT' });
    expect(put.status).toBe(405);
    expect(put.headers.get('allow')).toBe('GET, HEAD, POST');
    const openapiPost = await fetch(`${base}/api/openapi.json`, { method: 'POST' });
    expect(openapiPost.status).toBe(405);
    expect(openapiPost.headers.get('allow')).toBe('GET, HEAD');
  });

  it('缺 Content-Type、坏 JSON、超大请求体分别回 415/400/413', async () => {
    const { base } = await startApi();
    const noType = await fetch(`${base}/api/v1/experiments`, { method: 'POST', body: JSON.stringify(BODY) });
    expect(noType.status).toBe(415);
    const badJson = await fetch(`${base}/api/v1/experiments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{oops',
    });
    expect(badJson.status).toBe(400);
    expect((await badJson.json()).code).toBe('INVALID_JSON');
    const big = await fetch(`${base}/api/v1/experiments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...BODY, padding: 'x'.repeat(70_000) }),
    });
    expect(big.status).toBe(413);
  });

  it('非法 status / limit / cursor 都回 400', async () => {
    const { base } = await startApi();
    for (const query of ['status=nope', 'limit=0', 'limit=101', 'limit=1.5', 'cursor=bad']) {
      const res = await fetch(`${base}/api/v1/experiments?${query}`);
      expect(res.status, query).toBe(400);
      expect((await res.json()).code).toBe('QUERY_INVALID');
    }
  });

  it('列表分页给出 nextCursor，第二页可继续；HEAD 无响应体', async () => {
    const { base } = await startApi();
    for (let i = 0; i < 3; i += 1) {
      await fetch(`${base}/api/v1/experiments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...BODY, name: `page-${i}` }),
      });
    }
    const first = await fetch(`${base}/api/v1/experiments?limit=2`);
    const page1 = await first.json();
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const second = await fetch(`${base}/api/v1/experiments?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`);
    const page2 = await second.json();
    expect(page2.items.length).toBeGreaterThanOrEqual(1);
    expect(page2.items[0].id).not.toBe(page1.items[0].id);

    const head = await fetch(`${base}/api/v1/experiments?limit=2`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    const openapiHead = await fetch(`${base}/api/openapi.json`, { method: 'HEAD' });
    expect(openapiHead.status).toBe(200);
    expect(await openapiHead.text()).toBe('');
  });

  it('列表 ETag 命中 304', async () => {
    const { base } = await startApi();
    const first = await fetch(`${base}/api/v1/experiments`);
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    const cached = await fetch(`${base}/api/v1/experiments`, { headers: { 'if-none-match': etag! } });
    expect(cached.status).toBe(304);
  });

  it('详情：非法 ID 404、未知 ID 404、POST 405、HEAD 无体', async () => {
    const { base } = await startApi();
    const bad = await fetch(`${base}/api/v1/experiments/not-an-id`);
    expect(bad.status).toBe(404);
    expect((await bad.json()).detail).toContain('格式');
    const missing = await fetch(`${base}/api/v1/experiments/exp_00000000-0000-0000-0000-000000000000`);
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe('EXPERIMENT_NOT_FOUND');
    const post = await fetch(`${base}/api/v1/experiments/exp_00000000-0000-0000-0000-000000000000`, {
      method: 'POST',
    });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');

    const created = await fetch(`${base}/api/v1/experiments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BODY),
    });
    const id = (await created.json()).id as string;
    const head = await fetch(`${base}/api/v1/experiments/${id}`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('取消：405、未知 404、已结束 409、排队中 202', async () => {
    const { base, service } = await startApi();
    const id = 'exp_00000000-0000-0000-0000-000000000000';
    const getCancel = await fetch(`${base}/api/v1/experiments/${id}/cancel`);
    expect(getCancel.status).toBe(405);
    expect(getCancel.headers.get('allow')).toBe('POST');
    const missing = await fetch(`${base}/api/v1/experiments/${id}/cancel`, { method: 'POST' });
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe('EXPERIMENT_NOT_FOUND');

    const created = await fetch(`${base}/api/v1/experiments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BODY),
    });
    const realId = (await created.json()).id as string;
    await service.idle();
    const conflict = await fetch(`${base}/api/v1/experiments/${realId}/cancel`, { method: 'POST' });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).code).toBe('EXPERIMENT_NOT_CANCELLABLE');
  });

  it('下载：未知 404、未完成 409、HEAD 200、POST 405、未知子资源 404', async () => {
    const { base, service } = await startApi();
    const id = 'exp_00000000-0000-0000-0000-000000000000';
    const missingCsv = await fetch(`${base}/api/v1/experiments/${id}/samples.csv`);
    expect(missingCsv.status).toBe(404);
    const missingReport = await fetch(`${base}/api/v1/experiments/${id}/report.md`);
    expect(missingReport.status).toBe(404);

    // 直接落一条 queued 记录，避免实验跑得太快导致“未就绪”不可复现
    const realId = 'exp_11111111-1111-1111-1111-111111111111';
    service.store.create({
      id: realId,
      name: 'queued-one',
      spec: BODY as never,
      topology: PLANT_TOPOLOGY,
      topologyHash: 'hash',
      requestHash: 'req',
      idempotencyKey: null,
      queuePosition: 1,
      provenance: { appVersion: '0.0.0-test' } as never,
    });
    const notReady = await fetch(`${base}/api/v1/experiments/${realId}/samples.csv`);
    expect(notReady.status).toBe(409);
    expect((await notReady.json()).code).toBe('EXPERIMENT_NOT_READY');

    const headCsv = await fetch(`${base}/api/v1/experiments/${realId}/samples.csv`, { method: 'HEAD' });
    expect(headCsv.status).toBe(409);
    const headReport = await fetch(`${base}/api/v1/experiments/${realId}/report.md`, { method: 'HEAD' });
    expect(headReport.status).toBe(409);
    const postCsv = await fetch(`${base}/api/v1/experiments/${realId}/samples.csv`, { method: 'POST' });
    expect(postCsv.status).toBe(405);

    const unknown = await fetch(`${base}/api/v1/experiments/${realId}/nope`);
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).code).toBe('NOT_FOUND');
    const unknownPath = await fetch(`${base}/api/v2/experiments`);
    expect(unknownPath.status).toBe(404);
  });
});
