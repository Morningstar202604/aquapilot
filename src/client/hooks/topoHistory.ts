import type { ProcessTopology } from '../../model/topology';

/**
 * 拓扑编辑撤销/重做（纯函数）。
 *
 * draft 由历史栈推导，避免「历史状态」与「当前草稿」两套真相漂移。
 * 高频连续编辑（拖动连线、连续改容积）在 MERGE_WINDOW_MS 窗口内合并为一步，
 * 撤销粒度是「一次交互」而不是「每一帧」；栈深 HISTORY_CAP。
 */
export interface HistoryEntry extends ProcessTopology {
  __t?: number;
}

export interface TopoHistory {
  stack: HistoryEntry[];
  idx: number;
}

export const HISTORY_CAP = 30;
export const MERGE_WINDOW_MS = 800;

export function emptyHistory(): TopoHistory {
  return { stack: [], idx: -1 };
}

/** 进入编辑器时播种基线（只在栈为空时生效） */
export function seedHistory(h: TopoHistory, base: ProcessTopology): TopoHistory {
  return h.stack.length === 0 ? { stack: [{ ...base }], idx: 0 } : h;
}

export function commitHistory(h: TopoHistory, next: ProcessTopology, now = Date.now()): TopoHistory {
  const last = h.idx >= 0 ? h.stack[h.idx] : null;
  // 无变化：不产生历史
  if (last && JSON.stringify(last) === JSON.stringify(next)) return h;
  // 高频连续编辑合并为一步：只更新最后一步的状态，不新增
  if (last && now - (last.__t ?? 0) < MERGE_WINDOW_MS) {
    const merged = h.stack.slice(0, h.idx + 1);
    merged[h.idx] = { ...next, __t: now };
    return { stack: merged, idx: h.idx };
  }
  // 新一步：剪掉 redo 分支后追加（栈深封顶）
  const trimmed = h.stack.slice(0, h.idx + 1);
  trimmed.push({ ...next, __t: now });
  const tail = trimmed.slice(-HISTORY_CAP);
  return { stack: tail, idx: tail.length - 1 };
}

export function undoHistory(h: TopoHistory): TopoHistory {
  return h.idx > 0 ? { ...h, idx: h.idx - 1 } : h;
}

export function redoHistory(h: TopoHistory): TopoHistory {
  return h.idx < h.stack.length - 1 ? { ...h, idx: h.idx + 1 } : h;
}

export function canUndoHistory(h: TopoHistory): boolean {
  return h.idx > 0;
}

export function canRedoHistory(h: TopoHistory): boolean {
  return h.idx < h.stack.length - 1;
}
