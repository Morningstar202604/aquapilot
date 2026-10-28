import { describe, expect, it } from 'vitest';

/**
 * 倍速推进的小数累积。
 *
 * 回归的缺陷：旧实现用 `Math.round(SIM_MINUTES_PER_TICK * speed)` 取步数，
 * 0.25× 时 2 × 0.25 = 0.5 被 round 成 1 —— 低倍速与 1× 完全一样，
 * 界面上的 0.25×/0.5× 档位是假的。
 */
function advanceMinutes(simMinutesPerTick: number, speed: number, frames: number): number {
  let carry = 0;
  let total = 0;
  for (let i = 0; i < frames; i++) {
    carry += simMinutesPerTick * speed;
    const steps = Math.floor(carry);
    carry -= steps;
    total += steps;
  }
  return total;
}

describe('仿真倍速', () => {
  it('0.25× 的推进量是 1× 的四分之一（不再被 round 成 1）', () => {
    const one = advanceMinutes(2, 1, 400);
    const quarter = advanceMinutes(2, 0.25, 400);
    expect(one).toBe(800);
    expect(quarter).toBe(200);
  });

  it('0.5× 与 2× 都按真实倍率推进', () => {
    expect(advanceMinutes(2, 0.5, 100)).toBe(100);
    expect(advanceMinutes(2, 2, 100)).toBe(400);
  });

  it('长期平均速度准确（余量不丢）', () => {
    // 2 分钟/帧 × 0.25 = 0.5 分钟/帧：两帧推进 1 分钟
    expect(advanceMinutes(2, 0.25, 2)).toBe(1);
    expect(advanceMinutes(2, 0.75, 4)).toBe(6);
  });

  it('8× 上限仍然逐帧推进整分钟', () => {
    expect(advanceMinutes(2, 8, 10)).toBe(160);
  });
});
