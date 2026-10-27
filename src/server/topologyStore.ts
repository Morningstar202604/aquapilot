import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PLANT_TOPOLOGY, type ProcessTopology } from '../model/topology';
import { sanitizeTopologyInput } from '../model/topologyInput';
import type { TopologyVersionSummary } from '../shared/protocol';
import { logger } from './observability';

/**
 * 工艺拓扑的持久化与版本历史。
 *
 * 为什么需要：编排器里的图是「文档」，不是一次性会话状态。此前服务重启就回到
 * 标准厂，用户拖好的布局与折点全部丢失；而且没有任何"回到上一版"的能力。
 *
 * 两个文件，职责分开：
 * - 活动拓扑（topology.json）：启动时恢复，单条记录；
 * - 版本历史（topology-history.json）：最近 N 版，供审计与回滚。
 * 两者都 0600、原子替换、读取时过 sanitizeTopologyInput。损坏时回退并留日志，
 * 绝不让服务起不来。
 */

const DEFAULT_PATH = resolve(process.env.AQUAPILOT_TOPOLOGY ?? 'data/topology.json');
const DEFAULT_HISTORY_PATH = resolve(process.env.AQUAPILOT_TOPOLOGY_HISTORY ?? 'data/topology-history.json');

/** 历史保留版本数；每版约 18 KB，20 版约 360 KB，足够审计又不至于膨胀 */
export const MAX_TOPOLOGY_VERSIONS = 20;

interface StoredTopology {
  savedAt: string;
  revision: number;
  topology: ProcessTopology;
}

interface StoredVersion extends TopologyVersionSummary {
  topology: ProcessTopology;
}

export interface LoadResult {
  topology: ProcessTopology;
  /** 是否来自磁盘（false = 使用标准厂） */
  restored: boolean;
  /** 读取失败时的可读原因，供启动日志与自检展示 */
  warning?: string;
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    logger.warn('topology write failed', { error: String(err), path });
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 临时文件不存在即可 */
    }
  }
}

export class TopologyStore {
  constructor(
    private readonly path: string = DEFAULT_PATH,
    private readonly historyPath: string = DEFAULT_HISTORY_PATH,
  ) {}

  load(): LoadResult {
    if (!existsSync(this.path)) return { topology: PLANT_TOPOLOGY, restored: false };
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StoredTopology>;
      const sanitized = sanitizeTopologyInput(raw.topology);
      if (!sanitized.ok) {
        logger.warn('topology snapshot rejected', { reason: sanitized.error, path: this.path });
        return { topology: PLANT_TOPOLOGY, restored: false, warning: `已保存的拓扑不合法：${sanitized.error}` };
      }
      return { topology: sanitized.topology, restored: true };
    } catch (err) {
      logger.warn('topology snapshot unreadable', { error: String(err), path: this.path });
      return { topology: PLANT_TOPOLOGY, restored: false, warning: '已保存的拓扑无法解析，已回退到标准厂' };
    }
  }

  /**
   * 保存活动拓扑，并追加一条历史。
   *
   * `label` 是给人看的版本说明。同一 revision 重复保存只更新该条（幂等），
   * 避免客户端重试造成重复历史。
   */
  save(topology: ProcessTopology, revision: number, label = '应用拓扑'): void {
    const payload: StoredTopology = { savedAt: new Date().toISOString(), revision, topology };
    atomicWriteJson(this.path, payload);
    this.appendVersion(topology, revision, label, payload.savedAt);
  }

  /**
   * 只记历史、不写活动文件。
   *
   * 启动时把当前生效的拓扑作为基线记入历史（v1），这样操作员至少能回滚到
   * 「服务启动时的样子」；但它不是一次用户动作，不该反过来覆盖活动文件。
   * 同一 revision 已存在时不重复写入。
   */
  seedBaseline(topology: ProcessTopology, revision: number, label = '启动基线'): void {
    if (this.readVersions().some((v) => v.revision === revision)) return;
    this.appendVersion(topology, revision, label, new Date().toISOString());
  }

  private appendVersion(topology: ProcessTopology, revision: number, label: string, savedAt: string): void {
    const versions = this.readVersions();
    const entry: StoredVersion = {
      revision,
      savedAt,
      label,
      name: topology.name,
      units: topology.units.length,
      connections: topology.connections.length,
      topology,
    };
    const withoutSame = versions.filter((v) => v.revision !== revision);
    withoutSame.push(entry);
    withoutSame.sort((a, b) => a.revision - b.revision);
    const trimmed = withoutSame.slice(-MAX_TOPOLOGY_VERSIONS);
    atomicWriteJson(this.historyPath, { versions: trimmed });
  }

  /** 版本摘要列表，最新在前 */
  history(): TopologyVersionSummary[] {
    return this.readVersions()
      .slice()
      .sort((a, b) => b.revision - a.revision)
      .map(({ topology: _topology, ...summary }) => summary);
  }

  /** 取某一版的完整拓扑（已过输入校验）；不存在返回 null */
  version(revision: number): ProcessTopology | null {
    const hit = this.readVersions().find((v) => v.revision === revision);
    return hit ? hit.topology : null;
  }

  /**
   * 读取并净化历史条目。
   *
   * 历史文件可能被手工编辑或写入坏数据：逐条过 sanitizeTopologyInput，
   * 坏条目丢弃而不是让整个历史不可用（审计信息宁可少一条，不能全丢）。
   */
  private readVersions(): StoredVersion[] {
    if (!existsSync(this.historyPath)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.historyPath, 'utf8')) as { versions?: unknown };
      if (!Array.isArray(raw.versions)) return [];
      const out: StoredVersion[] = [];
      for (const item of raw.versions) {
        if (!item || typeof item !== 'object') continue;
        const v = item as Record<string, unknown>;
        if (typeof v.revision !== 'number' || !Number.isFinite(v.revision)) continue;
        const sanitized = sanitizeTopologyInput(v.topology);
        if (!sanitized.ok) {
          logger.warn('topology history entry rejected', { revision: v.revision, reason: sanitized.error });
          continue;
        }
        out.push({
          revision: v.revision,
          savedAt: typeof v.savedAt === 'string' ? v.savedAt : new Date(0).toISOString(),
          label: typeof v.label === 'string' ? v.label.slice(0, 120) : '未标注',
          name: sanitized.topology.name,
          units: sanitized.topology.units.length,
          connections: sanitized.topology.connections.length,
          topology: sanitized.topology,
        });
      }
      return out.sort((a, b) => a.revision - b.revision).slice(-MAX_TOPOLOGY_VERSIONS);
    } catch (err) {
      logger.warn('topology history unreadable', { error: String(err), path: this.historyPath });
      return [];
    }
  }
}
