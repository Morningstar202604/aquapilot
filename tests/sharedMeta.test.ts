import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 展示元数据的单一来源。
 *
 * 真实回归：日志/颜料/端口/图例各自持有一份颜色表，改一处忘一处，
 * 进水与出水一度同色，图例与画布也对不上。这里锁三件事：
 * 1. 颜色与短标签只在 shared/streamMeta 出现；
 * 2. 每个物流/单元都有元数据，不会渲染出 undefined；
 * 3. 时钟格式化只有一份实现，且各格式互相一致。
 */

const read = (p: string) => fs.readFileSync(p, 'utf8');

describe('物流与单元元数据', () => {
  it('所有 StreamKind 都有完整的展示元数据', async () => {
    const { STREAM_META } = await import('../src/shared/streamMeta');
    const kinds = Object.keys(STREAM_META);
    expect(kinds.length).toBeGreaterThanOrEqual(9);
    for (const [kind, meta] of Object.entries(STREAM_META)) {
      expect(meta.label.length, kind).toBeGreaterThan(0);
      expect(meta.short.length, kind).toBeLessThanOrEqual(2);
      expect(meta.color, kind).toMatch(/^#[0-9a-f]{6}$/i);
      expect(meta.width, kind).toBeGreaterThan(0);
    }
  });

  it('不同物流不能同色（否则总览图无法区分）', async () => {
    const { STREAM_META } = await import('../src/shared/streamMeta');
    const colors = Object.values(STREAM_META).map((m) => m.color.toLowerCase());
    expect(new Set(colors).size).toBe(colors.length);
  });

  it('图例顺序覆盖全部图例项且不重复', async () => {
    const { STREAM_META, STREAM_LEGEND_ORDER } = await import('../src/shared/streamMeta');
    expect(new Set(STREAM_LEGEND_ORDER).size).toBe(STREAM_LEGEND_ORDER.length);
    for (const s of STREAM_LEGEND_ORDER) expect(STREAM_META[s]).toBeTruthy();
  });

  it('所有 UnitKind 都有标签与图标', async () => {
    const { UNIT_META } = await import('../src/shared/streamMeta');
    const { UNIT_KINDS } = await import('../src/model/topology');
    for (const kind of UNIT_KINDS) {
      expect(UNIT_META[kind], kind).toBeTruthy();
      expect(UNIT_META[kind].label.length, kind).toBeGreaterThan(0);
      expect(UNIT_META[kind].icon.length, kind).toBeGreaterThan(0);
    }
  });

  it('组件里不再保留颜色字面量副本', () => {
    const canvas = read(path.join('src', 'client', 'components', 'PlantCanvas.tsx'));
    expect(canvas).not.toMatch(/#5b9cf5|#3ee0b5|#f0a83c/);
    const editor = read(path.join('src', 'client', 'components', 'ProcessEditor.tsx'));
    expect(editor).not.toMatch(/#5b9cf5|#3ee0b5/);
  });
});

describe('仿真时钟格式', () => {
  it('短格式与长格式互相一致', async () => {
    const { formatClock, formatClockLong, formatTimeOfDay, simClock } = await import('../src/shared/time');
    expect(formatClock(0)).toBe('D1 00:00');
    expect(formatClockLong(0)).toBe('第 1 天 00:00');
    expect(formatTimeOfDay(0)).toBe('00:00');
    expect(formatClock(1440 + 3 * 60 + 40)).toBe('D2 03:40');
    expect(formatClockLong(1440 + 3 * 60 + 40)).toBe('第 2 天 03:40');
    expect(simClock(1440 + 220)).toEqual({ day: 2, hour: 3, minute: 40 });
  });

  it('负数与非有限值不会输出 NaN', async () => {
    const { formatClock } = await import('../src/shared/time');
    expect(formatClock(-5)).toBe('D1 00:00');
    expect(formatClock(Number.NaN)).toBe('D1 00:00');
  });

  it('客户端与服务端都不再各自拼时钟字符串', () => {
    const files = [
      'src/client/components/Trends.tsx',
      'src/client/components/ReplayPanel.tsx',
      'src/client/components/AlarmsPanel.tsx',
      'src/server/export.ts',
    ];
    for (const f of files) {
      expect(read(path.join(...f.split('/'))), f).not.toMatch(/padStart\(2, '0'\).*padStart\(2, '0'\)/);
    }
  });
});
