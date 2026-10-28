/**
 * 顶栏提示条（toast）的生命周期。
 *
 * 真实缺陷：提示只在到达时 append，永不删除。运行一小时后右下角叠着
 * 「AI 已执行」「场景窗口结束」「钩子命中」等 5 条旧消息，遮住趋势图与
 * 缩放控件；而且越早的消息还在最上面，读起来像实时状态。
 *
 * 规则收敛在这里：最多保留 NOTICE_LIMIT 条、每条最多活 NOTICE_TTL_MS，
 * 纯函数，便于单测与在组件里复用。
 */

export interface Notice {
  id: number;
  level: string;
  text: string;
  /** 到达时刻（Date.now()） */
  at: number;
}

export const NOTICE_LIMIT = 3;
export const NOTICE_TTL_MS = 12_000;

/** 追加一条提示：新的排在最前，超出上限的旧消息被丢弃 */
export function pushNotice(list: Notice[], notice: Notice, limit = NOTICE_LIMIT): Notice[] {
  return [notice, ...list].slice(0, limit);
}

/** 丢掉超过存活期的提示 */
export function pruneNotices(list: Notice[], now: number, ttl = NOTICE_TTL_MS): Notice[] {
  return list.filter((n) => now - n.at < ttl);
}
