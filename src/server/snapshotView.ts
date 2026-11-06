import { BSM1_SETTLER } from '../sim/takacs';
import { evaluateAlarms } from '../sim/alarmRules';
import { qualityScoreOf, type NetworkSimState } from '../sim/networkEngine';
import { estimateMargin } from '../sim/metrics';
import { attributeAlarm, plantHealth, trendSlopes, type AlarmAttribution } from '../sim/alarmAttribution';
import { LIMITS } from '../sim/config';
import type { PlantSnapshot, SnapshotPatch, TrendPoint } from '../shared/protocol';
import type { ProcessTopology } from '../model/topology';
import type { Recommendation } from '../ai/agent';
import type { ForecastOutcomeX } from '../sim/plantModel';
import type { BenchmarkSummary } from '../shared/protocol';
import type { ShadowBenchmark } from './benchmark';
import { buildTankPatch, buildTankStates } from './tankStates';
import { takeNewPoints, type TrendCursor } from './trendCursor';
import { scorecardFromTrend } from '../sim/scorecard';
import { DEFAULT_STANDARD } from '../sim/standards';

/**
 * 快照视图：把仿真状态投影成「浏览器要看的形状」。
 *
 * 为什么单独成模块：这段代码此前埋在 server/index.ts 的 2500 行里，
 * 它是整个服务端最容易改错的地方（新增一个字段要同时改全量帧与增量帧，
 * 漏一个就会出现「界面显示连接那一刻的旧值」这种假实时缺陷）。
 * 单独成文件后，两帧的口径对照可以在一屏内读完。
 */

/** 快照构造所需的最小运行时视图（结构类型，避免与入口互相依赖） */
export interface SnapshotSource {
  topology: ProcessTopology;
  net: NetworkSimState;
  trend: TrendPoint[];
  speed: number;
  /** 当前判读用的排放标准（缺省一级 A）；由入口注入，便于切换口径 */
  standard?: import('../sim/standards').DischargeStandard;
  paused: boolean;
  recommendation: Recommendation | null;
  forecastCache: { key: string | null; value: ForecastOutcomeX | null };
  shadow: { benchmark: ShadowBenchmark };
}

export interface SnapshotDeps {
  source: () => SnapshotSource;
  /** 预测缓存策略由调用方提供（依赖 networkModel，属仿真层） */
  forecastFor: (net: NetworkSimState, topology: ProcessTopology) => ForecastOutcomeX | null;
  summarizeBenchmark: (b: ShadowBenchmark) => BenchmarkSummary;
}

export interface DerivedFrame {
  activeAlarms: ReturnType<typeof evaluateAlarms>;
  margins: ReturnType<typeof estimateMargin>;
  health: ReturnType<typeof plantHealth>;
  attribution: Record<string, AlarmAttribution>;
}

function totalsOf(s: NetworkSimState): PlantSnapshot['totals'] {
  return {
    inflowM3: s.totals.inflowM3,
    energyKwh: s.totals.energyKwh,
    cost: s.cost.total,
    wasteSludgeKg: s.totals.wasteSludgeKg,
    elapsedMin: s.timeMin,
    energyCost: s.cost.energy,
    chemicalCost: s.cost.chemical,
    sludgeCost: s.cost.sludge,
  };
}

export function createSnapshotService(deps: SnapshotDeps) {
  /**
   * 派生量的计算成本（实测，2000 次平均）：
   *   evaluateAlarms 0.3 µs + estimateMargin 2.1 µs + plantHealth 4.0 µs ≈ 6.3 µs/帧
   * 这个量级远小于「按控制量拼 key 再查表」的成本（浮点转字符串比计算本身更贵），
   * 因此这里**不做跨帧缓存**——缓存只会是负优化（实测慢 64%）。
   *
   * 真正需要消除的是「每个连接各算一遍」：调用方（broadcastPatch）现在
   * 每帧只构造一次 DerivedFrame，再分发给所有连接。
   */

  function currentAlarms(s: NetworkSimState) {
    const last = s.reactors[s.reactors.length - 1];
    return evaluateAlarms({
      effluent: s.effluent,
      lastDo: last?.doLevel ?? 0,
      srtDays: s.srtDays,
      blanketM: s.clarifier.blanketM,
      depth: s.clarifier.depth,
      atMin: s.timeMin,
    });
  }

  function buildAttribution(
    s: NetworkSimState,
    alarms: ReturnType<typeof currentAlarms>,
  ): Record<string, AlarmAttribution> {
    const slopes = trendSlopes(deps.source().trend, s.effluent.bod);
    const last = s.reactors[s.reactors.length - 1];
    const out: Record<string, AlarmAttribution> = {};
    for (const alarm of alarms) {
      const attribution = attributeAlarm({
        code: alarm.code,
        effluent: s.effluent,
        srtDays: s.srtDays,
        lastDo: last?.doLevel ?? 0,
        doSetpoint: s.controls.doSetpoint,
        blanketM: s.clarifier.blanketM,
        depth: s.clarifier.depth,
        temperature: s.influent.temperature,
        inhibition: s.inhibition,
        slopes,
      });
      if (attribution) out[alarm.code] = attribution;
    }
    return out;
  }

  function derived(s: NetworkSimState): DerivedFrame {
    const activeAlarms = currentAlarms(s);
    const margins = estimateMargin(s.effluent);
    const health = plantHealth({
      margins,
      lastDo: s.reactors[s.reactors.length - 1]?.doLevel ?? 0,
      doSetpoint: s.controls.doSetpoint,
      srtDays: s.srtDays,
      blanketM: s.clarifier.blanketM,
      depth: s.clarifier.depth,
      activeAlarms: activeAlarms.length,
    });
    return { activeAlarms, margins, health, attribution: buildAttribution(s, activeAlarms) };
  }

  function buildSnapshot(): PlantSnapshot {
    const src = deps.source();
    const s = src.net;
    const fc = deps.forecastFor(s, src.topology);
    const { activeAlarms, margins, health, attribution } = derived(s);

    return {
      timeMin: s.timeMin,
      simulatedAt: new Date().toISOString(),
      speed: src.speed,
      paused: src.paused,
      modelMode: s.modelMode,
      influent: { ...s.influent, bod: s.influent.cod * 0.44, ph: 7.2 },
      effluent: { ...s.effluent },
      tanks: buildTankStates(s),
      clarifier: {
        blanketM: s.clarifier.blanketM,
        sludgeMassKg: s.clarifier.sludgeMassKg,
        xRas: s.clarifier.xRas,
        xEff: s.clarifier.xEff,
        slr: s.clarifier.slr,
        underflowM3h: s.influent.flow * s.controls.rasRatio,
        area: s.clarifier.area,
        depth: s.clarifier.depth,
        // 十层剖面：只读诊断量，给「泥在哪一层」一个可看的答案
        profile: s.clarifier.settler.x.map((v) => Number(v.toFixed(1))),
        feedLayer: BSM1_SETTLER.feedLayer,
      },
      controls: s.controls,
      scenario: s.scenario,
      energy: { ...s.energy, specificKwhM3: s.energy.totalKw / Math.max(1, s.influent.flow) },
      cost: {
        energyToday: s.costToday.energy,
        chemicalToday: s.costToday.chemical,
        sludgeToday: s.costToday.sludge,
        totalToday: s.costToday.total,
        total: s.cost.total,
      },
      srtDays: s.srtDays,
      fmRatio: s.fmRatio,
      score: qualityScoreOf(s.effluent),
      margins,
      alarms: s.alarms
        .slice(-20)
        .reverse()
        .map((a) => ({ ...a })),
      activeAlarms,
      alarmAttribution: attribution,
      health,
      trends: src.trend,
      /**
       * 运营评分卡：直接从趋势缓冲复算。
       *
       * 放在全量帧而不是增量帧里——它随窗口整体变化（达标率、均值），
       * 不是一个 tick 的增量；每帧只算一次 720 点累加，实测 < 0.2 ms。
       */
      scorecard: scorecardFromTrend(src.trend, {
        flowM3h: s.influent.flow,
        standard: src.standard ?? DEFAULT_STANDARD,
        scenarioWindow: s.scenario
          ? { from: s.scenario.startedAt, to: s.scenario.startedAt + s.scenario.durationMin }
          : null,
      }),
      forecast: fc
        ? {
            points: fc.points.map((pt) => ({
              minute: pt.minute,
              cod: pt.effluent.cod,
              nh: pt.effluent.nh,
              tn: pt.effluent.tn,
              tp: pt.effluent.tp,
              ss: pt.effluent.ss,
              doLevel: pt.doLevel,
              score: pt.score,
            })),
            violations: fc.violations.slice(0, 12),
          }
        : null,
      recommendation: src.recommendation,
      forecastBand: src.recommendation?.ensemble ?? null,
      benchmark: deps.summarizeBenchmark(src.shadow.benchmark),
      limits: LIMITS,
      totals: totalsOf(s),
      stormStorageM3: s.stormStorageM3,
      reactorCount: s.reactors.length,
    };
  }

  /**
   * 构造一帧共享补丁体（不含趋势增量）。
   *
   * 每帧所有连接的内容完全相同，只有「自上次以来新增了哪些趋势点」不同。
   * 这样一帧只算一次告警/裕度/健康度/归因，N 个客户端不再各算一遍。
   */
  function buildPatchBody(): Omit<SnapshotPatch, 'trendsAppend'> {
    const src = deps.source();
    const s = src.net;
    const { activeAlarms, margins, health, attribution } = derived(s);

    return {
      timeMin: s.timeMin,
      influentFlow: s.influent.flow,
      influent: { ...s.influent, bod: s.influent.cod * 0.44, ph: 7.2 },
      effluent: { ...s.effluent },
      tanks: buildTankPatch(s),
      clarifier: {
        blanketM: s.clarifier.blanketM,
        xRas: s.clarifier.xRas,
        xEff: s.clarifier.xEff,
        slr: s.clarifier.slr,
        profile: s.clarifier.settler.x.map((v) => Number(v.toFixed(1))),
      },
      energy: { ...s.energy, specificKwhM3: s.energy.totalKw / Math.max(1, s.influent.flow) },
      // 当日口径必须用 costToday：用累计值会让「今日运行成本」随仿真天数线性上涨
      cost: { totalToday: s.costToday.total, total: s.cost.total },
      srtDays: s.srtDays,
      fmRatio: s.fmRatio,
      // AI 会自动改写控制量：必须随增量下发，否则界面滑块停在用户上次拖的位置
      controls: s.controls,
      scenario: s.scenario,
      totals: totalsOf(s),
      score: qualityScoreOf(s.effluent),
      margins,
      alarms: s.alarms
        .slice(-20)
        .reverse()
        .map((a) => ({ ...a })),
      activeAlarms,
      alarmAttribution: attribution,
      health,
      stormStorageM3: s.stormStorageM3,
      reactorCount: s.reactors.length,
      /**
       * 预测扇区与双跑摘要也要随增量下发。
       *
       * 只在全量快照里带的话，客户端连接后趋势图的预测区与收益面板的
       * 「AI vs 固定策略」会永久冻结在连接那一刻——界面上看不出来，
       * 但那是假数据。两者都很小（几 KB），随帧发不会抵消增量收益。
       */
      forecastBand: src.recommendation?.ensemble ?? null,
      benchmark: deps.summarizeBenchmark(src.shadow.benchmark),
      scorecard: scorecardFromTrend(src.trend, {
        flowM3h: s.influent.flow,
        standard: src.standard ?? DEFAULT_STANDARD,
        scenarioWindow: s.scenario
          ? { from: s.scenario.startedAt, to: s.scenario.startedAt + s.scenario.durationMin }
          : null,
      }),
    };
  }

  /** 单连接补丁：共享体 + 该游标的新增趋势点 */
  function buildPatch(client: TrendCursor): SnapshotPatch {
    const src = deps.source();
    return { ...buildPatchBody(), trendsAppend: takeNewPoints(src.trend, client) };
  }

  /** 批量补丁：一帧只构造一次共享体，按连接只补趋势增量 */
  function buildPatches(clients: TrendCursor[]): SnapshotPatch[] {
    const body = buildPatchBody();
    const src = deps.source();
    return clients.map((c) => ({ ...body, trendsAppend: takeNewPoints(src.trend, c) }));
  }

  return { buildSnapshot, buildPatch, buildPatches, currentAlarms, derived };
}
