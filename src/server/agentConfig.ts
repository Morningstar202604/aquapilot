import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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
  private fingerprint: string | null = null;

  /** 读文件头做弱内容指纹（仅用于同 mtime 去重，不承担安全职责） */
  private headFingerprint(): string | null {
    try {
      const fd = openSync(this.path, 'r');
      try {
        const buf = Buffer.alloc(64);
        const bytes = readSync(fd, buf, 0, 64, 0);
        return buf.toString('base64', 0, bytes);
      } finally {
        closeSync(fd);
      }
    } catch {
      return null;
    }
  }
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
    /**
     * 内容指纹辅助判断：Windows 的 mtimeMs 在同一毫秒内的两次写入
     * 可能返回相同值，导致「刚写完默认配置却读回 readonly」。
     * 读文件头 64 字节做弱指纹，只在这里（已有 IO 开销兜底）使用。
     */
    const fingerprint = this.loaded && mtime === this.mtime ? this.headFingerprint() : null;
    if (process.env.AQUAPILOT_DEBUG_FRESH === '1') {
      // eslint-disable-next-line no-console
      console.log('[fresh]', {
        loaded: this.loaded,
        mtimeChanged: mtime !== this.mtime,
        fpChanged: fingerprint !== this.fingerprint,
        fp: fingerprint?.slice(0, 8),
        old: this.fingerprint?.slice(0, 8),
      });
    }
    if (this.loaded && mtime === this.mtime && fingerprint === this.fingerprint) return;
    this.fingerprint = fingerprint;
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
    /**
     * 写入后内存与文件内容一致，指纹必须同步。
     *
     * 漏掉这一行的话：下一次 ensureFresh 读到相同 mtime + 新指纹，
     * 与旧指纹（上一次写入的内容）不匹配，触发一次多余的重载——
     * 在同毫秒连续写入时（测试场景）会把刚写好的配置用磁盘上
     * 更早的内容覆盖回去，表现为「改了权限却读回旧档位」。
     */
    this.fingerprint = this.headFingerprint();
    this.loaded = true;
    this.warnings = [];
  }
}

export const agentConfigStore = new AgentConfigStore();

/**
 * 测试专用：把单例重定向到另一个路径并清空内存态。
 *
 * 为什么存在：`DEFAULT_PATH` 在模块加载时固化，而 vitest 的
 * `vi.hoisted` 并不保证先于其他测试文件的模块初始化执行——
 * 依赖环境变量时序会让测试互相污染（实测把 readonly 写进了
 * 开发者的 data/ 目录）。显式重定向比环境变量时序可靠。
 * 生产代码不得调用。
 */
export function __repointStoreForTests(path: string): void {
  (agentConfigStore as unknown as { path: string }).path = path;
  (agentConfigStore as unknown as { loaded: boolean }).loaded = false;
  (agentConfigStore as unknown as { fingerprint: string | null }).fingerprint = null;
  (agentConfigStore as unknown as { mtime: number }).mtime = 0;
}
