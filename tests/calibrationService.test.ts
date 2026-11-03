import { describe, expect, it } from 'vitest';
import { ASM1_PARAMS } from '../src/sim/asm1';
import type { WebSocket } from 'ws';

/**
 * calibrationService 的分支覆盖补齐。
 *
 * 设计约束与 tests/calibration.test.ts 相同：**不跑真实标定**。
 * 真实标定一次 75–80 秒（20+ 次稳态仿真）；这里用三条廉价路径
 * 把 run/identify/calibrateAsync 的控制流分支走到：
 * 1. isOpen=false → shouldCancel 立即为真 → 可辨识性循环第一个参数就 break；
 * 2. cancel(ws) → handle.cancelled → 走「已取消」应答分支；
 * 3. 同步连续发起 → 命中「已有任务 / 任务过多」两条守卫分支。
 * 除路径 2 只需一次目标函数评估（约 1.5 s BSM1 稳态）外，其余几乎零成本。
 */
describe('calibrationService 分支覆盖', () => {
  it('run：连接已关闭时静默结束，不发送任何消息', async () => {
    const { createCalibrationService } = await import('../src/server/calibrationService');
    const sent: unknown[] = [];
    const service = createCalibrationService({
      send: (_ws, msg) => sent.push(msg),
      isOpen: () => false,
    });
    const ws = {} as WebSocket;
    await service.run(ws, 'r-closed');
    expect(sent).toEqual([]);
    expect(service.hasActive(ws)).toBe(false);
  }, 30000);

  it('cancel：运行中的任务被取消后应答 cancelled', async () => {
    const { createCalibrationService } = await import('../src/server/calibrationService');
    const actions: string[] = [];
    const service = createCalibrationService({
      send: (_ws, msg) => actions.push((msg as { action: string }).action),
      isOpen: () => true,
    });
    const ws = {} as WebSocket;
    const running = service.run(ws, 'r-cancel');
    service.cancel(ws); // 同步取消：可辨识性分析在第一个参数处 break
    await running;
    expect(actions).toContain('cancelled');
    expect(service.hasActive(ws)).toBe(false);
  }, 60000);

  it('run：同一连接重复发起被拒绝', async () => {
    const { createCalibrationService } = await import('../src/server/calibrationService');
    const errors: string[] = [];
    let open = true;
    const service = createCalibrationService({
      send: (_ws, msg) => {
        const m = msg as { action: string; error?: string };
        if (m.action === 'error') errors.push(m.error ?? '');
      },
      isOpen: () => open,
    });
    const ws = {} as WebSocket;
    const first = service.run(ws, 'r-1');
    // 同一同步块内第二次发起：activeTasks 已登记 → 守卫命中
    await service.run(ws, 'r-2');
    open = false; // 让第一个任务尽快取消
    await first;
    expect(errors).toContain('已有标定任务在运行');
  }, 60000);

  it('run：并发超过上限被拒绝', async () => {
    const { createCalibrationService, MAX_ACTIVE_CALIBRATION_TASKS } = await import('../src/server/calibrationService');
    const errors: string[] = [];
    let open = true;
    const service = createCalibrationService({
      send: (_ws, msg) => {
        const m = msg as { action: string; error?: string };
        if (m.action === 'error') errors.push(m.error ?? '');
      },
      isOpen: () => open,
    });
    const running = [] as Promise<void>[];
    for (let i = 0; i < MAX_ACTIVE_CALIBRATION_TASKS; i++) {
      running.push(service.run({} as WebSocket, `r-fill-${i}`));
    }
    await service.run({} as WebSocket, 'r-overflow');
    open = false;
    await Promise.all(running);
    expect(errors).toContain('标定任务过多，请稍后再试');
  }, 60000);

  it('identify：连接已关闭时不发送，可辨识性循环被取消截断', async () => {
    const { createCalibrationService } = await import('../src/server/calibrationService');
    const sent: unknown[] = [];
    const service = createCalibrationService({
      send: (_ws, msg) => sent.push(msg),
      isOpen: () => false,
    });
    await service.identify({} as WebSocket, 'r-id');
    expect(sent).toEqual([]);
  });

  it('calibrateAsync：可辨识性完成后取消则不进入拟合（参数保持基准）', async () => {
    const { calibrateAsync } = await import('../src/server/calibrationService');
    // 首次报 fitting 进度即取消：筛选已完成，但拟合在第一个参数的因子搜索处中断
    let sawFitting = false;
    const result = await calibrateAsync(
      (p) => ({ cod: 22, ss: 8, nh: 6 / p.mu_A, tn: 10 }),
      { observed: { cod: 22, ss: 8, nh: 1.2, tn: 10 } },
      {
        baseParams: { ...ASM1_PARAMS, mu_A: 0.5 },
        maxIterations: 3,
        onProgress: (p) => {
          if (p.phase === 'fitting') sawFitting = true;
        },
        shouldCancel: () => sawFitting,
      },
    );
    expect(result.converged).toBe(false); // 被取消，不是收敛
    expect(result.fitted).toContain('mu_A'); // 筛选已完成，候选已产出
    expect(result.trace).toHaveLength(1); // 没有任何参数被改进
  });

  it('calibrateAsync：起点即完美解时改善为零（objectiveBefore=0 分支）', async () => {
    const { calibrateAsync } = await import('../src/server/calibrationService');
    // 常量预测恒等于观测：objectiveBefore 精确为 0，improvementPct 走「非正」分支
    const result = await calibrateAsync(
      () => ({ cod: 30, ss: 8, nh: 1.5, tn: 10 }),
      { observed: { cod: 30, ss: 8, nh: 1.5, tn: 10 } },
      { maxIterations: 1 },
    );
    expect(result.objectiveBefore).toBe(0);
    expect(result.improvementPct).toBe(0);
    expect(result.fitted).toEqual([]); // 常量预测对所有参数都不敏感
  });
});
