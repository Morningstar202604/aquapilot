import { describe, expect, it } from 'vitest';
import { ExperimentStore } from '../src/server/experimentStore';
import { PLANT_TOPOLOGY } from '../src/model/topology';

/**
 * 实验存储的内存降级路径。
 *
 * 持久化可用时走 SQLite；节点没有 node:sqlite、或显式关闭持久化时，
 * 队列必须仍可用。此前测试全部在 DB 模式，内存模式的过滤、游标、
 * 状态机与恢复逻辑没有任何覆盖。
 */

function memoryStore(): ExperimentStore {
  // 不调用 open()：db 保持 null，即内存模式
  return new ExperimentStore('/tmp/unused-experiments.db');
}

const spec = { durationMin: 60, model: 'simple', seed: 1, warmupDays: 0 } as never;
const provenance = { appVersion: '0.0.0-test', engine: 'test' } as never;

function make(store: ExperimentStore, id: string, key: string | null = null, createdAt?: number) {
  const record = store.create({
    id,
    name: `run-${id}`,
    spec,
    topology: PLANT_TOPOLOGY,
    topologyHash: 'hash',
    requestHash: `req-${id}`,
    idempotencyKey: key,
    queuePosition: null,
    provenance,
  });
  if (createdAt !== undefined) record.createdAt = createdAt;
  return record;
}

describe('ExperimentStore 内存模式', () => {
  it('create / findById / findByIdempotencyKey', () => {
    const store = memoryStore();
    make(store, 'exp_a', 'key-a');
    expect(store.findById('exp_a')).toMatchObject({ id: 'exp_a', status: 'queued' });
    expect(store.findById('missing')).toBeNull();
    expect(store.findByIdempotencyKey('key-a')).toMatchObject({ id: 'exp_a' });
    expect(store.findByIdempotencyKey('missing')).toBeNull();
  });

  it('findStudyRows 保持请求顺序，缺失实验合成 failed 行', () => {
    const store = memoryStore();
    make(store, 'exp_a');
    make(store, 'exp_b');
    const rows = store.findStudyRows(['exp_b', 'ghost', 'exp_a']);
    expect(rows.map((r) => r.id)).toEqual(['exp_b', 'ghost', 'exp_a']);
    expect(rows[1]).toMatchObject({ status: 'failed', error: 'experiment missing' });
  });

  it('findStudyRows 空数组直接返回，不查库', () => {
    expect(memoryStore().findStudyRows([])).toEqual([]);
  });

  it('list 支持状态过滤、游标、limit 与稳定排序', () => {
    const store = memoryStore();
    make(store, 'exp_a', null, 100);
    make(store, 'exp_b', null, 100);
    make(store, 'exp_c', null, 200);
    expect(store.list('all', 10).map((r) => r.id)).toEqual(['exp_c', 'exp_b', 'exp_a']);
    expect(store.list('all', 2, { createdAt: 200, id: 'exp_c' }).map((r) => r.id)).toEqual(['exp_b', 'exp_a']);
    expect(store.list('queued', 10)).toHaveLength(3);
    expect(store.list('succeeded', 10)).toEqual([]);
    expect(store.countActive()).toBe(3);
  });

  it('状态机：running → progress → succeeded / failed / cancelled', () => {
    const store = memoryStore();
    make(store, 'exp_a');
    store.markRunning('exp_a', 2);
    expect(store.findById('exp_a')).toMatchObject({ status: 'running', queuePosition: 2, progress: 0 });
    store.updateProgress('exp_a', 150, 61.4);
    const running = store.findById('exp_a')!;
    expect(running.progress).toBe(100);
    expect(running.simMinute).toBe(61);
    store.finishSuccess('exp_a', { ok: true } as never, [], { ok: true } as never, provenance);
    expect(store.findById('exp_a')).toMatchObject({ status: 'succeeded', progress: 100 });
    expect(store.countActive()).toBe(0);

    make(store, 'exp_b');
    store.markRunning('exp_b');
    store.finishFailure('exp_b', 'x'.repeat(2500), provenance);
    expect(store.findById('exp_b')!.error).toHaveLength(2000);

    make(store, 'exp_c');
    expect(store.markCancelled('exp_c')).toBe(true);
    expect(store.markCancelled('exp_c')).toBe(false);
    expect(store.markCancelled('ghost')).toBe(false);
  });

  it('updateProgress 对非 running 记录不生效', () => {
    const store = memoryStore();
    make(store, 'exp_a');
    store.updateProgress('exp_a', 50, 30);
    expect(store.findById('exp_a')).toMatchObject({ status: 'queued', progress: 0 });
    store.updateProgress('ghost', 50, 30);
    expect(store.findById('ghost')).toBeNull();
  });

  it('recover：running 回到 queued，保留了排队顺序', () => {
    const store = memoryStore();
    make(store, 'exp_a', null, 100);
    make(store, 'exp_b', null, 200);
    store.markRunning('exp_b', 3);
    const recovered = store.recover();
    expect(recovered.map((r) => r.id)).toEqual(['exp_a', 'exp_b']);
    expect(store.findById('exp_b')).toMatchObject({ status: 'queued', progress: 0, queuePosition: 0 });
    expect(store.countActive()).toBe(2);
  });

  it('close 可重复调用，内存数据仍在', () => {
    const store = memoryStore();
    make(store, 'exp_a');
    store.close();
    store.close();
    expect(store.findById('exp_a')).not.toBeNull();
  });
});
