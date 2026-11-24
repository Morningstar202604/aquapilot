import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import { ExperimentStore } from '../src/server/experimentStore';
import {
  ExperimentIdempotencyConflictError,
  ExperimentQueueFullError,
  ExperimentService,
} from '../src/server/experimentService';
import type { ExperimentSpec } from '../src/sim/experiment';

function spec(overrides: Partial<ExperimentSpec> = {}): ExperimentSpec {
  return {
    name: 'service-test',
    model: 'asm1',
    seed: 7,
    warmupDays: 2,
    durationMin: 60,
    sampleEveryMin: 30,
    scenario: null,
    controls: {},
    plantEnabled: false,
    bioPRemoval: true,
    standardId: 'gb18918-1b',
    policy: 'fixed',
    decisionIntervalMin: 240,
    validation: 'basic',
    ...overrides,
  };
}

function dbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'aquapilot-exp-')), 'runs.db');
}

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

async function makeService(path: string, options: { maxConcurrency?: number; maxQueue?: number } = {}) {
  const store = new ExperimentStore(path);
  const service = new ExperimentService({
    topology: () => PLANT_TOPOLOGY,
    store,
    maxConcurrency: options.maxConcurrency ?? 1,
    maxQueue: options.maxQueue ?? 4,
    appVersion: '0.0.0-test',
  });
  await service.start();
  closers.push(() => service.close());
  return { store, service };
}

describe('实验编排服务', () => {
  it('创建、运行并持久化结果', async () => {
    const { store, service } = await makeService(dbPath());
    const { record } = service.create(spec());
    await service.idle();
    const done = service.get(record.id)!;
    expect(done.status).toBe('succeeded');
    expect(done.summary?.sampleCount).toBe(3);
    expect(done.validation?.certified).toBe(true);
    expect(done.provenance?.topologyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(store.enabled).toBe(true);
  });

  it('同一 Idempotency-Key 重放不重复执行，不同请求体冲突', async () => {
    const { service } = await makeService(dbPath());
    const first = service.create(spec({ name: 'same' }), 'key-1');
    const replay = service.create(spec({ name: 'same' }), 'key-1');
    expect(replay.replayed).toBe(true);
    expect(replay.record.id).toBe(first.record.id);
    expect(() => service.create(spec({ name: 'different' }), 'key-1')).toThrow(ExperimentIdempotencyConflictError);
  });

  it('排队达到上限时拒绝新任务', async () => {
    const { service } = await makeService(dbPath(), { maxConcurrency: 1, maxQueue: 1 });
    service.create(spec({ durationMin: 43_200, sampleEveryMin: 1_440 }));
    expect(() => service.create(spec())).toThrow(ExperimentQueueFullError);
    for (const record of service.list('all', 10)) service.cancel(record.id);
  });

  it('可取消 queued 与 running 任务', async () => {
    const { service } = await makeService(dbPath(), { maxConcurrency: 1, maxQueue: 2 });
    const a = service.create(spec({ name: 'a', durationMin: 43_200, sampleEveryMin: 1_440 }));
    const b = service.create(spec({ name: 'b', durationMin: 43_200, sampleEveryMin: 1_440 }));
    expect(service.cancel(b.record.id)?.status).toBe('cancelled');
    expect(service.cancel(a.record.id)?.status).toBe('cancelled');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(service.get(a.record.id)?.status).toBe('cancelled');
  });

  it('重启后把 interrupted running 重新排队并完成', async () => {
    const path = dbPath();
    const store = new ExperimentStore(path);
    await store.open();
    const record = store.create({
      id: 'exp_00000000-0000-4000-8000-000000000000',
      name: 'recover',
      spec: spec({ durationMin: 60 }),
      topology: structuredClone(PLANT_TOPOLOGY),
      topologyHash: 'x',
      requestHash: 'y',
      idempotencyKey: null,
      queuePosition: 0,
      provenance: {
        appVersion: 'test',
        createdAt: new Date().toISOString(),
        topologyHash: 'x',
        specHash: 'z',
        requestHash: 'y',
        engine: 'typescript',
      },
    });
    store.markRunning(record.id);
    store.close();

    const { service } = await makeService(path);
    await service.idle();
    const done = service.get(record.id)!;
    expect(done.status).toBe('succeeded');
  });
});
