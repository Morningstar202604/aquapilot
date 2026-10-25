import { describe, expect, it } from 'vitest';
import { PLANT_TOPOLOGY, ProcessTopology } from '../src/model/topology';
import {
  HISTORY_CAP,
  MERGE_WINDOW_MS,
  canRedoHistory,
  canUndoHistory,
  commitHistory,
  emptyHistory,
  redoHistory,
  seedHistory,
  undoHistory,
} from '../src/client/hooks/topoHistory';

const clone = (): ProcessTopology => JSON.parse(JSON.stringify(PLANT_TOPOLOGY));

describe('拓扑编辑历史（撤销/重做）', () => {
  it('播种基线后可撤销到初始态', () => {
    const base = clone();
    const h = seedHistory(emptyHistory(), base);
    const edited = commitHistory(h, { ...base, name: '改名' }, 1000);
    expect(canUndoHistory(edited)).toBe(true);
    const back = undoHistory(edited);
    expect(back.stack[back.idx].name).toBe(base.name);
    expect(canRedoHistory(back)).toBe(true);
    const fwd = redoHistory(back);
    expect(fwd.stack[fwd.idx].name).toBe('改名');
  });

  it('800ms 内连续编辑合并为一步', () => {
    const base = clone();
    const h = seedHistory(emptyHistory(), base);
    const a = commitHistory(h, { ...base, name: 'A' }, 1000);
    const b = commitHistory(a, { ...base, name: 'B' }, 1300); // 300ms 后：合并
    expect(b.idx).toBe(1); // 仍是基线 + 一步
    expect(b.stack[b.idx].name).toBe('B');
    const back = undoHistory(b);
    expect(back.stack[back.idx].name).toBe(base.name);
  });

  it('超过合并窗口产生新一步', () => {
    const base = clone();
    const h = seedHistory(emptyHistory(), base);
    const a = commitHistory(h, { ...base, name: 'A' }, 1000);
    const b = commitHistory(a, { ...base, name: 'B' }, 1000 + MERGE_WINDOW_MS + 1);
    expect(b.idx).toBe(2);
  });

  it('无变化不产生历史', () => {
    const base = clone();
    const h = seedHistory(emptyHistory(), base);
    const same = commitHistory(h, base, 2000);
    expect(same.idx).toBe(h.idx);
    expect(same.stack).toHaveLength(1);
  });

  it('新一步剪掉 redo 分支', () => {
    const base = clone();
    const h = seedHistory(emptyHistory(), base);
    const a = commitHistory(h, { ...base, name: 'A' }, 1000);
    const b = commitHistory(a, { ...base, name: 'B' }, 2000);
    const back = undoHistory(b); // 回到 A
    const diverge = commitHistory(back, { ...base, name: 'C' }, 3000); // 新分支
    expect(canRedoHistory(diverge)).toBe(false);
    expect(diverge.stack[diverge.idx].name).toBe('C');
  });

  it('栈深封顶 HISTORY_CAP，最早的步骤被淘汰', () => {
    const base = clone();
    let h = seedHistory(emptyHistory(), base);
    let t = 1000;
    for (let i = 0; i < HISTORY_CAP + 5; i++) {
      h = commitHistory(h, { ...base, name: `s${i}` }, t);
      t += MERGE_WINDOW_MS + 1;
    }
    expect(h.stack.length).toBeLessThanOrEqual(HISTORY_CAP);
    // 最老的 5 步已被淘汰，栈底不是基线
    expect(h.stack[0].name).toBe('s5');
    // 但撤销仍可一路回到栈底（不越界）
    let steps = 0;
    while (canUndoHistory(h) && steps < HISTORY_CAP + 1) {
      h = undoHistory(h);
      steps += 1;
    }
    expect(h.idx).toBe(0);
  });
});
