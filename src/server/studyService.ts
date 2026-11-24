/**
 * Study 编排服务。
 *
 * 不复制仿真/队列逻辑：每个子实验仍由 ExperimentService 创建、排队、执行与恢复；
 * Study 只负责展开 spec、检查批次容量、聚合结果和取消整批。
 *
 * 容量：默认实验队列 `maxQueue=24`，Study 最大 12×2=24 子实验；
 * 若当前已有其它实验占用队列，Study 会返回 429，而不是偷偷排队到内存里。
 */

import { randomUUID } from 'node:crypto';
import { hashJson } from './canonical';
import type { ExperimentService } from './experimentService';
import { ExperimentQueueFullError } from './experimentService';
import { StudyStore, type StudyRecord } from './studyStore';
import {
  STUDY_LIMITS,
  aggregateStudy,
  planStudy,
  type PlannedStudy,
  type StudyAggregate,
  type StudySpec,
} from '../sim/study';

export class StudyQueueFullError extends Error {
  readonly code = 'STUDY_QUEUE_FULL';
  constructor(readonly limit: number) {
    super(`study needs queue capacity but only ${limit} slots are free`);
    this.name = 'StudyQueueFullError';
  }
}

export class StudyIdempotencyConflictError extends Error {
  readonly code = 'STUDY_IDEMPOTENCY_KEY_REUSED';
  constructor() {
    super('Idempotency-Key was already used with a different study body');
    this.name = 'StudyIdempotencyConflictError';
  }
}

export interface StudyDetail {
  record: StudyRecord;
  plan: PlannedStudy;
  aggregate: StudyAggregate;
}

export interface CreateStudyResult {
  detail: StudyDetail;
  replayed: boolean;
}

export interface StudyServiceOptions {
  experiments: ExperimentService;
  store?: StudyStore;
}

export class StudyService {
  readonly store: StudyStore;
  private readonly experiments: ExperimentService;
  private started = false;

  constructor(options: StudyServiceOptions) {
    this.experiments = options.experiments;
    this.store = options.store ?? new StudyStore();
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.store.open();
    this.started = true;
  }

  create(spec: StudySpec, idempotencyKey: string | null = null): CreateStudyResult {
    if (!this.started) throw new Error('StudyService.start() must be awaited before create()');
    const requestHash = hashJson(spec);
    if (idempotencyKey) {
      const existing = this.store.findByIdempotencyKey(idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash) throw new StudyIdempotencyConflictError();
        return { detail: this.detail(existing), replayed: true };
      }
    }

    const plan = planStudy(spec);
    if (plan.children.length > STUDY_LIMITS.maxChildren) {
      throw new StudyQueueFullError(STUDY_LIMITS.maxChildren);
    }
    const free = this.experiments.queueLimit - this.experiments.activeCount();
    if (free < plan.children.length) throw new StudyQueueFullError(Math.max(0, free));

    const id = `study_${randomUUID()}`;
    const record = this.store.create({
      id,
      name: spec.name?.trim() || plan.studyName,
      requestHash,
      idempotencyKey,
      spec,
    });

    const createdIds: string[] = [];
    try {
      for (const child of plan.children) {
        const result = this.experiments.create(child.spec, null);
        createdIds.push(result.record.id);
        this.store.setChildren(id, createdIds);
      }
    } catch (error) {
      for (const childId of createdIds) {
        try {
          this.experiments.cancel(childId);
        } catch {
          /* 已经结束的子实验无法取消；保留结果，不影响整批失败 */
        }
      }
      this.store.markError(id, error instanceof Error ? error.message : String(error));
      if (error instanceof ExperimentQueueFullError) throw new StudyQueueFullError(error.limit);
      throw error;
    }

    record.childIds = createdIds;
    return { detail: this.detail(record), replayed: false };
  }

  get(id: string): StudyDetail | null {
    const record = this.store.findById(id);
    return record ? this.detail(record) : null;
  }

  list(limit = 20): StudyDetail[] {
    return this.store.list(limit).map((record) => this.detail(record));
  }

  cancel(id: string): StudyDetail | null {
    const record = this.store.findById(id);
    if (!record) return null;
    for (const childId of record.childIds) {
      try {
        this.experiments.cancel(childId);
      } catch {
        /* terminal children are left as-is */
      }
    }
    return this.detail(record);
  }

  close(): void {
    this.store.close();
  }

  private detail(record: StudyRecord): StudyDetail {
    const plan = planStudy(record.spec);
    const rows = this.experiments.getStudyRows(record.childIds);
    const aggregate = aggregateStudy(record.spec, rows);
    return { record, plan, aggregate };
  }
}
