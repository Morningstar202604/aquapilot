/**
 * 仿真时钟格式化（唯一来源）。
 *
 * 同一段 `D{day} {hh}:{mm}` 拼接此前在 8 处各写一遍（趋势图、回放、告警、
 * 导出、报告、顶栏…）。任何一处改了格式，界面与导出就会不一致；
 * 这里统一成两个入口：短格式给图表轴，长格式给标题与人读文案。
 */

export interface SimClock {
  day: number;
  hour: number;
  minute: number;
}

export function simClock(minutes: number): SimClock {
  const safe = Number.isFinite(minutes) ? Math.max(0, minutes) : 0;
  return {
    day: Math.floor(safe / 1440) + 1,
    hour: Math.floor((safe % 1440) / 60),
    minute: Math.floor(safe % 60),
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `D2 03:40` */
export function formatClock(minutes: number): string {
  const c = simClock(minutes);
  return `D${c.day} ${pad(c.hour)}:${pad(c.minute)}`;
}

/** `第 2 天 03:40` */
export function formatClockLong(minutes: number): string {
  const c = simClock(minutes);
  return `第 ${c.day} 天 ${pad(c.hour)}:${pad(c.minute)}`;
}

/** `03:40`（仅时刻，用于表格单元格） */
export function formatTimeOfDay(minutes: number): string {
  const c = simClock(minutes);
  return `${pad(c.hour)}:${pad(c.minute)}`;
}
