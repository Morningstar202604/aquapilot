import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PLANT_TOPOLOGY, type ProcessTopology } from '../model/topology';
import { sanitizeTopologyInput } from '../model/topologyInput';
import { logger } from './observability';

/**
 * 工艺拓扑的持久化。
 *
 * 为什么需要：编排器里的图是「文档」，不是一次性会话状态。此前的行为是
 * 客户端刷新还在（拓扑在服务端内存里），但服务重启就回到标准厂——
 * 用户辛苦拖好的布局、折点、增删的池子全部丢失，而且没有任何提示。
 *
 * 与 llm-config / agent-config 同一套做法：0600 的 JSON、原子替换、
 * 启动时校验。损坏或不可运行时退回标准厂并记录告警，绝不让服务起不来。
 */

const DEFAULT_PATH = resolve(process.env.AQUAPILOT_TOPOLOGY ?? 'data/topology.json');

interface StoredTopology {
  savedAt: string;
  revision: number;
  topology: ProcessTopology;
}

export interface LoadResult {
  topology: ProcessTopology;
  /** 是否来自磁盘（false = 使用标准厂） */
  restored: boolean;
  /** 读取失败时的可读原因，供启动日志与自检展示 */
  warning?: string;
}

export class TopologyStore {
  constructor(private readonly path: string = DEFAULT_PATH) {}

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

  save(topology: ProcessTopology, revision: number): void {
    const payload: StoredTopology = { savedAt: new Date().toISOString(), revision, topology };
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (err) {
      // 持久化失败不能中断拓扑应用：仿真继续跑，但要在日志里留痕
      logger.warn('topology snapshot save failed', { error: String(err), path: this.path });
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* 临时文件不存在即可 */
      }
    }
  }
}
