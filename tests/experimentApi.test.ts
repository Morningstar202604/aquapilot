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
