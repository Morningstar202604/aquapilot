/**
 * 拓扑交换格式（导出 / 导入）。
 *
 * 对标 Node-RED 的 flows.json：一张流程能整份导出、贴给同事、再导入回来。
 * 但这里有两个与纯前端不同的约束：
 *
 * 1. **必须带版本与来源**。同一份 JSON 在半年后导入时，读者要能判断它是
 *    用什么版本导出的、是不是被手工改过。所以导出带 `format` 与 `version`。
 * 2. **导入必须走服务端同一套 sanitize**。前端 `JSON.parse` 出来的是任意
 *    unknown，直接 `as ProcessTopology` 会让 null 单元、NaN 容积进引擎。
 *    导出物只是「可读散文」，不是可信输入。
 *
 * 文件格式刻意保持扁平：顶层就是 ProcessTopology 的字段，外加 format/version。
 * 这样手写、diff、代码生成都容易；嵌套一层 `{payload: {...}}` 只增加噪音。
 */

import type { ProcessTopology } from './topology';
import { sanitizeTopologyInput, type TopologySanitizeResult } from './topologyInput';

/** 当前交换格式版本；不兼容变更（字段重命名）时才递增 */
export const TOPOLOGY_FORMAT = 'aquapilot.topology';
export const TOPOLOGY_FORMAT_VERSION = 1;

/** 单份导入文件的大小上限（与 CSV 进水一致，2 MB 足够放下上万个点的走线） */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

export interface TopologyEnvelope {
  format: typeof TOPOLOGY_FORMAT;
  formatVersion: number;
  /** 导出时间（ISO 8601）。手工编辑后保留原值不影响导入 */
  exportedAt: string;
  /** 导出时的应用版本，便于排查格式差异 */
  appVersion: string;
  topology: ProcessTopology;
}

export function exportTopology(topology: ProcessTopology, appVersion: string, at = new Date()): string {
  const envelope: TopologyEnvelope = {
    format: TOPOLOGY_FORMAT,
    formatVersion: TOPOLOGY_FORMAT_VERSION,
    exportedAt: at.toISOString(),
    appVersion,
    topology,
  };
  // 2 空格缩进：这份文件的主要用途是人工阅读与 diff，不是机器传输
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

export type TopologyImportResult =
  | { ok: true; topology: ProcessTopology; meta: { exportedAt: string; appVersion: string } }
  | { ok: false; error: string };

/**
 * 解析导入文件。
 *
 * 兼容三种输入：
 * - 本系统导出的信封（带 format/topology）；
 * - 裸 ProcessTopology（早期手写或第三方工具生成）；
 * - 字符串形式的 JSON（用户从剪贴板粘贴）。
 *
 * 无论哪种，最终都交给 `sanitizeTopologyInput` 做结构 + 上限 + 引用校验，
 * 这里不做任何"尽力修复"——猜错结构的代价是引擎在运行中抛错。
 */
export function importTopology(text: string): TopologyImportResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: '内容为空' };
  if (trimmed.length > MAX_IMPORT_BYTES) {
    return { ok: false, error: `文件超过 ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)} MB 上限` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return { ok: false, error: `不是合法 JSON：${err instanceof Error ? err.message : String(err)}` };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '顶层必须是对象' };
  }

  const rec = parsed as Record<string, unknown>;
  let payload: unknown = rec;
  let exportedAt = '';
  let appVersion = '';

  if (rec.format !== undefined) {
    if (rec.format !== TOPOLOGY_FORMAT) {
      return { ok: false, error: `不认识的文件格式 ${String(rec.format)}（期望 ${TOPOLOGY_FORMAT}）` };
    }
    const v = rec.formatVersion;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
      return { ok: false, error: 'formatVersion 必须是正整数' };
    }
    if (v > TOPOLOGY_FORMAT_VERSION) {
      return {
        ok: false,
        error: `文件格式版本 ${v} 高于当前支持的 ${TOPOLOGY_FORMAT_VERSION}，请升级 AquaPilot 后再导入`,
      };
    }
    if (!rec.topology || typeof rec.topology !== 'object') {
      return { ok: false, error: '缺少 topology 字段' };
    }
    payload = rec.topology;
    exportedAt = typeof rec.exportedAt === 'string' ? rec.exportedAt : '';
    appVersion = typeof rec.appVersion === 'string' ? rec.appVersion : '';
  }

  const sanitized: TopologySanitizeResult = sanitizeTopologyInput(payload);
  if (!sanitized.ok) return { ok: false, error: sanitized.error };
  return { ok: true, topology: sanitized.topology, meta: { exportedAt, appVersion } };
}

/** 建议的文件名：把拓扑名转成安全 slug，保留中文（Windows/macOS/Linux 都接受） */
export function suggestFileName(name: string): string {
  const slug = name
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 60);
  return `aquapilot-${slug || 'topology'}.json`;
}
