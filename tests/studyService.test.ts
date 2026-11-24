import { afterEach, describe, expect, it } from 'vitest';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import { ExperimentStore } from '../src/server/experimentStore';
import { ExperimentService } from '../src/server/experimentService';
import { StudyService, StudyIdempotencyConflictError, StudyQueueFullError } from '../src/server/studyService';
import { StudyStore } from '../src/server/studyStore';
import { parseStudySpec } from '../src/server/studySchema';

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function body(overrides: Record<string, unknown> = {}) {
  return {
    name: 'study-service-test',
    base: {
      name: 'base',
      model: 'asm1',
      seed: 11,
      warmupDays: 0,
      durationMin: 60,
      sampleEveryMin: 30,
      plantEnabled: false,
      policy: 'fixed',
      validation: 'basic',
    },
    variants: [
      { name: 'a', controls: { doSetpoint: 2 } },
      { name: 'b', controls: { doSetpoint: 2.5 } },
    ],
    replicates: 1,
    objectives: [{ metric: 'totalCost', direction: 'min' }],
    ...overrides,
  };
}

async function start(maxQueue = 8) {
  const store = new ExperimentStore(`${process.cwd()}/.tmp-study-test-${Date.now()}-${Math.random()}.db`);
  const experiments = new ExperimentService({
    topology: () => PLANT_TOPOLOGY,
    store,
    maxConcurrency: 1,
    maxQueue,
    appVersion: '0.0.0-test',
  });
  const studies = new StudyService({
    experiments,
    store: new StudyStore(`${process.cwd()}/.tmp-study-store-${Date.now()}-${Math.random()}.db`),
  });
  await experiments.start();
  await studies.start();
  closers.push(() => {
    experiments.close();
    studies.close();
  });
  return { experiments, studies };
}

describe('StudyService', () => {
  it('创建子实验、等待完成后聚合排序', async () => {
    const { experiments, studies } = await start();
    const spec = parseStudySpec(body());
    const created = studies.create(spec);
    expect(created.replayed).toBe(false);
    expect(created.detail.record.childIds).toHaveLength(2);
    expect(['queued', 'running']).toContain(created.detail.aggregate.status);
    await experiments.idle();
    const detail = studies.get(created.detail.record.id)!;
    expect(detail.aggregate.status).toBe('succeeded');
    expect(detail.aggregate.succeeded).toBe(2);
    expect(detail.aggregate.ranking.length).toBeGreaterThanOrEqual(1);
    const md = detail.aggregate;
    expect(md.best !== null).toBe(true);
  });

  it('幂等键重放同一研究，不同 spec 冲突', async () => {
    const { experiments, studies } = await start();
    const spec = parseStudySpec(body());
    const first = studies.create(spec, 'study-key');
    const replay = studies.create(spec, 'study-key');
    expect(replay.replayed).toBe(true);
    expect(replay.detail.record.id).toBe(first.detail.record.id);
    expect(() => studies.create(parseStudySpec(body({ name: 'different' })), 'study-key')).toThrow(
      StudyIdempotencyConflictError,
    );
    await experiments.idle();
  });

  it('队列容量不足时拒绝整批，不留下半批任务', async () => {
    const { studies } = await start(1);
    const spec = parseStudySpec(body());
    expect(() => studies.create(spec)).toThrow(StudyQueueFullError);
    const record = studies.list(10)[0];
    expect(record).toBeUndefined();
  });

  it('取消整批后状态为 cancelled', async () => {
    const { experiments, studies } = await start();
    const spec = parseStudySpec(body());
    const created = studies.create(spec);
    const cancelled = studies.cancel(created.detail.record.id)!;
    expect(cancelled.aggregate.status === 'cancelled' || cancelled.aggregate.status === 'running').toBe(true);
    await experiments.idle();
    const detail = studies.get(created.detail.record.id)!;
    expect(detail.aggregate.cancelled).toBeGreaterThanOrEqual(1);
  });
});
