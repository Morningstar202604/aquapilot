import { sampleAt, type InfluentSample, type InfluentSeries } from './influentSeries';

/**
 * 进水/仪表数据源适配层。
 *
 * 为什么补（对标 wwtw-digital-twin 的 `server/src/ingest/adapters/*`）：
 * 我们此前只有「贴 CSV」一条路。真实接入时分三种情况：
 * - 历史数据回放（文件，已支持）；
 * - 实时采集（MQTT / OPC UA，需要长连接与重连）；
 * - 没有现场数据时先跑模拟器（保证界面不空转）。
 *
 * 本模块只定义**统一的适配器契约** + 已实现的 CSV 与模拟器适配器；
 * MQTT/OPC UA 用同一契约留出实现位，并给出「未安装协议栈时的明确降级」，
 * 而不是假装能连——假装能连比连不上更危险。
 *
 * 设计要点：
 * 1. **统一输出**：所有适配器都产出 `InfluentSample`，上层不需要知道来源；
 * 2. **健康状态**：每个适配器必须报告 `status()`（连接、最后成功时间、错误），
 *    界面据此显示「数据是实时的还是回放的」；
 * 3. **不静默失败**：断线不返回 0，而是返回 null 并置错——0 会被当成真实流量。
 */

export type AdapterKind = 'csv' | 'simulator' | 'mqtt' | 'opcua';

export interface AdapterStatus {
  kind: AdapterKind;
  /** 是否已就绪可用 */
  ready: boolean;
  /** 最后一次成功取数的时间戳（ms）；从未成功为 null */
  lastSuccessAt: number | null;
  /** 最近一次错误（可读中文） */
  lastError: string | null;
  /** 数据新鲜度：距上次成功多少毫秒；null 表示无数据 */
  stalenessMs: number | null;
}

export interface DataSourceAdapter {
  readonly kind: AdapterKind;
  readonly name: string;
  /** 读取当前时刻的进水样本；无数据返回 null（绝不返回 0 冒充真实值） */
  read(minute: number): InfluentSample | null;
  /** 健康状态 */
  status(now?: number): AdapterStatus;
  /** 释放资源（长连接适配器必须实现） */
  close(): void;
}

/** 通用状态实现，避免每个适配器重复维护计时逻辑 */
export abstract class BaseAdapter implements DataSourceAdapter {
  abstract readonly kind: AdapterKind;
  abstract readonly name: string;
  protected lastSuccessAt: number | null = null;
  protected lastError: string | null = null;

  abstract read(minute: number): InfluentSample | null;
  abstract close(): void;

  protected markSuccess(now = Date.now()): void {
    this.lastSuccessAt = now;
    this.lastError = null;
  }

  protected markError(message: string): void {
    this.lastError = message;
  }

  status(now = Date.now()): AdapterStatus {
    return {
      kind: this.kind,
      ready: this.lastSuccessAt !== null && this.lastError === null,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      stalenessMs: this.lastSuccessAt === null ? null : Math.max(0, now - this.lastSuccessAt),
    };
  }
}

/**
 * CSV 回放适配器。
 *
 * 把已有的 `InfluentSeries` 包成适配器契约：历史数据按仿真时钟回放。
 * 这是「没有实时数据源时最可靠的模式」——数据质量可提前检查，
 * 回放结果可复现。
 */
export class CsvReplayAdapter extends BaseAdapter {
  readonly kind = 'csv' as const;
  readonly name: string;
  private readonly series: InfluentSeries;

  constructor(series: InfluentSeries, name?: string) {
    super();
    this.series = series;
    this.name = name ?? series.name;
    if (series.samples.length === 0) this.markError('CSV 中没有可用数据');
  }

  read(minute: number): InfluentSample | null {
    if (this.series.samples.length === 0) return null;
    const sample = sampleAt(this.series, minute);
    this.markSuccess();
    return sample;
  }

  close(): void {
    /* 无资源需要释放 */
  }
}

/**
 * 模拟器适配器。
 *
 * 用现有的昼夜节律 + 噪声模型生成进水，包成同一契约。
 * 用途：没有现场数据、也没上传 CSV 时的默认数据源，
 * 保证界面永远有数据可看（而不是空白）。
 */
export class SimulatorAdapter extends BaseAdapter {
  readonly kind = 'simulator' as const;
  readonly name = '内置模拟进水（昼夜节律 + 噪声）';
  private readonly design: { flow: number; cod: number; nh: number; tp: number; ss: number; temperature: number };

  constructor(design: { flow: number; cod: number; nh: number; tp: number; ss: number; temperature: number }) {
    super();
    this.design = design;
  }

  read(minute: number): InfluentSample | null {
    const hour = (minute / 60) % 24;
    // 与 forcing.ts 的 diurnal() 同形：双峰日节律
    const d = 0.78 + 0.3 * Math.exp(-(((hour - 10) / 3.6) ** 2)) + 0.26 * Math.exp(-(((hour - 20) / 3.2) ** 2));
    this.markSuccess();
    return {
      minute,
      flow: this.design.flow * d,
      cod: this.design.cod * (0.92 + 0.18 * (d - 0.78)),
      nh: this.design.nh * (0.94 + 0.14 * (d - 0.78)),
      tp: this.design.tp,
      ss: this.design.ss,
      temperature: this.design.temperature,
      alkalinity: 320,
    };
  }

  close(): void {
    /* 无资源需要释放 */
  }
}

/**
 * 未实现的实时协议适配器。
 *
 * 为什么保留：`mqtt` / `opcua` 是真实接入的必经之路，但需要协议栈依赖
 * 与现场安全评估（独立项目）。这里保留契约并在 `read()` 返回 null +
 * 明确错误，让界面显示「未连接」，而不是静默返回假数据。
 *
 * 这比「假装支持」诚实：用户不会看到一条平滑的假曲线以为接上了现场。
 */
export class UnavailableAdapter extends BaseAdapter {
  readonly kind: AdapterKind;
  readonly name: string;
  private readonly reason: string;

  constructor(kind: 'mqtt' | 'opcua', reason?: string) {
    super();
    this.kind = kind;
    this.name = kind === 'mqtt' ? 'MQTT 实时采集' : 'OPC UA 实时采集';
    this.reason = reason ?? '未安装协议栈依赖；接入需要现场网络与安全评估';
    this.markError(this.reason);
  }

  read(): InfluentSample | null {
    return null;
  }

  close(): void {
    /* 无连接可关 */
  }
}

export interface AdapterRegistryEntry {
  kind: AdapterKind;
  name: string;
  /** 是否已实现（可用） */
  implemented: boolean;
  /** 未实现时的原因 */
  reason?: string;
}

/** 适配器能力清单：界面据此显示「可用 / 未接入」而不是只列一堆选项 */
export const ADAPTER_CAPABILITIES: AdapterRegistryEntry[] = [
  { kind: 'simulator', name: '内置模拟', implemented: true },
  { kind: 'csv', name: 'CSV 回放', implemented: true },
  { kind: 'mqtt', name: 'MQTT', implemented: false, reason: '需 mqtt 协议栈 + 现场网络评估' },
  { kind: 'opcua', name: 'OPC UA', implemented: false, reason: '需 OPC UA 协议栈 + 安全策略配置' },
];

/**
 * 按优先级选择数据源。
 *
 * 优先级：实时 > 回放 > 模拟。`read()` 返回 null 时自动降级到下一级，
 * 并把「降级原因」记录下来——界面能显示「当前显示的是模拟数据」。
 */
export class DataSourceChain extends BaseAdapter {
  readonly kind = 'simulator' as const;
  readonly name = '数据源链';
  private readonly adapters: DataSourceAdapter[];
  private activeIndex = 0;
  private degradedFrom: string | null = null;
  private constructorError: string | null = null;

  constructor(adapters: DataSourceAdapter[]) {
    super();
    this.adapters = adapters.filter((a) => !(a instanceof UnavailableAdapter));
    if (this.adapters.length === 0) this.markError('没有任何可用数据源');
    /** 构造期原因更具体（例如「CSV 无数据」），read() 不应覆盖它 */
    this.constructorError = this.lastError;
  }

  /** 当前实际生效的数据源名称（用于界面标注数据来源） */
  activeName(): string | null {
    return this.adapters[this.activeIndex]?.name ?? null;
  }

  /** 是否发生了降级（实时源不可用时为 true） */
  degraded(): boolean {
    return this.degradedFrom !== null;
  }

  read(minute: number): InfluentSample | null {
    for (let i = this.activeIndex; i < this.adapters.length; i++) {
      const sample = this.adapters[i].read(minute);
      if (sample) {
        if (i !== this.activeIndex) {
          this.degradedFrom = this.adapters[this.activeIndex].name;
          this.activeIndex = i;
        }
        this.markSuccess();
        return sample;
      }
    }
    this.markError(this.constructorError ?? '所有数据源均不可用');
    return null;
  }

  close(): void {
    for (const adapter of this.adapters) adapter.close();
  }
}
