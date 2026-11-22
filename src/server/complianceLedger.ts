import type { MinuteReading } from '../sim/sampling';

/**
 * 合规采样账本：为 WP6 报表提供**足够长**的分钟读数。
 *
 * 为什么不直接把 720 点趋势缓冲喂给合规路由：720 仿真分钟只有 12 h，
 * 连一个 24 h 流量比例混合样都凑不齐，日考核、月滚动均值、95 分位全部
 * 无从谈起。趋势缓冲是给界面画曲线的短窗，合规账本是给报表的 40 天账，
 * 两者生命周期与保留策略不同，不能共用一个数组。
 *
 * 账本本身不做任何统计：口径（加权、删失、QA）全部留在 WP6 的纯函数里，
 * 这里只负责"按仿真分钟存读数、按窗口取读数"，避免第二套统计口径。
 */
export const COMPLIANCE_RETENTION_MIN = 40 * 1440;

export interface LedgerSpan {
  fromMin: number;
  toMin: number;
  count: number;
}

export interface ComplianceLedger {
  /** 写入一条分钟读数；同一仿真分钟重复写入时以后者为准（暂停/回放不产生重复点） */
  push(reading: MinuteReading): void;
  /** 按闭区间 [fromMin, toMin] 取读数；区间非法时返回空数组而不是抛错 */
  readings(fromMin: number, toMin: number): MinuteReading[];
  /** 当前保留范围与条数 */
  span(): LedgerSpan;
  clear(): void;
}

/**
 * 环形保留的读数账本。
 *
 * 用数组 + 头部游标而不是每 tick `shift()`：后者在 5 万条量级上是 O(n) 搬移，
 * 60× 倍速下会变成真正的 CPU 热点。游标推进到一半时做一次压缩，
 * 摊销成本 O(1)/条。
 */
export function createComplianceLedger(retentionMin = COMPLIANCE_RETENTION_MIN): ComplianceLedger {
  let buffer: MinuteReading[] = [];
  let head = 0;

  function compactIfNeeded(): void {
    if (head > 4096 && head > buffer.length / 2) {
      buffer = buffer.slice(head);
      head = 0;
    }
  }

  function trim(): void {
    const latest = buffer.length > head ? buffer[buffer.length - 1].minute : 0;
    const floorMin = latest - retentionMin;
    let advance = 0;
    while (head + advance < buffer.length && buffer[head + advance].minute < floorMin) advance += 1;
    head += advance;
    compactIfNeeded();
  }

  return {
    push(reading: MinuteReading): void {
      if (!Number.isFinite(reading.minute) || !Number.isFinite(reading.flowM3h)) return;
      const last = buffer.length > head ? buffer[buffer.length - 1] : null;
      if (last && last.minute === reading.minute) {
        buffer[buffer.length - 1] = reading;
        return;
      }
      if (last && reading.minute < last.minute) {
        // 回放/时钟回拨：只接受不倒退的读数，避免窗口统计里出现乱序点
        return;
      }
      buffer.push(reading);
      trim();
    },
    readings(fromMin: number, toMin: number): MinuteReading[] {
      if (!Number.isFinite(fromMin) || !Number.isFinite(toMin) || toMin < fromMin) return [];
      const out: MinuteReading[] = [];
      for (let i = head; i < buffer.length; i += 1) {
        const r = buffer[i];
        if (r.minute < fromMin) continue;
        if (r.minute > toMin) break;
        out.push(r);
      }
      return out;
    },
    span(): LedgerSpan {
      if (buffer.length <= head) return { fromMin: 0, toMin: 0, count: 0 };
      return {
        fromMin: buffer[head].minute,
        toMin: buffer[buffer.length - 1].minute,
        count: buffer.length - head,
      };
    },
    clear(): void {
      buffer = [];
      head = 0;
    },
  };
}
