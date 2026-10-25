import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { logger, metrics } from './observability';

/** 持久化表名白名单：任何拼进 SQL 的表名都必须出自这里，禁止任意字符串拼接 */
export const PERSIST_TABLES = ['decisions', 'alarms', 'snapshots'] as const;
export type PERSIST_TABLE = (typeof PERSIST_TABLES)[number];

/**
 * node:sqlite 是 Node 22+ 的内置模块；Node 20 上不存在。
 *
 * 因此这里做条件加载：拿不到就自动降级为「不持久化」，
 * 而不是让整个服务启动失败。持久化是增强项，不是运行前提。
 * （CI 在 Node 20 上失败过一次，就是因为静态 import 直接抛错。）
 */
type DatabaseLike = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
    get(...args: unknown[]): unknown;
  };
  close(): void;
};

async function loadSqlite(): Promise<(new (path: string) => DatabaseLike) | null> {
  try {
    // 动态 import：Node 20 上该模块不存在，catch 后降级而不是崩溃
    const mod = (await import('node:sqlite')) as unknown as {
      DatabaseSync?: new (path: string) => DatabaseLike;
    };
    return mod.DatabaseSync ?? null;
  } catch {
    return null;
  }
}

/**
 * 持久化层。
 *
 * 用 Node 内置的 node:sqlite（零依赖，无需编译原生模块）。
 * 存三类东西：决策记录、告警、周期性快照——足够支持"回放"与"事后追责"。
 *
 * 设计取舍：
 * - WAL 模式，避免写入阻塞读取
 * - 只存必要字段，快照按分钟抽样而非每 tick
 * - 表结构随版本号迁移，避免破坏既有数据
 */

const DB_PATH = resolve(process.env.AQUAPILOT_DB ?? 'data/aquapilot.db');

export interface DecisionRow {
  runId?: string;
  atMin: number;
  action: string;
  severity: string;
  summary: string;
  tweaks: string;
  predictedScore: number;
  separation: number;
}

export interface AlarmRow {
  id: string;
  atMin: number;
  severity: string;
  code: string;
  message: string;
}

export interface BackupManifest {
  format: 'aquapilot-backup';
  version: 1;
  createdAt: string;
  sourcePath: string;
  bytes: number;
  counts: { decisions: number; alarms: number; snapshots: number };
}

export interface RestoreResult {
  ok: boolean;
  reason?: string;
  manifest?: BackupManifest;
}

export interface SnapshotRow {
  runId?: string;
  atMin: number;
  effluentCod: number;
  effluentNh: number;
  effluentTn: number;
  effluentTp: number;
  effluentSs: number;
  mlss: number;
  srtDays: number;
  energyKw: number;
  score: number;
}

export class Store {
  private db: DatabaseLike | null = null;
  private writeBuffer: { decisions: DecisionRow[]; alarms: AlarmRow[]; snapshots: SnapshotRow[] } = {
    decisions: [],
    alarms: [],
    snapshots: [],
  };
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly path: string = DB_PATH) {}

  async open(): Promise<void> {
    if (process.env.AQUAPILOT_PERSIST === '0') return;
    const DatabaseSync = await loadSqlite();
    if (!DatabaseSync) {
      logger.warn('persistence disabled', { reason: 'node:sqlite unavailable' });
      return;
    }
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      this.db = new DatabaseSync(this.path);
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS decisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT, at_min REAL NOT NULL, action TEXT, severity TEXT, summary TEXT,
          tweaks TEXT, predicted_score REAL, separation REAL
        );
        CREATE TABLE IF NOT EXISTS alarms (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          alarm_id TEXT, at_min REAL NOT NULL, severity TEXT, code TEXT, message TEXT
        );
        CREATE TABLE IF NOT EXISTS snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT, at_min REAL NOT NULL, cod REAL, nh REAL, tn REAL, tp REAL, ss REAL,
          mlss REAL, srt REAL, energy_kw REAL, score REAL
        );
        CREATE INDEX IF NOT EXISTS idx_decisions_at ON decisions(at_min);
        CREATE INDEX IF NOT EXISTS idx_snapshots_at ON snapshots(at_min);
        CREATE INDEX IF NOT EXISTS idx_snapshots_run ON snapshots(run_id);
      `);
      // 迁移：给旧表补 run_id 列（SQLite 不支持 IF NOT EXISTS 加列，用 try 包裹）
      for (const table of PERSIST_TABLES) {
        try {
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN run_id TEXT`);
        } catch {
          /* 已存在 */
        }
      }
      this.db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run('schema_version', '2');
      this.flushTimer = setInterval(() => this.flush(), 5000);
    } catch (err) {
      logger.error('persistence disabled', { reason: 'cannot open database', error: String(err) });
      this.db = null;
    }
  }

  get enabled(): boolean {
    return this.db !== null;
  }

  recordDecision(row: DecisionRow): void {
    if (!this.db) return;
    this.writeBuffer.decisions.push(row);
  }

  recordAlarm(row: AlarmRow): void {
    if (!this.db) return;
    this.writeBuffer.alarms.push(row);
  }

  recordSnapshot(row: SnapshotRow): void {
    if (!this.db) return;
    this.writeBuffer.snapshots.push(row);
  }

  /** 批量写入，避免每 tick 都落盘 */
  flush(): void {
    if (!this.db) return;
    const d = this.writeBuffer.decisions;
    const a = this.writeBuffer.alarms;
    const s = this.writeBuffer.snapshots;
    if (!d.length && !a.length && !s.length) return;

    try {
      this.db.exec('BEGIN');
      const insD = this.db.prepare(
        'INSERT INTO decisions(run_id,at_min,action,severity,summary,tweaks,predicted_score,separation) VALUES(?,?,?,?,?,?,?,?)',
      );
      for (const r of d)
        insD.run(r.runId ?? null, r.atMin, r.action, r.severity, r.summary, r.tweaks, r.predictedScore, r.separation);

      const insA = this.db.prepare('INSERT INTO alarms(alarm_id,at_min,severity,code,message) VALUES(?,?,?,?,?)');
      for (const r of a) insA.run(r.id, r.atMin, r.severity, r.code, r.message);

      const insS = this.db.prepare(
        'INSERT INTO snapshots(run_id,at_min,cod,nh,tn,tp,ss,mlss,srt,energy_kw,score) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      );
      for (const r of s) {
        insS.run(
          r.runId ?? null,
          r.atMin,
          r.effluentCod,
          r.effluentNh,
          r.effluentTn,
          r.effluentTp,
          r.effluentSs,
          r.mlss,
          r.srtDays,
          r.energyKw,
          r.score,
        );
      }
      this.db.exec('COMMIT');
      this.writeBuffer = { decisions: [], alarms: [], snapshots: [] };
      metrics.persistenceFlushes += 1;
    } catch (err) {
      metrics.persistenceErrors += 1;
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* 事务可能已中止 */
      }
      logger.error('persistence flush failed', { error: String(err) });
    }
  }

  /** 读取最近 N 条决策，用于回放与界面 */
  recentDecisions(limit = 50): DecisionRow[] {
    if (!this.db) return [];
    return this.db
      .prepare(
        'SELECT run_id as runId, at_min as atMin, action, severity, summary, tweaks, predicted_score as predictedScore, separation FROM decisions ORDER BY id DESC LIMIT ?',
      )
      .all(limit) as unknown as DecisionRow[];
  }

  /** 读取时间窗口内的快照，用于趋势回放 */
  /**
   * 时间窗口内的快照。
   *
   * 必须限定 run_id：仿真时钟在每次重启时归零，
   * 不同run 的 at_min 会重叠，不加限制会得到锯齿状的假曲线。
   * 默认只返回最近一次运行。
   */
  snapshotsBetween(fromMin: number, toMin: number, runId?: string): SnapshotRow[] {
    if (!this.db) return [];
    const latest = this.latestRunId();
    const useRun = runId ?? latest;
    const sql = useRun
      ? `SELECT run_id as runId, at_min as atMin, cod as effluentCod, nh as effluentNh, tn as effluentTn,
                tp as effluentTp, ss as effluentSs, mlss, srt as srtDays, energy_kw as energyKw, score
         FROM snapshots WHERE at_min BETWEEN ? AND ? AND run_id = ? ORDER BY at_min ASC`
      : `SELECT run_id as runId, at_min as atMin, cod as effluentCod, nh as effluentNh, tn as effluentTn,
                tp as effluentTp, ss as effluentSs, mlss, srt as srtDays, energy_kw as energyKw, score
         FROM snapshots WHERE at_min BETWEEN ? AND ? ORDER BY at_min ASC`;
    return this.db
      .prepare(sql)
      .all(...(useRun ? [fromMin, toMin, useRun] : [fromMin, toMin])) as unknown as SnapshotRow[];
  }

  /** 最近一次运行的标识 */
  latestRunId(): string | null {
    if (!this.db) return null;
    const row = this.db
      .prepare('SELECT run_id as runId FROM snapshots WHERE run_id IS NOT NULL ORDER BY id DESC LIMIT 1')
      .get() as unknown as { runId: string } | undefined;
    return row?.runId ?? null;
  }

  /** 所有运行时段，用于回放时选择 */
  listRuns(): { runId: string; fromMin: number; toMin: number; points: number }[] {
    if (!this.db) return [];
    return this.db
      .prepare(
        `SELECT run_id as runId, MIN(at_min) as fromMin, MAX(at_min) as toMin, COUNT(*) as points
         FROM snapshots WHERE run_id IS NOT NULL GROUP BY run_id ORDER BY MAX(id) DESC LIMIT 20`,
      )
      .all() as unknown as { runId: string; fromMin: number; toMin: number; points: number }[];
  }

  count(): { decisions: number; alarms: number; snapshots: number } {
    if (!this.db) return { decisions: 0, alarms: 0, snapshots: 0 };
    // 表名只能来自白名单常量，不允许字符串拼接进 SQL（防御性约束，防未来误用）
    const one = (table: PERSIST_TABLE) =>
      (this.db!.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as unknown as { c: number }).c;
    return { decisions: one('decisions'), alarms: one('alarms'), snapshots: one('snapshots') };
  }

  /**
   * 一致性备份。
   *
   * 不能直接 copyFile 正在写入的库：WAL 模式下的主文件可能缺最新事务，
   * 复制出来的库会"回退几秒"甚至损坏。正确做法是先 flush 缓冲，
   * 再用 SQLite 的 VACUUM INTO 生成一致性快照（单文件、无 WAL 依赖）。
   */
  backupTo(targetPath: string): BackupManifest {
    if (!this.db) throw new Error('持久化未启用，无法备份');
    this.flush();
    const target = resolve(targetPath);
    mkdirSync(dirname(target), { recursive: true });
    // VACUUM INTO 不接受参数化路径，必须先做引号转义
    this.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    const manifest: BackupManifest = {
      format: 'aquapilot-backup',
      version: 1,
      createdAt: new Date().toISOString(),
      sourcePath: this.path,
      bytes: statSync(target).size,
      counts: this.count(),
    };
    logger.info('backup written', { target, bytes: manifest.bytes });
    return manifest;
  }

  /** 从备份恢复：先校验是新库（能打开且含三张表），再原子替换 */
  static async restoreFrom(backupPath: string, dbPath: string): Promise<RestoreResult> {
    const source = resolve(backupPath);
    if (!existsSync(source)) return { ok: false, reason: `备份文件不存在：${source}` };

    // 在临时目录里先打开一次，确认文件确实是本应用的库
    const probeDir = mkdtempSync(join(tmpdir(), 'aquapilot-restore-'));
    const probePath = join(probeDir, 'probe.db');
    copyFileSync(source, probePath);
    const probe = new Store(probePath);
    try {
      await probe.open();
      if (!probe.enabled) return { ok: false, reason: '备份文件无法作为 SQLite 打开（文件损坏或格式不符）' };
      const counts = probe.count();
      if (counts.snapshots === 0 && counts.decisions === 0 && counts.alarms === 0) {
        return { ok: false, reason: '备份文件可打开但没有任何数据' };
      }
      probe.close();

      const target = resolve(dbPath);
      mkdirSync(dirname(target), { recursive: true });
      // 先写临时文件再 rename：避免恢复到一半的库被服务读走
      const staging = `${target}.restore-${Date.now()}`;
      copyFileSync(source, staging);
      renameSync(staging, target);
      // 旧的 WAL/SHM 与新主文件不匹配，必须清掉
      for (const suffix of ['-wal', '-shm']) {
        try {
          rmSync(`${target}${suffix}`, { force: true });
        } catch {
          /* 不存在即可 */
        }
      }
      const manifest: BackupManifest = {
        format: 'aquapilot-backup',
        version: 1,
        createdAt: new Date().toISOString(),
        sourcePath: source,
        bytes: statSync(target).size,
        counts,
      };
      logger.info('backup restored', { target, counts });
      return { ok: true, manifest };
    } catch (err) {
      return { ok: false, reason: `备份文件无法读取：${String(err)}` };
    } finally {
      try {
        probe.close();
      } catch {
        /* 探测库可能根本没打开 */
      }
      // Windows 上句柄释放有延迟，清理失败不应让恢复流程报错
      try {
        rmSync(probeDir, { recursive: true, force: true });
      } catch {
        /* 留在临时目录里也无妨 */
      }
    }
  }

  /**
   * 测试专用注入点：拿到原始句柄以模拟磁盘故障。
   * 不暴露给生产调用方——它只是让"写失败路径"可被测到。
   */
  __rawDbForTests(): DatabaseLike | null {
    return this.db;
  }

  close(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flush();
    this.db?.close();
    this.db = null;
  }
}
