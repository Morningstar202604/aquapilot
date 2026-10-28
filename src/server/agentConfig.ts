import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  agentSummary,
  defaultAgentConfig,
  normalizeAgentConfig,
  permissionAllows,
  type AgentConfig,
  type AgentSummary,
  type ConfigWriter,
} from '../shared/agentConfig';
import { logger } from './observability';

/**
 * Agent 配置的持久化与热加载。
 *
 * 三条写入路径共用这一个入口：界面（WS）、对话命令、CLI。
 * 因此权限与核心保护只在这里实现一次，任何入口都绕不过去。
 *
 * 热加载用 mtime 判断：CLI 直接改文件后，下一次读取即生效，不需要重启。
 */

const DEFAULT_PATH = resolve(process.env.AQUAPILOT_AGENT_CONFIG ?? 'data/agent-config.json');

export interface SaveOptions {
  writer: ConfigWriter;
}

export interface SaveOutcome {
  ok: boolean;
  error?: string;
  warnings: string[];
  config?: AgentConfig;
  summary?: AgentSummary;
}

export interface ConfigStatus {
  config: AgentConfig;
  summary: AgentSummary;
  warnings: string[];
  path: string;
  mtime: number;
}

export class AgentConfigStore {
  private current: AgentConfig;
  private warnings: string[] = [];
  private mtime = 0;
  private loaded = false;
  private readonly listeners = new Set<(status: ConfigStatus) => void>();

  constructor(private readonly path: string = DEFAULT_PATH) {
    this.current = defaultAgentConfig();
  }

  /** 订阅配置变更（WS 广播用）；返回退订函数 */
  subscribe(fn: (status: ConfigStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const status = this.status();
    for (const fn of this.listeners) {
      try {
        fn(status);
      } catch {
        /* 订阅者异常不能影响写入路径 */
      }
    }
  }

  /** 文件 mtime 变化即重载；损坏文件保留上一份并告警 */
  private ensureFresh(): void {
    let mtime = 0;
    try {
      mtime = existsSync(this.path) ? statSync(this.path).mtimeMs : 0;
    } catch {
      mtime = 0;
    }
    if (this.loaded && mtime === this.mtime) return;
    this.loaded = true;
    this.mtime = mtime;
    if (!mtime) {
      this.current = defaultAgentConfig();
      this.warnings = [];
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
      const result = normalizeAgentConfig(raw);
      this.current = result.config;
      this.warnings = result.warnings;
      if (this.warnings.length > 0) logger.warn('agent config normalized with warnings', { warnings: this.warnings });
    } catch (err) {
      this.warnings = ['配置文件无法解析，已保留上一份有效配置'];
      logger.warn('agent config reload failed', { error: String(err) });
    }
  }

  status(): ConfigStatus {
    this.ensureFresh();
    return {
      config: this.current,
      summary: agentSummary(this.current),
      warnings: [...this.warnings],
      path: this.path,
      mtime: this.mtime,
    };
  }

  get(): AgentConfig {
    this.ensureFresh();
    return this.current;
  }

  /**
   * 统一写入入口。
   *
   * 权限语义：
   * - readonly：任何写入都拒绝；
   * - standard：可写，但 open 才允许的能力（webhook 钩子、>30% 步长、提权）会被拒绝；
   * - open：除核心保护区外全放行。
   */
  save(raw: unknown, options: SaveOptions): SaveOutcome {
    this.ensureFresh();
    const currentLevel = this.current.permission;
    if (!permissionAllows(currentLevel, 'save')) {
      return {
        ok: false,
        error: '当前权限为「只读」，禁止修改配置。请先把权限切到「标准」或「完全放开」。',
        warnings: [],
      };
    }
    const normalized = normalizeAgentConfig(raw);
    const next = normalized.config;
    const warnings = [...normalized.warnings];

    /**
     * 能力判定必须用「请求到达时的档位」，不能用「保存后的档位」。
     *
     * 旧实现按 `next.permission` 判定：任何已连接客户端只要在一次 save 里
     * 同时写 `permission:'open'` + webhook 钩子 + `maxStepPct:100`，
     * 就会以提权后的身份一次性全部生效——权限模型形同虚设。
     * 现在：提权本身允许（本机单用户），但 open 专属能力从下一次保存起才生效。
     */
    const capabilityLevel = currentLevel;
    if (next.permission !== currentLevel && next.permission === 'open') {
      warnings.push('已切到「完全放开」：Webhook 与大步长从下一次保存起生效，请再保存一次确认');
    }

    if (capabilityLevel !== 'open') {
      const webhooks = next.hooks.filter((h) => h.action === 'webhook');
      if (webhooks.length > 0) {
        next.hooks = next.hooks.filter((h) => h.action !== 'webhook');
        warnings.push('Webhook 钩子仅「完全放开」权限可用，已忽略对应条目');
      }
      if (next.constraints.maxStepPct > 30) {
        next.constraints.maxStepPct = 30;
        warnings.push('「标准」权限下单步幅度上限为量程 30%，已夹紧');
      }
    }

    const before = this.current;
    next.updatedAt = new Date().toISOString();
    next.updatedBy = options.writer;
    this.current = next;
    try {
      this.write(next);
      this.emit();
      return { ok: true, warnings, config: next, summary: agentSummary(next) };
    } catch (err) {
      // 回滚内存状态，避免"界面显示已保存、磁盘没写进去"
      this.current = before;
      logger.error('agent config write failed', { error: String(err) });
      return { ok: false, error: '写入配置失败：检查 data/ 目录是否可写', warnings };
    }
  }

  /** 局部更新某个区块（界面按区块保存时用） */
  patch(partial: unknown, options: SaveOptions): SaveOutcome {
    this.ensureFresh();
    const merged = { ...this.current, ...(partial as Record<string, unknown>) };
    return this.save(merged, options);
  }

  /** 恢复出厂 */
  reset(options: SaveOptions): SaveOutcome {
    return this.save(defaultAgentConfig(), options);
  }

  private write(config: AgentConfig): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const staging = `${this.path}.staging-${process.pid}`;
    writeFileSync(staging, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(staging, this.path);
    this.mtime = statSync(this.path).mtimeMs;
    this.loaded = true;
    this.warnings = [];
  }
}

export const agentConfigStore = new AgentConfigStore();
