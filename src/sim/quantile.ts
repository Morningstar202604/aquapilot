/**
 * 线性插值分位数（数组需已升序）。
 *
 * ensemble（预测区间）与 uncertainty（自助区间）都要按同一口径取 P10/P50/P90，
 * 之前各写一份，jscpd 立刻报克隆；实现只有六行，抽到一处比复制安全。
 */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
