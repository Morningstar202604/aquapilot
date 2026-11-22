import type { ClientMessage, ServerMessage } from '../shared/protocol';
import { runAnalysis } from '../sim/analysis';
import { networkModel, type NetworkSimState } from '../sim/networkEngine';
import type { ProcessTopology } from '../model/topology';
import { sanitizeRange } from './validation';

type AnalysisMessage = Extract<ClientMessage, { type: 'analysis' }>;

export interface AnalysisHandlerDeps {
  topology: ProcessTopology;
  net: NetworkSimState;
  storedParticulateCodKg: number;
  baselineStoredCodKg: number;
  /** 分析是重操作，与「重新推演」共用同一套冷却。 */
  rateLimited: () => boolean;
  throttledNotice: (text: string) => void;
  send: (payload: ServerMessage) => void;
}

/**
 * 运行分析：~25 次 4h 预测，实测 300+ ms 同步阻塞，必须按需触发并限流。
 * 从 server/index.ts 抽成独立分支，输入只依赖拓扑/网络快照，不碰运行循环。
 */
export function handleAnalysisMessage(msg: AnalysisMessage, deps: AnalysisHandlerDeps): void {
  if (deps.rateLimited()) {
    deps.throttledNotice('分析请求过于频繁，请 2 秒后再试');
    return;
  }
  try {
    const horizon = sanitizeRange(msg.horizonMin, 60, 480, 240);
    const data = runAnalysis(
      networkModel(deps.topology, deps.net),
      {
        totals: deps.net.totals,
        effluent: deps.net.effluent,
        storedParticulateCodKg: deps.storedParticulateCodKg,
        baselineStoredCodKg: deps.baselineStoredCodKg,
        influentCodAvg: deps.net.influent.cod,
        // 两种引擎的取样口径都不构成严格守恒方程，统一按近似判定
        approximate: true,
      },
      horizon,
    );
    deps.send({ type: 'analysis', requestId: msg.requestId, data });
  } catch (err) {
    deps.send({
      type: 'analysis',
      action: 'error',
      requestId: msg.requestId,
      error: err instanceof Error ? err.message : '分析失败',
    });
  }
}
