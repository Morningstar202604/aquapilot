import type { PlantSnapshot, SnapshotPatch } from '../../shared/protocol';

/**
 * 增量快照合并。
 *
 * 拆成纯函数的原因：这段合并逻辑此前内联在 WebSocket 回调里，没有测试覆盖，
 * 于是漏掉了三个字段——controls / totals / fmRatio。
 * 后果很具体：AI 自动执行后界面滑块停在旧值；「累计处理水量」永远不涨；
 * F/M 一直显示连接时的快照值。合并规则必须可单测。
 */

export function mergeSnapshot(prev: PlantSnapshot, patch: SnapshotPatch): PlantSnapshot {
  if (!patch || typeof patch.timeMin !== 'number' || !patch.effluent || !Array.isArray(patch.tanks)) return prev;
  return {
    ...prev,
    timeMin: patch.timeMin,
    influent: { ...prev.influent, flow: patch.influentFlow },
    effluent: patch.effluent,
    tanks: prev.tanks.map((t) => {
      const p = patch.tanks.find((x) => x.id === t.id);
      return p ? { ...t, ...p } : t;
    }),
    clarifier: { ...prev.clarifier, ...patch.clarifier },
    energy: patch.energy,
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
