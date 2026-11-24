import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import { ExperimentStore } from '../src/server/experimentStore';
import { ExperimentService } from '../src/server/experimentService';
import { StudyStore } from '../src/server/studyStore';
import { StudyService } from '../src/server/studyService';
import { createStudyApi } from '../src/server/routes/studies';

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

const BODY = {
  name: 'api-study',
  base: {
    name: 'base',
    model: 'asm1',
    seed: 12,
    warmupDays: 0,
    durationMin: 60,
    sampleEveryMin: 30,
    plantEnabled: false,
    policy: 'fixed',
    validation: 'basic',
  },
  variants: [
    { name: 'a', controls: { doSetpoint: 2 } },
    { name: 'b', controls: { doSetpoint: 2.2 } },
  ],
  replicates: 1,
  objectives: [{ metric: 'totalCost', direction: 'min' }],
};

async function startApi(maxQueue = 8) {
  const dir = mkdtempSync(join(tmpdir(), 'aquapilot-study-api-'));
  const experimentStore = new ExperimentStore(join(dir, 'runs.db'));
  const experiments = new ExperimentService({
    topology: () => PLANT_TOPOLOGY,
    store: experimentStore,
    maxConcurrency: 1,
    maxQueue,
    appVersion: '0.0.0-test',
  });
  const studies = new StudyService({ experiments, store: new StudyStore(join(dir, 'studies.db')) });
  await experiments.start();
  await studies.start();
  const api = createStudyApi({ service: studies });
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (api.matches(pathname)) void api.handle(req, res, pathname);
    else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  closers.push(() => {
    server.close();
    experiments.close();
    studies.close();
  });
  return { base, experiments };
}

describe('研究 REST API', () => {
  it('创建返回 202 + Location；详情支持 ETag/304；报告可下载', async () => {
    const { base, experiments } = await startApi();
    const created = await fetch(`${base}/api/v1/studies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BODY),
    });
    expect(created.status).toBe(202);
    expect(created.headers.get('location')).toMatch(/^\/api\/v1\/studies\/study_/);
    const createdBody = await created.json();
    expect(createdBody.children).toHaveLength(2);
    const id = createdBody.id as string;
    await experiments.idle();

    const detail = await fetch(`${base}/api/v1/studies/${id}`);
    expect(detail.status).toBe(200);
    const etag = detail.headers.get('etag');
    expect(etag).toBeTruthy();
    const body = await detail.json();
    expect(body.aggregate.status).toBe('succeeded');
    expect(body.aggregate.succeeded).toBe(2);

    const notModified = await fetch(`${base}/api/v1/studies/${id}`, { headers: { 'if-none-match': etag! } });
    expect(notModified.status).toBe(304);

    const report = await fetch(`${base}/api/v1/studies/${id}/report.md`);
    expect(report.status).toBe(200);
    expect(report.headers.get('content-type')).toContain('text/markdown');
    const md = await report.text();
    expect(md).toContain('# AquaPilot 仿真研究：api-study');
    expect(md).toContain('Pareto 前沿');
  });

  it('非法研究参数返回 422 + problem+json errors', async () => {
    const { base } = await startApi();
    const res = await fetch(`${base}/api/v1/studies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...BODY, variants: [] }),
    });
    expect(res.status).toBe(422);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const body = await res.json();
    expect(body.code).toBe('STUDY_SPEC_INVALID');
    expect(body.errors.length).toBeGreaterThanOrEqual(1);
  });

  it('队列容量不足返回 429，而不是 500', async () => {
    const { base } = await startApi(1);
    const res = await fetch(`${base}/api/v1/studies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BODY),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('30');
    const body = await res.json();
    expect(body.code).toBe('STUDY_QUEUE_FULL');
  });

  it('幂等重放返回 200 和同一研究 ID', async () => {
    const { base, experiments } = await startApi();
    const headers = { 'content-type': 'application/json', 'idempotency-key': 'study-api-key' };
    const first = await fetch(`${base}/api/v1/studies`, { method: 'POST', headers, body: JSON.stringify(BODY) });
    const firstBody = await first.json();
    const second = await fetch(`${base}/api/v1/studies`, { method: 'POST', headers, body: JSON.stringify(BODY) });
    expect(second.status).toBe(200);
    expect((await second.json()).id).toBe(firstBody.id);
    await experiments.idle();
  });
});
