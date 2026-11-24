/**
 * 实验编排服务（控制面）。
 *
 * 负责生命周期，不负责数值：spec 校验在 API 层完成，仿真在 sim/experiment.ts。
 * 队列语义：
 * - `queued` → `running` → `succeeded|failed|cancelled`；
 * - 同一时刻最多 `maxConcurrency` 个运行，`queued+running` 合计上限 `maxQueue`；
 * - 超过排队上限返回 429（带动 Retry-After），不做无限内存积压；
 * - `Idempotency-Key` 对同一请求返回既有资源，不重复消耗算力；
 * - 重启时中断的 running 重新排队，实验结果仍是确定的。
 */

import { randomUUID } from 'node:crypto';
import {
  ExperimentStore,
  type ExperimentRecord,
  type ExperimentProvenance,
  type ExperimentStatus,
} from './experimentStore';
import { hashJson } from './canonical';
import { ExperimentAbortedError, runExperiment, type ExperimentSpec } from '../sim/experiment';
import type { ProcessTopology } from '../model/topology';

export class ExperimentQueueFullError extends Error {
  readonly code = 'EXPERIMENT_QUEUE_FULL';
  constructor(readonly limit: number) {
    super(`experiment queue is full (limit ${limit})`);
    this.name = 'ExperimentQueueFullError';
  }
}

export class ExperimentIdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_KEY_REUSED';
  constructor() {
    super('Idempotency-Key was already used with a different request body');
    this.name = 'ExperimentIdempotencyConflictError';
  }
}

export class ExperimentConflictError extends Error {
  readonly code = 'EXPERIMENT_NOT_CANCELLABLE';
  constructor(readonly status: string) {
    super(`experiment is already ${status}`);
    this.name = 'ExperimentConflictError';
  }
}

export interface ExperimentServiceOptions {
  topology: () => ProcessTopology;
  store?: ExperimentStore;
  maxConcurrency?: number;
  maxQueue?: number;
  appVersion?: string;
}

export interface CreateExperimentResult {
  record: ExperimentRecord;
  replayed: boolean;
}

export class ExperimentService {
  readonly store: ExperimentStore;
  private readonly topology: () => ProcessTopology;
  private readonly maxConcurrency: number;
  private readonly maxQueue: number;
  private readonly appVersion: string;
  private readonly queue: string[] = [];
  private readonly active = new Map<string, AbortController>();
  private started = false;
  private idleWaiters: (() => void)[] = [];

  constructor(options: ExperimentServiceOptions) {
    this.store = options.store ?? new ExperimentStore();
    this.topology = options.topology;
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? 2);
    this.maxQueue = Math.max(1, options.maxQueue ?? 24);
    this.appVersion = options.appVersion ?? '0.0.0';
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.store.open();
    this.started = true;
    const pending = this.store.recover();
    for (const record of pending) {
      if (!this.queue.includes(record.id)) this.queue.push(record.id);
    }
    this.drain();
  }

  get concurrency(): number {
    return this.maxConcurrency;
  }

  get queueLimit(): number {
    return this.maxQueue;
  }

  create(spec: ExperimentSpec, idempotencyKey: string | null = null): CreateExperimentResult {
    if (!this.started) throw new Error('ExperimentService.start() must be awaited before create()');
    const topology = structuredClone(this.topology());
    const topologyHash = hashJson(topology);
    const specHash = hashJson(spec);
    const requestHash = hashJson({ topologyHash, specHash, spec });

    if (idempotencyKey) {
      const existing = this.store.findByIdempotencyKey(idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash) throw new ExperimentIdempotencyConflictError();
        return { record: existing, replayed: true };
      }
    }

    // 限制的是 queued+running 的总积压，避免只限制 waiting 时 CPU 队列仍无限增长
    const active = this.store.countActive();
    if (active >= this.maxQueue) throw new ExperimentQueueFullError(this.maxQueue);

    const id = `exp_${randomUUID()}`;
    const provenance: ExperimentProvenance = {
      appVersion: this.appVersion,
      createdAt: new Date().toISOString(),
      topologyHash,
      specHash,
      requestHash,
      engine: 'typescript',
    };
    const record = this.store.create({
      id,
      name: spec.name?.trim() || id,
      spec,
      topology,
      topologyHash,
      requestHash,
      idempotencyKey,
      queuePosition: active,
      provenance,
    });
    this.queue.push(id);
    this.drain();
    return { record, replayed: false };
  }

  get(id: string): ExperimentRecord | null {
    return this.store.findById(id);
  }

  list(status: ExperimentStatus | 'all', limit: number, cursor?: { createdAt: number; id: string } | null) {
    return this.store.list(status, limit, cursor);
  }

  cancel(id: string): ExperimentRecord | null {
    const record = this.store.findById(id);
    if (!record) return null;
    if (record.status === 'succeeded' || record.status === 'failed') throw new ExperimentConflictError(record.status);
    if (record.status === 'cancelled') return record;

    const idx = this.queue.indexOf(id);
    if (idx >= 0) this.queue.splice(idx, 1);
    const controller = this.active.get(id);
    if (controller) controller.abort(new ExperimentAbortedError());
    this.store.markCancelled(id);
    return this.store.findById(id);
  }

  /** 测试/优雅停机：等待所有已排队任务结束，但不取消任务。 */
  async idle(): Promise<void> {
    if (this.queue.length === 0 && this.active.size === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private drain(): void {
    const running = this.active.size;
    if (running >= this.maxConcurrency) return;
    const next = this.queue.shift();
    if (!next) {
      this.resolveIdle();
      return;
    }
    const record = this.store.findById(next);
    if (!record || record.status !== 'queued') {
      this.drain();
      return;
    }
    const controller = new AbortController();
    this.active.set(next, controller);
    this.store.markRunning(next, null);
    void this.run(record, controller)
      .catch(() => undefined)
      .finally(() => {
        this.active.delete(next);
        this.drain();
      });
    this.drain();
  }

  private async run(record: ExperimentRecord, controller: AbortController): Promise<void> {
    const started = Date.now();
    let lastProgress = -1;
    try {
      const result = await runExperiment(record.topology, record.spec, {
        signal: controller.signal,
        onProgress: ({ percent, simMinute }) => {
          if (percent !== lastProgress) {
            lastProgress = percent;
            this.store.updateProgress(record.id, percent, simMinute);
          }
        },
      });
      // cancel 可能发生在最后一步与写结果之间；以持久状态为准，绝不让
      // 已取消的任务被 success 覆盖。
      if (controller.signal.aborted || this.store.findById(record.id)?.status === 'cancelled') {
        throw new ExperimentAbortedError();
      }
      const finishedAt = new Date().toISOString();
      const provenance: ExperimentProvenance = {
        ...(record.provenance ?? {
          appVersion: this.appVersion,
          createdAt: new Date(record.createdAt).toISOString(),
          topologyHash: record.topologyHash,
          specHash: hashJson(record.spec),
          requestHash: record.requestHash,
          engine: 'typescript' as const,
        }),
        startedAt: new Date(started).toISOString(),
        finishedAt,
        durationMs: Date.now() - started,
      };
      this.store.finishSuccess(record.id, result.summary, result.samples, result.validation, provenance);
    } catch (error) {
      if (error instanceof ExperimentAbortedError || controller.signal.aborted) {
        this.store.markCancelled(record.id);
        return;
      }
      const provenance: ExperimentProvenance = {
        ...(record.provenance ?? {
          appVersion: this.appVersion,
          createdAt: new Date(record.createdAt).toISOString(),
          topologyHash: record.topologyHash,
          specHash: hashJson(record.spec),
          requestHash: record.requestHash,
          engine: 'typescript' as const,
        }),
        startedAt: new Date(started).toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
      };
      this.store.finishFailure(record.id, error instanceof Error ? error.message : String(error), provenance);
    }
  }

  private resolveIdle(): void {
    if (this.active.size !== 0 || this.queue.length !== 0) return;
    const waiters = this.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  close(): void {
    for (const controller of this.active.values()) controller.abort(new ExperimentAbortedError());
    this.store.close();
  }
}
