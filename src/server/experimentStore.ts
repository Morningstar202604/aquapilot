/**
 * 实验的持久化层。
 *
 * 与实时运行的历史表分开：实验是一次“可复现的离线运行”，它需要保存
 * spec、拓扑快照、结果和校验状态；实时 run 只需要采样与决策审计。
 *
 * 设计：
 * - 单进程内同步 SQLite 写入（实验状态转换不频繁，不需要异步线程池）；
 * - 大字段（samples/topology）只在详情读取，列表只读 summary；
 * - `AQUAPILOT_PERSIST=0` 或 Node 无 node:sqlite 时退化为内存存储，服务仍可用；
 * - 重启时把 `running` 标回 `queued`，由服务重新执行（仿真本身是确定性的）。
 */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadSqlite, type DatabaseLike } from './store';
import { logger } from './observability';
import type { ExperimentSpec, ExperimentSummary, ExperimentValidation, ExperimentSample } from '../sim/experiment';
import type { ProcessTopology } from '../model/topology';

export type ExperimentStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface ExperimentProvenance {
  appVersion: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  topologyHash: string;
  specHash: string;
  requestHash: string;
  engine: 'typescript';
}

export interface ExperimentRecord {
  id: string;
  name: string;
  status: ExperimentStatus;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  idempotencyKey: string | null;
  requestHash: string;
  spec: ExperimentSpec;
  topology: ProcessTopology;
  topologyHash: string;
  progress: number;
  simMinute: number;
  queuePosition: number | null;
  summary: ExperimentSummary | null;
  samples: ExperimentSample[] | null;
  validation: ExperimentValidation | null;
  provenance: ExperimentProvenance | null;
  error: string | null;
}

export interface ExperimentStudyRow {
  id: string;
  name: string;
  status: ExperimentStatus;
  summary: ExperimentSummary | null;
  validation: ExperimentValidation | null;
  error: string | null;
}

export interface ExperimentListRow {
  id: string;
  name: string;
  status: ExperimentStatus;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  progress: number;
  summary: ExperimentSummary | null;
  error: string | null;
}

const DB_PATH = resolve(process.env.AQUAPILOT_DB ?? 'data/aquapilot.db');

type Row = Record<string, unknown>;

function text(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
function nullableNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function json<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string' || !v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

export class ExperimentStore {
  private db: DatabaseLike | null = null;
  private memory = new Map<string, ExperimentRecord>();
  private idem = new Map<string, string>();
  private readonly path: string;

  constructor(path: string = DB_PATH) {
    this.path = path;
  }

  async open(): Promise<void> {
    if (this.db) return;
    if (process.env.AQUAPILOT_PERSIST === '0') {
      logger.warn('experiment persistence disabled', { reason: 'AQUAPILOT_PERSIST=0' });
      return;
    }
    const DatabaseSync = await loadSqlite();
    if (!DatabaseSync) {
      logger.warn('experiment persistence disabled', { reason: 'node:sqlite unavailable' });
      return;
    }
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      this.db = new DatabaseSync(this.path);
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS experiments (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          started_at INTEGER,
          finished_at INTEGER,
          idempotency_key TEXT,
          request_hash TEXT NOT NULL,
          spec_json TEXT NOT NULL,
          topology_json TEXT NOT NULL,
          topology_hash TEXT NOT NULL,
          progress INTEGER NOT NULL DEFAULT 0,
          sim_minute INTEGER NOT NULL DEFAULT 0,
          queue_position INTEGER,
          summary_json TEXT,
          samples_json TEXT,
          validation_json TEXT,
          provenance_json TEXT,
          error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_experiments_status_created ON experiments(status, created_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_experiments_idempotency
          ON experiments(idempotency_key) WHERE idempotency_key IS NOT NULL;
      `);
      this.db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run('experiment_schema_version', '1');
    } catch (err) {
      logger.error('experiment persistence disabled', { reason: 'cannot open database', error: String(err) });
      this.db = null;
    }
  }

  get enabled(): boolean {
    return this.db !== null;
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      /* already closed */
    }
    this.db = null;
  }

  create(input: {
    id: string;
    name: string;
    spec: ExperimentSpec;
    topology: ProcessTopology;
    topologyHash: string;
    requestHash: string;
    idempotencyKey: string | null;
    queuePosition: number | null;
    provenance: ExperimentProvenance;
  }): ExperimentRecord {
    const now = Date.now();
    const record: ExperimentRecord = {
      id: input.id,
      name: input.name,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      spec: input.spec,
      topology: input.topology,
      topologyHash: input.topologyHash,
      progress: 0,
      simMinute: 0,
      queuePosition: input.queuePosition,
      summary: null,
      samples: null,
      validation: null,
      provenance: { ...input.provenance, createdAt: new Date(now).toISOString() },
      error: null,
    };
    if (this.db) {
      this.db
        .prepare(
          `INSERT INTO experiments
           (id,name,status,created_at,updated_at,idempotency_key,request_hash,spec_json,topology_json,
            topology_hash,progress,sim_minute,queue_position,provenance_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          record.id,
          record.name,
          record.status,
          record.createdAt,
          record.updatedAt,
          record.idempotencyKey,
          record.requestHash,
          JSON.stringify(record.spec),
          JSON.stringify(record.topology),
          record.topologyHash,
          record.progress,
          record.simMinute,
          record.queuePosition,
          JSON.stringify(record.provenance),
        );
    } else {
      this.memory.set(record.id, record);
      if (record.idempotencyKey) this.idem.set(record.idempotencyKey, record.id);
    }
    return record;
  }

  findById(id: string): ExperimentRecord | null {
    if (this.db) {
      const row = this.db.prepare('SELECT * FROM experiments WHERE id = ?').get(id) as Row | undefined;
      return row ? this.rowToRecord(row) : null;
    }
    return this.memory.get(id) ?? null;
  }

  /** Study 聚合只读 summary/validation，不读 samples/topology，避免 24 个子实验把内存放大。 */
  findStudyRows(ids: string[]): ExperimentStudyRow[] {
    if (ids.length === 0) return [];
    if (this.db) {
      const placeholders = ids.map(() => '?').join(',');
      const rows = this.db
        .prepare(
          `SELECT id,name,status,summary_json,validation_json,error FROM experiments WHERE id IN (${placeholders})`,
        )
        .all(...ids) as Row[];
      const byId = new Map(rows.map((row) => [text(row.id), row]));
      return ids.map((id) => {
        const row = byId.get(id);
        if (!row)
          return {
            id,
            name: id,
            status: 'failed' as const,
            summary: null,
            validation: null,
            error: 'experiment missing',
          };
        return {
          id: text(row.id),
          name: text(row.name),
          status: text(row.status) as ExperimentStatus,
          summary: json<ExperimentSummary | null>(row.summary_json, null),
          validation: json<ExperimentValidation | null>(row.validation_json, null),
          error: typeof row.error === 'string' ? row.error : null,
        };
      });
    }
    return ids.map((id) => {
      const record = this.memory.get(id);
      if (!record)
        return {
          id,
          name: id,
          status: 'failed' as const,
          summary: null,
          validation: null,
          error: 'experiment missing',
        };
      return {
        id: record.id,
        name: record.name,
        status: record.status,
        summary: record.summary,
        validation: record.validation,
        error: record.error,
      };
    });
  }

  findByIdempotencyKey(key: string): ExperimentRecord | null {
    if (this.db) {
      const row = this.db.prepare('SELECT * FROM experiments WHERE idempotency_key = ?').get(key) as Row | undefined;
      return row ? this.rowToRecord(row) : null;
    }
    const id = this.idem.get(key);
    return id ? (this.memory.get(id) ?? null) : null;
  }

  list(
    status: ExperimentStatus | 'all',
    limit: number,
    cursor?: { createdAt: number; id: string } | null,
  ): ExperimentListRow[] {
    const q = status === 'all' ? '' : 'status = ?';
    const cur = cursor ? ' AND (created_at < ? OR (created_at = ? AND id < ?))' : '';
    const sql =
      `SELECT id,name,status,created_at,updated_at,started_at,finished_at,progress,summary_json,error,queue_position` +
      ` FROM experiments ${q ? 'WHERE ' + q + cur : cur ? 'WHERE ' + cur.slice(5) : ''}` +
      ` ORDER BY created_at DESC, id DESC LIMIT ?`;
    if (this.db) {
      const args: unknown[] = [];
      if (status !== 'all') args.push(status);
      if (cursor) args.push(cursor.createdAt, cursor.createdAt, cursor.id);
      args.push(limit);
      const rows = this.db.prepare(sql).all(...args) as Row[];
      return rows.map((r) => ({
        id: text(r.id),
        name: text(r.name),
        status: text(r.status) as ExperimentStatus,
        createdAt: num(r.created_at),
        updatedAt: num(r.updated_at),
        startedAt: nullableNum(r.started_at),
        finishedAt: nullableNum(r.finished_at),
        progress: num(r.progress),
        summary: json<ExperimentSummary | null>(r.summary_json, null),
        error: typeof r.error === 'string' ? r.error : null,
      }));
    }
    return [...this.memory.values()]
      .filter((r) => status === 'all' || r.status === status)
      .filter(
        (r) => !cursor || r.createdAt < cursor.createdAt || (r.createdAt === cursor.createdAt && r.id < cursor.id),
      )
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        progress: r.progress,
        summary: r.summary,
        error: r.error,
      }));
  }

  countActive(): number {
    if (this.db) {
      const row = this.db
        .prepare("SELECT COUNT(*) AS n FROM experiments WHERE status IN ('queued','running')")
        .get() as Row;
      return num(row?.n);
    }
    return [...this.memory.values()].filter((r) => r.status === 'queued' || r.status === 'running').length;
  }

  markRunning(id: string, queuePosition: number | null = null): void {
    const now = Date.now();
    if (this.db) {
      this.db
        .prepare('UPDATE experiments SET status=?, started_at=?, updated_at=?, queue_position=? WHERE id=?')
        .run('running', now, now, queuePosition, id);
      return;
    }
    const r = this.memory.get(id);
    if (r) {
      r.status = 'running';
      r.startedAt = now;
      r.updatedAt = now;
      r.queuePosition = queuePosition;
    }
  }

  updateProgress(id: string, progress: number, simMinute: number): void {
    const p = Math.max(0, Math.min(100, Math.round(progress)));
    if (this.db) {
      this.db
        .prepare('UPDATE experiments SET progress=?, sim_minute=?, updated_at=? WHERE id=? AND status=?')
        .run(p, Math.round(simMinute), Date.now(), id, 'running');
      return;
    }
    const r = this.memory.get(id);
    if (r && r.status === 'running') {
      r.progress = p;
      r.simMinute = Math.round(simMinute);
      r.updatedAt = Date.now();
    }
  }

  finishSuccess(
    id: string,
    summary: ExperimentSummary,
    samples: ExperimentSample[],
    validation: ExperimentValidation,
    provenance: ExperimentProvenance,
  ): void {
    const now = Date.now();
    if (this.db) {
      this.db
        .prepare(
          `UPDATE experiments SET status=?, finished_at=?, updated_at=?, progress=100, queue_position=NULL, summary_json=?,
           samples_json=?, validation_json=?, provenance_json=?, error=NULL WHERE id=?`,
        )
        .run(
          'succeeded',
          now,
          now,
          JSON.stringify(summary),
          JSON.stringify(samples),
          JSON.stringify(validation),
          JSON.stringify(provenance),
          id,
        );
      return;
    }
    const r = this.memory.get(id);
    if (r) {
      r.status = 'succeeded';
      r.finishedAt = now;
      r.updatedAt = now;
      r.progress = 100;
      r.summary = summary;
      r.samples = samples;
      r.validation = validation;
      r.provenance = provenance;
      r.error = null;
      r.queuePosition = null;
    }
  }

  finishFailure(id: string, error: string, provenance: ExperimentProvenance): void {
    const now = Date.now();
    if (this.db) {
      this.db
        .prepare('UPDATE experiments SET status=?, finished_at=?, updated_at=?, error=?, provenance_json=? WHERE id=?')
        .run('failed', now, now, error.slice(0, 2000), JSON.stringify(provenance), id);
      return;
    }
    const r = this.memory.get(id);
    if (r) {
      r.status = 'failed';
      r.finishedAt = now;
      r.updatedAt = now;
      r.error = error.slice(0, 2000);
      r.provenance = provenance;
    }
  }

  markCancelled(id: string): boolean {
    const now = Date.now();
    if (this.db) {
      const changed = this.db
        .prepare(
          "UPDATE experiments SET status=?, finished_at=?, updated_at=?, queue_position=NULL WHERE id=? AND status IN ('queued','running')",
        )
        .run('cancelled', now, now, id);
      return (changed as { changes?: number }).changes === 1;
    }
    const r = this.memory.get(id);
    if (!r || (r.status !== 'queued' && r.status !== 'running')) return false;
    r.status = 'cancelled';
    r.finishedAt = now;
    r.updatedAt = now;
    r.queuePosition = null;
    return true;
  }

  /** 进程重启：把中断的 running 标回 queued，返回需要重新排队的记录。 */
  recover(): ExperimentRecord[] {
    if (this.db) {
      this.db.exec(
        "UPDATE experiments SET status='queued', started_at=NULL, progress=0, sim_minute=0 WHERE status='running'",
      );
      const rows = this.db
        .prepare("SELECT * FROM experiments WHERE status='queued' ORDER BY created_at ASC, id ASC")
        .all() as Row[];
      return rows.map((r) => this.rowToRecord(r));
    }
    const out: ExperimentRecord[] = [];
    for (const r of this.memory.values()) {
      if (r.status === 'running') {
        r.status = 'queued';
        r.startedAt = null;
        r.progress = 0;
        r.simMinute = 0;
        r.queuePosition = 0;
      }
      if (r.status === 'queued') out.push(r);
    }
    return out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  private rowToRecord(row: Row): ExperimentRecord {
    return {
      id: text(row.id),
      name: text(row.name),
      status: text(row.status) as ExperimentStatus,
      createdAt: num(row.created_at),
      updatedAt: num(row.updated_at),
      startedAt: nullableNum(row.started_at),
      finishedAt: nullableNum(row.finished_at),
      idempotencyKey: typeof row.idempotency_key === 'string' ? row.idempotency_key : null,
      requestHash: text(row.request_hash),
      spec: json<ExperimentSpec>(row.spec_json, {} as ExperimentSpec),
      topology: json<ProcessTopology>(row.topology_json, {} as ProcessTopology),
      topologyHash: text(row.topology_hash),
      progress: num(row.progress),
      simMinute: num(row.sim_minute),
      queuePosition: nullableNum(row.queue_position),
      summary: json<ExperimentSummary | null>(row.summary_json, null),
      samples: json<ExperimentSample[] | null>(row.samples_json, null),
      validation: json<ExperimentValidation | null>(row.validation_json, null),
      provenance: json<ExperimentProvenance | null>(row.provenance_json, null),
      error: typeof row.error === 'string' ? row.error : null,
    };
  }
}
