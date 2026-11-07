import type { ClientMessage, ServerMessage } from '../shared/protocol';
import { CONTROL_BOUNDS } from '../sim/config';
import { SCENARIOS, type ScenarioType } from '../sim/scenarios';
import { checkAllowedControls } from '../shared/agentConfig';
import {
  SCENARIO_MAGNITUDE_RANGE,
  VALID_SCENARIOS,
  sanitizeBoolean,
  sanitizeControlPatch,
  sanitizeRange,
  sanitizeSpeed,
} from './validation';
import type { Recommendation } from '../ai/agent';

/**
 * 运行态操作处理器：control / aiEnabled / applyRecommendation /
 * dismissRecommendation / scenario / sim / speed / refreshDecision。
 *
 * 从 server/index.ts 的 800 行 switch 里抽出。这八个分支共享同一组前置条件
 * （角色已由外层校验、限流按操作类型共用冷却、人工调整要进入优先期），
 * 放在一起才能看出它们的一致性要求：
 *
 * - 任何改变控制量的路径都必须刷新 `manualOverrideUntil`，
 *   否则用户拖完滑块下一帧就被 AI 改回去；
 * - 任何改变运行态的操作都必须广播快照，否则界面停在旧值；
 * - 采纳与拒绝都必须写审计（`recordReview`），只写一半就失去复盘价值。
 *
 * 处理器不持有全局 runtime：状态读写经注入的 `deps` 完成。
 */

export interface RuntimeControlState {
  /** 连续控制量（数值） */
  controls: Record<string, number>;
  /** AI 自动值守开关：与连续量分开，避免把布尔混进数值表 */
  aiEnabled: boolean;
  timeMin: number;
  scenario: { type: ScenarioType; durationMin: number; magnitude: number; startedAt: number } | null;
  paused: boolean;
  speed: number;
}

export type RateKind = 'control' | 'topology' | 'decision' | 'chat' | 'snapshot';

export interface ControlHandlerDeps {
  /**
   * 只读视图：每次调用返回当前值的快照。
   *
   * **写入必须走下面的 mutator**，不要改这个对象。曾经这里是一个
   * 「看起来像活对象」的字面量，处理器对它赋值时不会报错，但值直接丢弃——
   * 表现为「注入场景后没有任何反应」，是重构引入的静默回归。
   */
  state: () => RuntimeControlState;
  /** 写回控制量（整体替换，保留 aiEnabled） */
  setControls: (next: Record<string, number>) => void;
  /** 写 AI 开关 */
  setAiEnabled: (enabled: boolean) => void;
  /** 写场景（null 表示清除） */
  setScenario: (scenario: RuntimeControlState['scenario']) => void;
  /** 写暂停/倍速 */
  setPaused: (paused: boolean) => void;
  setSpeed: (speed: number) => void;
  /** 当前可执行建议；没有则为 null */
  recommendation: () => Recommendation | null;
  /** 采纳建议：写入控制量 */
  adoptRecommendation: (controls: Record<string, number>, aiEnabled: boolean) => void;
  /** 人工调整后的 AI 静默期（仿真分钟） */
  enterManualWindow: () => void;
  /** 重置到初始稳态（含运行态清理与 runId 轮换） */
  resetSimulation: () => void;
  /** 重新推演一次决策 */
  refreshDecision: () => void;

  rateLimited: (kind: RateKind) => boolean;
  throttledNotice: (kind: string, text: string) => void;
  send: (message: ServerMessage) => void;
  broadcast: (message: ServerMessage) => void;
  broadcastSnapshot: () => void;
  broadcastSimState: () => void;

  /** 审计：人工裁决 */
  recordReview: (verdict: 'approve' | 'reject' | 'auto', actor: string, action: string, reason: string) => void;
  /** 当前令牌角色（写进审计） */
  actor: string;
  /** 指标 */
  onInvalid: () => void;
  onRateLimited: () => void;
  /** 约束：allowedControls 之外的量连人工也不允许写 */
  allowedControls: () => Parameters<typeof checkAllowedControls>[1];
}

const MANUAL_OVERRIDE_MIN = 30;

/** 返回 true 表示这条消息已被处理 */
export function handleControlMessage(
  msg: Exclude<ClientMessage, { type: 'hello' } | { type: 'chat' } | { type: 'topology' } | { type: 'preset' }>,
  deps: ControlHandlerDeps,
): boolean {
  const state = deps.state();

  switch (msg.type) {
    case 'control': {
      if (deps.rateLimited('control')) {
        deps.throttledNotice('control', '操作过于频繁，请稍后再试');
        return true;
      }
      const result = sanitizeControlPatch((msg as { patch?: unknown }).patch);
      if (!result.ok) {
        deps.send({ type: 'notice', level: 'error', text: `控制参数非法：${result.error}` });
        return true;
      }
      /**
       * 约束生效：allowedControls 之外的量，手动也不允许写。
       *
       * 这是「约束工程」对人工通道同样生效的关键——否则界面能拖、服务端照收，
       * 护栏就只防住了 AI，没防住人。
       */
      const allowedCheck = checkAllowedControls(result.value as Record<string, unknown>, deps.allowedControls());
      if (!allowedCheck.ok) {
        deps.send({
          type: 'notice',
          level: 'error',
          text: `该控制量已被约束禁用：${allowedCheck.rejected.join('、')}。可在「Agent 设置 → 约束」里放开。`,
        });
        return true;
      }
      // sanitizeControlPatch 的返回里可能带 aiEnabled（它属于并列字段），
      // 连续量只取数值键，AI 开关单独写
      const { aiEnabled: nextAi, ...numeric } = result.value as Record<string, unknown>;
      deps.setControls({ ...state.controls, ...(numeric as Record<string, number>) });
      if (typeof nextAi === 'boolean') deps.setAiEnabled(nextAi);
      deps.enterManualWindow();
      deps.refreshDecision();
      deps.send({
        type: 'notice',
        level: 'info',
        text: `已应用手动设定。接下来 ${MANUAL_OVERRIDE_MIN} 分钟仿真时间内 AI 只给出建议，不会覆盖你的调整。`,
      });
      deps.broadcastSnapshot();
      return true;
    }

    case 'aiEnabled': {
      const enabled = sanitizeBoolean((msg as { enabled?: unknown }).enabled);
      if (enabled === null) {
        deps.send({ type: 'notice', level: 'error', text: 'aiEnabled 必须是布尔值' });
        return true;
      }
      deps.setAiEnabled(enabled);
      deps.send({
        type: 'notice',
        level: 'info',
        text: enabled ? 'AI 自动值守已启用，将自动执行控制调节。' : 'AI 已切换为建议模式，控制调节需人工确认。',
      });
      if (!deps.rateLimited('snapshot')) deps.broadcastSnapshot();
      return true;
    }

    case 'applyRecommendation': {
      const rec = deps.recommendation();
      if (!rec) return true;
      if (deps.rateLimited('snapshot')) return true;
      deps.adoptRecommendation(rec.chosens.controls as unknown as Record<string, number>, state.aiEnabled);
      deps.recordReview('approve', deps.actor, rec.action, '');
      deps.broadcast({ type: 'notice', level: 'info', text: '已采纳 AI 建议，控制参数已更新。' });
      deps.broadcastSnapshot();
      return true;
    }

    case 'dismissRecommendation': {
      /**
       * 拒绝建议与采纳同等留痕。
       *
       * 只有「采纳」一个正向事件时，事后复盘看到一条建议后面没有任何动作，
       * 无法区分「人拒绝了」与「系统丢了消息」。
       */
      const rec = deps.recommendation();
      if (!rec) {
        deps.send({ type: 'notice', level: 'info', text: '当前没有可拒绝的建议。' });
        return true;
      }
      if (deps.rateLimited('snapshot')) return true;
      const reason = typeof msg.reason === 'string' ? msg.reason.trim().slice(0, 300) : '';
      deps.recordReview('reject', deps.actor, rec.action, reason);
      deps.send({
        type: 'notice',
        level: 'info',
        text: reason ? `已拒绝该建议（原因：${reason}）。` : '已拒绝该建议。',
      });
      return true;
    }

    case 'scenario': {
      if (msg.kind === 'start' && deps.rateLimited('decision')) {
        deps.throttledNotice('scenario', '场景启动过于频繁，请稍后再试');
        return true;
      }
      if (msg.kind === 'clear') {
        deps.setScenario(null);
        deps.setControls({ ...state.controls, stormStore: 0 });
        deps.broadcast({ type: 'notice', level: 'info', text: '已清除场景，回到常态工况。' });
      } else {
        const scenarioType = (msg as { scenario?: unknown }).scenario;
        if (typeof scenarioType !== 'string' || !VALID_SCENARIOS.has(scenarioType)) {
          deps.send({ type: 'notice', level: 'error', text: '未知的场景类型' });
          return true;
        }
        const meta = SCENARIOS[scenarioType as ScenarioType];
        deps.setScenario({
          type: scenarioType as ScenarioType,
          durationMin: sanitizeRange(
            (msg as { durationMin?: unknown }).durationMin,
            10,
            10080,
            meta.defaultDurationMin,
          ),
          magnitude: sanitizeRange(
            (msg as { magnitude?: unknown }).magnitude,
            SCENARIO_MAGNITUDE_RANGE[scenarioType]?.min ?? 0,
            SCENARIO_MAGNITUDE_RANGE[scenarioType]?.max ?? 30,
            meta.defaultMagnitude,
          ),
          startedAt: state.timeMin,
        });
        deps.broadcast({ type: 'notice', level: 'warn', text: `已注入场景：${meta.label}` });
        deps.refreshDecision();
      }
      deps.broadcastSnapshot();
      return true;
    }

    case 'sim': {
      if (msg.action !== 'pause' && msg.action !== 'resume' && msg.action !== 'reset') {
        deps.onInvalid();
        deps.send({ type: 'notice', level: 'error', text: '未知的仿真操作' });
        return true;
      }
      if (deps.rateLimited('snapshot')) return true;
      if (msg.action === 'pause') deps.setPaused(true);
      if (msg.action === 'resume') deps.setPaused(false);
      if (msg.action === 'reset') {
        deps.resetSimulation();
        deps.broadcast({ type: 'notice', level: 'info', text: '仿真已重置到初始稳态。' });
      }
      deps.broadcastSimState();
      deps.broadcastSnapshot();
      return true;
    }

    case 'speed': {
      const speed = sanitizeSpeed((msg as { value?: unknown }).value);
      if (speed === null) {
        deps.send({ type: 'notice', level: 'error', text: '速度必须是 0.25–8 之间的数值' });
        return true;
      }
      deps.setSpeed(speed);
      deps.broadcastSimState();
      return true;
    }

    case 'refreshDecision': {
      /**
       * 「重新推演」是昂贵同步操作（≈200 ms，含 3 组扰动轨迹）。
       * 无限流时连点可把主线程钉死、tick 全部积压。
       */
      if (deps.rateLimited('decision')) {
        deps.throttledNotice('decision', '推演过于频繁，请 2 秒后再试');
        return true;
      }
      deps.refreshDecision();
      deps.broadcastSnapshot();
      return true;
    }

    default:
      return false;
  }
}

/** CONTROL_BOUNDS 的键集，供 allowedControls 默认值使用 */
export const CONTROL_KEYS = Object.keys(CONTROL_BOUNDS);
