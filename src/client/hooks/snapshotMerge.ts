import type { PlantSnapshot, SnapshotPatch } from '../../shared/protocol';

/**
 * 增量快照合并。
 *
 * 拆成纯函数的原因：这段合并逻辑此前内联在 WebSocket 回调里，没有测试覆盖，
 * 于是漏掉了三个字段——controls / totals / fmRatio。
 * 后果很具体：AI 自动执行后界面滑块停在旧值；「累计处理水量」永远不涨；
 * F/M 一直显示连接时的快照值。合并规则必须可单测。
 */

/**
 * 增量帧的可信度检查。
 *
 * 全量快照有 `isUsableSnapshot` 兜底，增量帧此前只查三个字段是否存在：
 * 一个 `effluent: {}` 就能通过，随后界面 `.toFixed()` 直接崩溃整页。
 * 协议漂移是现实风险（服务端与客户端可能不同版本），因此这里做逐字段
 * 数值校验——不通过就丢弃整帧，保留上一帧比显示脏数据安全。
 */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function hasNumericFields(obj: unknown, keys: readonly string[]): boolean {
  if (!obj || typeof obj !== 'object') return false;
  const rec = obj as Record<string, unknown>;
  return keys.every((k) => isFiniteNumber(rec[k]));
}

const EFFLUENT_KEYS = ['flow', 'cod', 'bod', 'ss', 'nh', 'tn', 'tp'] as const;
const INFLUENT_KEYS = ['flow', 'cod', 'bod', 'ss', 'nh', 'tn', 'tp', 'temperature', 'alkalinity'] as const;
const ENERGY_KEYS = ['totalKw', 'specificKwhM3'] as const;
const TOTALS_KEYS = ['inflowM3', 'energyKwh', 'cost', 'wasteSludgeKg', 'elapsedMin'] as const;
const HEALTH_KEYS = ['score'] as const;

export function isUsablePatch(patch: unknown): patch is SnapshotPatch {
  if (!patch || typeof patch !== 'object') return false;
  const p = patch as Record<string, unknown>;
  if (!isFiniteNumber(p.timeMin)) return false;
  if (!hasNumericFields(p.effluent, EFFLUENT_KEYS)) return false;
  if (!hasNumericFields(p.influent, INFLUENT_KEYS)) return false;
  if (!Array.isArray(p.tanks)) return false;
  if (
    !p.tanks.every(
      (t: unknown) =>
        !!t &&
        typeof t === 'object' &&
        typeof (t as Record<string, unknown>).id === 'string' &&
        hasNumericFields(t, ['do', 'mlss']),
    )
  )
    return false;
  if (!hasNumericFields(p.clarifier, ['blanketM', 'xRas', 'xEff', 'slr'])) return false;
  if (!hasNumericFields(p.energy, ENERGY_KEYS)) return false;
  if (!hasNumericFields(p.cost, ['totalToday', 'total'])) return false;
  if (!hasNumericFields(p.totals, TOTALS_KEYS)) return false;
  if (!isFiniteNumber(p.srtDays) || !isFiniteNumber(p.fmRatio) || !isFiniteNumber(p.score)) return false;
  if (!Array.isArray(p.margins)) return false;
  if (!Array.isArray(p.trendsAppend)) return false;
  const health = p.health as Record<string, unknown>;
  if (!hasNumericFields(health, HEALTH_KEYS)) return false;
  if (!['good', 'watch', 'bad'].includes(String(health.grade))) return false;
  if (!Array.isArray(health.parts)) return false;
  if (typeof p.reactorCount !== 'number' || !Number.isFinite(p.reactorCount)) return false;
  return true;
}

/**
 * 合并一帧增量。
 *
 * `tanks` 必须以补丁为准而不是叠加：拓扑增删单元后，
 * 只按 id 叠加会让新建的池子永远不出现、删掉的池子永远留在界面上。
 * 补丁里没有的 id 说明该单元已不存在，直接从结果里剔除。
 */
export function mergeSnapshot(prev: PlantSnapshot, patch: SnapshotPatch): PlantSnapshot {
  if (!isUsablePatch(patch)) return prev;
  const tankById = new Map(patch.tanks.map((t) => [t.id, t]));
  return {
    ...prev,
    timeMin: patch.timeMin,
    influent: { ...prev.influent, ...patch.influent },
    effluent: { ...patch.effluent },
    tanks: prev.tanks.flatMap((t) => {
      const p = tankById.get(t.id);
      if (!p) return [];
      return [{ ...t, ...p }];
    }),
    clarifier: { ...prev.clarifier, ...patch.clarifier },
    energy: { ...patch.energy },
    cost: { ...prev.cost, ...patch.cost },
    srtDays: patch.srtDays,
    fmRatio: patch.fmRatio,
    controls: patch.controls,
    scenario: patch.scenario,
    totals: patch.totals,
    score: patch.score,
    margins: patch.margins,
    trends: patch.trendsAppend.length > 0 ? [...prev.trends, ...patch.trendsAppend].slice(-720) : prev.trends,
    alarms: patch.alarms ?? prev.alarms,
    activeAlarms: patch.activeAlarms,
    alarmAttribution: patch.alarmAttribution ?? prev.alarmAttribution,
    health: patch.health ?? prev.health,
    stormStorageM3: patch.stormStorageM3,
    reactorCount: patch.reactorCount,
    /**
     * 预测扇区与双跑摘要也必须合并。
     *
     * 它们此前只在全量快照里带：连接后趋势图的预测区永远停在连接那一刻，
     * 收益面板的「AI vs 固定策略」也是一份不动的旧数据。两者都是运行中
     * 持续变化的量，不合并就是假实时。
     */
    forecastBand: patch.forecastBand ?? prev.forecastBand,
    benchmark: patch.benchmark ?? prev.benchmark,
  };
}
