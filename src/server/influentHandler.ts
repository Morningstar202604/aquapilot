import type { ClientMessage, ServerMessage } from '../shared/protocol';
import { parseInfluentCsv, seriesStats, type InfluentSeries } from '../sim/influentSeries';
import { checkQuality } from '../sim/dataQuality';

/**
 * 进水序列（CSV）的 WebSocket 处理器。
 *
 * 从 server/index.ts 的 800 行 switch 里抽出来的第一个模块。抽它的理由不是
 * 「文件太长」，而是这段逻辑有三处**必须单测**的判定，埋在入口里只能靠起服务验证：
 *
 * 1. 2 MB 上限：`csv` 是浏览器送来的任意字符串，不设限就是一条消息吃满内存；
 * 2. 质量门禁：越界读数（COD 999999）被引擎夹紧后不会崩，但仿真结果会完全失真，
 *    用户看到的是「模型算出来就这样」。所以 error 级问题必须拒绝 apply，而不是放行；
 * 3. pending 状态机：load 只暂存、apply 才切换，中间允许用户先看质量报告。
 *
 * 处理器本身是纯的：不碰全局 runtime，所有读写都通过注入的 `state` 完成，
 * 发送通过注入的 `send`。这样测试可以直接构造状态，不需要起 WebSocket 服务。
 */

/** 2 MB：一条进水序列的合理上限，超过即拒（前端也做同一判定，双端一致） */
export const MAX_INFLUENT_CSV_BYTES = 2 * 1024 * 1024;

export interface InfluentHandlerState {
  /** 当前生效的进水序列；null 表示合成进水模型 */
  series: InfluentSeries | null;
  /** 已解析、待用户确认应用（load 之后 apply 之前） */
  pending: InfluentSeries | null;
}

export interface InfluentHandlerDeps {
  /** 取当前状态（每次调用现取，避免闭包持有过期对象） */
  state: () => InfluentHandlerState;
  /** 写入状态；处理器不假设调用方的存储形态 */
  update: (patch: Partial<InfluentHandlerState>) => void;
  /** 单发一条消息给发起请求的连接 */
  send: (message: ServerMessage) => void;
  /** 广播系统提示（所有连接都该知道进水换了） */
  notice: (level: 'info' | 'warn' | 'error', text: string) => void;
}

function reportOf(series: InfluentSeries | null, applied: boolean, requestId: string): ServerMessage {
  const stats = series ? seriesStats(series) : null;
  return {
    type: 'influent',
    action: 'report',
    requestId,
    summary: stats
      ? {
          name: series!.name,
          points: stats.points,
          days: stats.days,
          flowMean: stats.flowMean,
          flowPeak: stats.flowPeak,
          codMean: stats.codMean,
          codPeak: stats.codPeak,
          temperatureRange: stats.temperatureRange,
        }
      : null,
    quality: series ? checkQuality(series) : { score: 0, usable: false, issues: [], perMetric: {} },
    applied,
  };
}

/**
 * 处理一条 `influent` 消息。
 *
 * 所有分支都保证恰好发一条回执（report 或 error），调用方不需要再兜底。
 */
export function handleInfluentMessage(
  msg: Extract<ClientMessage, { type: 'influent' }>,
  deps: InfluentHandlerDeps,
): void {
  const reply = (payload: ServerMessage) => deps.send(payload);

  if (msg.action === 'get') {
    const current = deps.state();
    reply(reportOf(current.series, current.series !== null, msg.requestId));
    return;
  }

  if (msg.action === 'clear') {
    deps.update({ series: null, pending: null });
    reply(reportOf(null, false, msg.requestId));
    deps.notice('info', '已恢复合成进水模型（昼夜节律 + 噪声）。');
    return;
  }

  if (msg.action === 'apply') {
    const pendingSeries = deps.state().pending;
    if (!pendingSeries) {
      reply({ type: 'influent', action: 'error', requestId: msg.requestId, error: '没有待应用的进水序列' });
      return;
    }
    /**
     * 有 error 级质量问题时拒绝应用。
     *
     * 越界读数（如 COD 999999）被引擎夹紧后不会崩，但会让仿真结果完全失真——
     * 用户看到的是「模型算出来就这样」，而真正的原因是数据错了。
     * 这种情况下拒绝比放行更负责任。
     */
    const quality = checkQuality(pendingSeries);
    if (!quality.usable) {
      reply({
        type: 'influent',
        action: 'error',
        requestId: msg.requestId,
        error: `数据质量不通过（${quality.issues.filter((i) => i.severity === 'error').length} 项错误），请先修正`,
      });
      return;
    }
    deps.update({ series: pendingSeries, pending: null });
    reply(reportOf(pendingSeries, true, msg.requestId));
    deps.notice('info', `已应用进水序列「${pendingSeries.name}」（${pendingSeries.samples.length} 点）。`);
    return;
  }

  // action === 'load'
  if (typeof msg.csv !== 'string' || msg.csv.length > MAX_INFLUENT_CSV_BYTES) {
    reply({ type: 'influent', action: 'error', requestId: msg.requestId, error: 'CSV 超过 2 MB 上限' });
    return;
  }
  const series = parseInfluentCsv(msg.csv, typeof msg.name === 'string' ? msg.name.slice(0, 80) : '自定义进水');
  if (series.samples.length === 0) {
    reply({
      type: 'influent',
      action: 'error',
      requestId: msg.requestId,
      error: series.warnings[0] ?? 'CSV 中没有可用数据',
    });
    return;
  }
  deps.update({ pending: series });
  reply(reportOf(series, false, msg.requestId));
}
