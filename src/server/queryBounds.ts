/**
 * 历史查询的时间窗边界。
 *
 * 快照表没有保留策略时，`to` 缺省为 MAX_SAFE_INTEGER 会让一次请求
 * 把整张表读进内存并在主线程 JSON/CSV 拼接——长跑后这就是 OOM。
 * 这里强制单次窗口有上限，并要求两个端点都是有限数。
 */

export const MAX_SNAPSHOT_WINDOW_MIN = 7 * 24 * 60;
export const MAX_SNAPSHOT_POINTS = 20_000;

export type WindowResult = { ok: true; from: number; to: number } | { ok: false; error: string };

export function boundedWindow(url: URLSearchParams): WindowResult {
  const from = Number(url.get('from') ?? 0);
  const rawTo = url.get('to');
  const to = rawTo === null ? from + MAX_SNAPSHOT_WINDOW_MIN : Number(rawTo);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return { ok: false, error: 'from/to 必须是有限数值' };
  if (to < from) return { ok: false, error: 'to 必须大于等于 from' };
  if (to - from > MAX_SNAPSHOT_WINDOW_MIN) {
    return { ok: false, error: `单次最多查询 ${MAX_SNAPSHOT_WINDOW_MIN} 仿真分钟` };
  }
  return { ok: true, from, to };
}
