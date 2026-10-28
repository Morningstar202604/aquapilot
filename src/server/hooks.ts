import type { AgentConfig, HookSpec } from '../shared/agentConfig';
import { assertPublicFetchUrl } from '../ai/providers';
import { logger } from './observability';

/**
 * 声明式钩子运行时。
 *
 * 刻意不支持 shell / 任意脚本：钩子来自界面与配置文件，属于信任边界输入，
 * 一旦允许执行命令就等于把整台机器交出去。这里只实现四种动作：
 *   notice  → 广播一条提示
 *   log     → 写结构化日志
 *   skill   → 命中一个技能（把它塞进下一次回答的上下文）
 *   webhook → 出站 HTTP（仅 open 权限；走 SSRF 守卫）
 *
 * 去重按 (hookId, 事件细节) 在 cooldownMin 窗口内只触发一次，
 * 避免 alert 在每 tick 重复提示刷屏。
 */

export interface HookEventPayload {
  event: HookSpec['event'];
  /** 事件细节：告警 code+message、决策 summary、问题文本 */
  detail: string;
  /** 告警 code 之类的短标识，参与去重 */
  key?: string;
}

export interface HookOutcome {
  hookId: string;
  hookName: string;
  action: HookSpec['action'];
  text: string;
  level: HookSpec['level'];
  skillId?: string;
  skipped?: 'disabled' | 'no-match' | 'cooldown' | 'permission' | 'unsafe-target' | 'empty-target';
}

export interface HookEffects {
  notice?: (text: string, level: HookSpec['level']) => void;
  skill?: (skillId: string) => void;
  logLine?: (text: string, level: HookSpec['level'], hook: HookSpec) => void;
  webhook: (url: string, body: unknown, hook: HookSpec) => Promise<boolean>;
}

export class HookRuntime {
  private lastFired = new Map<string, number>();
  private lastSkill = new Map<string, { skillId: string; at: number }>();

  constructor(
    private readonly effects: HookEffects,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** 最近一次由钩子命中的技能（供对话链路拼接上下文） */
  skillFor(event: HookSpec['event'], key: string): string | null {
    const rec = this.lastSkill.get(`${event}:${key}`);
    if (!rec) return null;
    // 10 分钟内的技能命中仍然有效
    if (this.now() - rec.at > 10 * 60 * 1000) return null;
    return rec.skillId;
  }

  /**
   * 处理一个事件：同步返回所有 hook 的判定结果，webhook 异步执行。
   * 永不抛出——钩子是增强项，不能成为故障源。
   */
  async fire(config: AgentConfig, payload: HookEventPayload): Promise<HookOutcome[]> {
    const outcomes: HookOutcome[] = [];
    const hooks = config.hooks.filter((h) => h.event === payload.event);
    for (const hook of hooks) {
      const outcome = await this.runOne(config, hook, payload);
      if (outcome) outcomes.push(outcome);
    }
    return outcomes;
  }

  private async runOne(config: AgentConfig, hook: HookSpec, payload: HookEventPayload): Promise<HookOutcome | null> {
    const base = { hookId: hook.id, hookName: hook.name, action: hook.action, level: hook.level };
    if (!hook.enabled) return { ...base, text: '', skipped: 'disabled' };
    if (hook.action === 'webhook' && config.permission !== 'open') {
      return { ...base, text: '', skipped: 'permission' };
    }
    if (hook.match) {
      const haystack = `${payload.detail} ${payload.key ?? ''}`.toLowerCase();
      if (!haystack.includes(hook.match.toLowerCase())) return { ...base, text: '', skipped: 'no-match' };
    }
    const dedupeKey = `${hook.id}:${payload.key ?? payload.detail.slice(0, 40)}`;
    const last = this.lastFired.get(dedupeKey) ?? 0;
    if (hook.cooldownMin > 0 && this.now() - last < hook.cooldownMin * 60_000) {
      return { ...base, text: '', skipped: 'cooldown' };
    }
    const text = hook.target.replace(/\{\{detail\}\}/g, payload.detail).replace(/\{\{event\}\}/g, payload.event);
    if (!text.trim()) return { ...base, text: '', skipped: 'empty-target' };

    try {
      if (hook.action === 'notice') {
        this.effects.notice?.(text, hook.level);
      } else if (hook.action === 'log') {
        (this.effects.logLine ?? ((t, level) => logger[level](t)))(text, hook.level, hook);
      } else if (hook.action === 'skill') {
        this.effects.skill?.(hook.target);
        this.lastSkill.set(`${payload.event}:${payload.key ?? payload.detail.slice(0, 40)}`, {
          skillId: hook.target,
          at: this.now(),
        });
      } else if (hook.action === 'webhook') {
        try {
          /**
           * webhook 也必须用严格公网守卫。
           *
           * 宽松守卫允许私网（模型端点需要），但 webhook 的目标来自

           * 界面配置，能打到 127.0.0.1 就等于给了一个内网请求触发器。
           */
          assertPublicFetchUrl(hook.target);
        } catch (err) {
          logger.warn('hook webhook rejected', { hook: hook.name, reason: String(err) });
          return { ...base, text: '', skipped: 'unsafe-target' };
        }
        await this.effects.webhook(
          hook.target,
          { event: payload.event, detail: payload.detail, at: new Date().toISOString() },
          hook,
        );
      }
      this.lastFired.set(dedupeKey, this.now());
      return { ...base, text, skillId: hook.action === 'skill' ? hook.target : undefined };
    } catch (err) {
      logger.warn('hook failed', { hook: hook.name, error: String(err) });
      return { ...base, text: '', skipped: 'empty-target' };
    }
  }

  /** 测试用：清空去重状态 */
  reset(): void {
    this.lastFired.clear();
    this.lastSkill.clear();
  }
}
