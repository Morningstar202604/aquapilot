import type { WebSocket } from 'ws';

/**
 * 每连接限流与提示抑制。
 *
 * 从 server/index.ts 抽出的原因：限流状态机有三类真实缺陷史——
 * ① 限流窗口用 `now - undefined` 恒为 NaN 而静默放行；
 * ② 被限流的消息逐条回 notice，把保护变成新的放大源；
 * ③ 状态按连接维护，不限制连接数就能把额度放大 N 倍。
 * 这些契约值得独立成模块并被单测锁住。
 */

export interface ClientState {
  /** 该连接的令牌角色；认证未启用时恒为 admin */
  role: 'viewer' | 'operator' | 'admin';
  /** 心跳存活标记：上一轮 ping 之后是否收到过 pong */
  alive: boolean;
  /** 上次触发重算决策的时间，用于防止同步阻塞被滥用 */
  lastControlAt: number;
  lastTopologyAt: number;
  /**
   * 已推送的最后一个趋势点时刻（仿真分钟）。
   *
   * 不能用「已收到的点数量」当游标：趋势是 720 点的环形缓冲，
   * 一旦写满，`slice(count)` 永远为空，客户端从此收不到新点。
   */
  lastTrendT: number;
  /** 上次模型发现/连接测试的时间 */
  lastLlmAt: number;
  /** 上次手动重新推演的时间 */
  lastDecisionAt: number;
  /** 上次 LLM 增强对话的时间 */
  lastChatAt: number;
  /** 已发送过全量快照：hello 每连接只允许一次 */
  helloSent: boolean;
  /** 上次触发全量快照广播的时间 */
  lastSnapshotAt: number;
  /** 该连接在途的 LLM 请求数 */
  llmInFlight: number;
  /** 提示冷却记录：kind → 上次发送时刻 */
  noticeAt: Record<string, number>;
}

export function freshClientState(): ClientState {
  return {
    role: 'viewer',
    alive: true,
    lastControlAt: 0,
    lastTopologyAt: 0,
    lastTrendT: 0,
    lastLlmAt: 0,
    lastDecisionAt: 0,
    lastChatAt: 0,
    helloSent: false,
    lastSnapshotAt: 0,
    llmInFlight: 0,
    noticeAt: {},
  };
}

export const RATE_LIMIT = {
  controlMs: 500,
  topologyMs: 5000,
  /** 一次推演 ≈200 ms 同步阻塞：2 s 一次足够操作员连点 */
  decisionMs: 2000,
  /** 聊天会触发最多 4 次长超时出站请求（含推理模型 60 s） */
  chatMs: 1500,
  /** 全量快照约 240 KB：同一连接 1 s 内只允许触发一次广播 */
  snapshotMs: 1000,
} as const;

export type RateKind = 'control' | 'topology' | 'decision' | 'chat' | 'snapshot';

/** 单连接同时允许的在途 LLM 请求数 */
export const MAX_LLM_IN_FLIGHT = 2;
/** 同时在线连接上限：限流状态按连接维护，必须限制连接数才能封住放大效应 */
export const MAX_WS_CLIENTS = 50;
/** 慢客户端阈值：发送队列超过该字节数说明对端不读 */
export const MAX_BUFFERED_BYTES = 1024 * 1024;
/** 限流提示冷却：同一连接同类提示 2 s 内只回一次 */
export const NOTICE_COOLDOWN_MS = 2000;

export interface RateLimiterDeps {
  stateFor: (ws: WebSocket) => ClientState;
  saveState: (ws: WebSocket, state: ClientState) => void;
  onLimited: () => void;
  now?: () => number;
}

export function createRateLimiter(deps: RateLimiterDeps) {
  const now = deps.now ?? (() => Date.now());

  return {
    /** 返回 true 表示本次请求应被拒绝 */
    limited(ws: WebSocket, kind: RateKind): boolean {
      const state = deps.stateFor(ws);
      const t = now();
      const field: Record<RateKind, keyof ClientState> = {
        control: 'lastControlAt',
        topology: 'lastTopologyAt',
        decision: 'lastDecisionAt',
        chat: 'lastChatAt',
        snapshot: 'lastSnapshotAt',
      };
      const key = field[kind];
      const last = state[key] as number;
      const window = RATE_LIMIT[`${kind}Ms` as keyof typeof RATE_LIMIT];
      if (t - last < window) {
        deps.onLimited();
        return true;
      }
      (state[key] as number) = t;
      deps.saveState(ws, state);
      return false;
    },

    /**
     * 限流提示带冷却。
     *
     * 被限流的消息若逐条回 notice，就形成反向放大：客户端拖一次滑块发 40 条，
     * 服务端回 40 条提示，把「保护」变成新的噪音源。实测 40 → 2。
     */
    notice(ws: WebSocket, kind: string, text: string, send: (payload: string) => void): void {
      const state = deps.stateFor(ws);
      const t = now();
      const last = state.noticeAt[kind] ?? 0;
      if (t - last < NOTICE_COOLDOWN_MS) return;
      state.noticeAt[kind] = t;
      deps.saveState(ws, state);
      send(JSON.stringify({ type: 'notice', level: 'warn', text }));
    },
  };
}
