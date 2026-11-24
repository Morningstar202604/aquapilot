/**
 * Study 的持久化层：只存研究定义与子实验 ID，不重复存子实验结果。
 * 子实验结果由 ExperimentStore 持有，Study 聚合时按 ID 读取 summary/validation。
 */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadSqlite, type DatabaseLike } from './store';
import { logger } from './observability';
import type { StudySpec } from '../sim/study';

const DB_PATH = resolve(process.env.AQUAPILOT_DB ?? 'data/aquapilot.db');

type Row = Record<string, unknown>;

export interface StudyRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  idempotencyKey: string | null;
  requestHash: string;
  spec: StudySpec;
  childIds: string[];
  error: string | null;
}

function text(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
function json<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string' || !v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

export class StudyStore {
  private db: DatabaseLike | null = null;
  private memory = new Map<string, StudyRecord>();
  private idem = new Map<string, string>();
  private readonly path: string;

  constructor(path: string = DB_PATH) {
    this.path = path;
  }

  async open(): Promise<void> {
    if (this.db) return;
    if (process.env.AQUAPILOT_PERSIST === '0') {
      logger.warn('study persistence disabled', { reason: 'AQUAPILOT_PERSIST=0' });
      return;
    }
    const DatabaseSync = await loadSqlite();
    if (!DatabaseSync) {
      logger.warn('study persistence disabled', { reason: 'node:sqlite unavailable' });
      return;
    }
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      this.db = new DatabaseSync(this.path);
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS studies (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          idempotency_key TEXT,
          request_hash TEXT NOT NULL,
          spec_json TEXT NOT NULL,
          child_ids_json TEXT NOT NULL,
          error TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_studies_idempotency
          ON studies(idempotency_key) WHERE idempotency_key IS NOT NULL;
      `);
    } catch (err) {
      logger.error('study persistence disabled', { reason: 'cannot open database', error: String(err) });
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
    requestHash: string;
    idempotencyKey: string | null;
    spec: StudySpec;
  }): StudyRecord {
    const now = Date.now();
    const record: StudyRecord = {
      id: input.id,
      name: input.name,
      createdAt: now,
      updatedAt: now,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      spec: input.spec,
      childIds: [],
      error: null,
    };
    if (this.db) {
      this.db
        .prepare(
          `INSERT INTO studies
           (id,name,created_at,updated_at,idempotency_key,request_hash,spec_json,child_ids_json)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(
          record.id,
          record.name,
          record.createdAt,
          record.updatedAt,
          record.idempotencyKey,
          record.requestHash,
          JSON.stringify(record.spec),
          JSON.stringify(record.childIds),
        );
    } else {
      this.memory.set(record.id, record);
      if (record.idempotencyKey) this.idem.set(record.idempotencyKey, record.id);
    }
    return record;
  }

  setChildren(id: string, childIds: string[]): void {
    const updatedAt = Date.now();
    const record = this.memory.get(id);
    if (record) {
      record.childIds = childIds;
      record.updatedAt = updatedAt;
    }
    this.db
      ?.prepare('UPDATE studies SET child_ids_json=?, updated_at=? WHERE id=?')
      .run(JSON.stringify(childIds), updatedAt, id);
  }

  markError(id: string, error: string): void {
    const updatedAt = Date.now();
    const record = this.memory.get(id);
    if (record) record.error = error;
    this.db?.prepare('UPDATE studies SET error=?, updated_at=? WHERE id=?').run(error, updatedAt, id);
  }

  findById(id: string): StudyRecord | null {
    if (this.db) {
      const row = this.db.prepare('SELECT * FROM studies WHERE id = ?').get(id) as Row | undefined;
      return row ? this.rowToRecord(row) : null;
    }
    return this.memory.get(id) ?? null;
  }

  findByIdempotencyKey(key: string): StudyRecord | null {
    if (this.db) {
      const row = this.db.prepare('SELECT * FROM studies WHERE idempotency_key = ?').get(key) as Row | undefined;
      return row ? this.rowToRecord(row) : null;
    }
    const id = this.idem.get(key);
    return id ? (this.memory.get(id) ?? null) : null;
  }

  list(limit: number): StudyRecord[] {
    if (this.db) {
      const rows = this.db
        .prepare('SELECT * FROM studies ORDER BY created_at DESC, id DESC LIMIT ?')
        .all(Math.min(100, Math.max(1, limit))) as Row[];
      return rows.map((row) => this.rowToRecord(row));
    }
    return [...this.memory.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  private rowToRecord(row: Row): StudyRecord {
    return {
      id: text(row.id),
      name: text(row.name),
      createdAt: num(row.created_at),
      updatedAt: num(row.updated_at),
      idempotencyKey: typeof row.idempotency_key === 'string' ? row.idempotency_key : null,
      requestHash: text(row.request_hash),
      spec: json<StudySpec>(row.spec_json, {} as StudySpec),
      childIds: json<string[]>(row.child_ids_json, []),
      error: typeof row.error === 'string' ? row.error : null,
    };
  }
}
