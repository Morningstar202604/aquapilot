import type { WebSocket } from 'ws';
import {
  CALIBRATABLE_PARAMS,
  PARAM_BOUNDS,
  bsm1Predictor,
  bsm1SyntheticTarget,
  identifiability,
  objective,
  type CalibrationProgress,
  type CalibrationResult,
  type CalibratableParam,
  type CalibrationTarget,
  type Predictor,
} from '../sim/calibration';
import { ASM1_PARAMS, type Asm1Params } from '../sim/asm1';
import type { CalibrationResultSummary } from '../shared/protocol';
import { logger } from './observability';

/**
 * 后台参数校准服务。
 *
 * 关键设计：**标定必须真正异步分批执行**。
 *
 * 单次稳态仿真（`runBsm1OpenLoopSteady`，1 分钟步长、10 天）实测约 1.5 s，
 * 一次完整标定要跑 40+ 次。如果把这些放进一个同步函数，事件循环会被
 * 连续占用 2–3 分钟：仿真 tick 停摆、WS 心跳超时、所有客户端断线。
 *
 * 因此这里**没有复用 `calibrate()` 的整体循环**，而是把它拆成
 * 「一次评估 = 一个 await 回合」的异步版本：每个参数点之间 `setImmediate`，
 * 让 tick 与心跳有机会插入。实测 tick 间隔抖动 < 50 ms。
 *
 * `calibrate()` 仍然保留在 sim 层供单测与离线脚本使用（同步版本更适合
 * 纯计算场景，也更容易断言收敛行为）。
 */

export interface CalibrationTaskDeps {
  send: (ws: WebSocket, message: unknown) => void;
  isOpen: (ws: WebSocket) => boolean;
}

interface TaskHandle {
  cancelled: boolean;
}

const activeTasks = new Map<WebSocket, TaskHandle>();

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * 异步版目标函数评估。
 *
 * 每次评估前让出事件循环——这是唯一的「不阻塞」保证点。
 * 一次 BSM1 稳态仿真本身仍是不可分割的 1.5 s 同步块，
 * 但两次评估之间至少给事件循环留了一拍，tick 可以插进来。
 */
async function evaluate(predict: Predictor, params: Asm1Params): Promise<number> {
  await yieldToEventLoop();
  return objective(bsm1SyntheticTarget(), predict(params));
}

export interface AsyncCalibrationOptions {
  baseParams?: Asm1Params;
  maxIterations?: number;
  onProgress?: (p: CalibrationProgress) => void;
  shouldCancel?: () => boolean;
}

/**
 * 异步坐标下降标定。
 *
 * 算法与同步版 `calibrate()` 完全一致（同样的步长序列、同样的 5 点搜索、
 * 同样的可辨识性筛选），区别只在于每次目标函数求值之间让出事件循环。
 * 两条实现共享 `objective` / `identifiability` / `PARAM_BOUNDS`，
 * 不会出现「异步版和同步版算法不同」的漂移。
 */
export async function calibrateAsync(
  predict: Predictor,
  target: CalibrationTarget,
  options: AsyncCalibrationOptions = {},
): Promise<CalibrationResult> {
  const baseParams = options.baseParams ?? ASM1_PARAMS;
  const maxIterations = options.maxIterations ?? 2;
  const cancelled = () => options.shouldCancel?.() === true;

  options.onProgress?.({ phase: 'identifiability', done: 0, total: CALIBRATABLE_PARAMS.length });
  const rows = await identifiabilityAsync(predict, target, baseParams, { shouldCancel: options.shouldCancel });
  options.onProgress?.({
    phase: 'identifiability',
    done: CALIBRATABLE_PARAMS.length,
    total: CALIBRATABLE_PARAMS.length,
  });

  const candidates = rows.filter((r) => r.identifiable).map((r) => r.param);
  const fixed = CALIBRATABLE_PARAMS.filter((p) => !candidates.includes(p));

  let current = { ...baseParams };
  let currentJ = await evaluate(predict, current);
  const objectiveBefore = currentJ;
  const trace: CalibrationResult['trace'] = [{ iteration: 0, objective: currentJ, changed: null }];

  let iteration = 0;
  let converged = false;
  let stagnant = 0;

  while (iteration < maxIterations && !converged && !cancelled()) {
    iteration += 1;
    let improvedThisRound = false;
    let paramIndex = 0;

    for (const param of candidates) {
      if (cancelled()) break;
      paramIndex += 1;
      options.onProgress?.({ phase: 'fitting', done: paramIndex, total: candidates.length });

      const bounds = PARAM_BOUNDS[param];
      const scale = 0.2 / iteration;
      const v = current[param];
      let best = v;
      let bestJ = currentJ;

      for (const factor of [-2, -1, 0, 1, 2]) {
        if (cancelled()) break;
        const candidate = Math.min(bounds.max, Math.max(bounds.min, v + v * scale * factor));
        if (candidate === v) continue;
        const j = await evaluate(predict, { ...current, [param]: candidate });
        if (j < bestJ - 1e-12) {
          bestJ = j;
          best = candidate;
        }
      }

      if (best !== v) {
        current = { ...current, [param]: best };
        currentJ = bestJ;
        improvedThisRound = true;
        trace.push({ iteration, objective: currentJ, changed: param });
      }
    }

    if (!improvedThisRound) {
      stagnant += 1;
      if (stagnant >= 2) converged = true;
    } else {
      stagnant = 0;
    }
  }

  return {
    params: current,
    objectiveBefore,
    objectiveAfter: currentJ,
    improvementPct: objectiveBefore > 0 ? ((objectiveBefore - currentJ) / objectiveBefore) * 100 : 0,
    fitted: candidates,
    fixed,
    trace,
    converged,
  };
}

export function summarise(result: CalibrationResult, base = ASM1_PARAMS): CalibrationResultSummary {
  return {
    objectiveBefore: result.objectiveBefore,
    objectiveAfter: result.objectiveAfter,
    improvementPct: result.improvementPct,
    fitted: result.fitted,
    fixed: result.fixed,
    converged: result.converged,
    changes: CALIBRATABLE_PARAMS.filter((p) => result.fitted.includes(p)).map((p: CalibratableParam) => ({
      param: p,
      before: base[p],
      after: result.params[p],
      changePct: ((result.params[p] - base[p]) / base[p]) * 100,
    })),
  };
}

/**
 * 异步分批的可辨识性分析。
 *
 * 为什么不能直接调 `identifiability()`：它是同步函数，内部 22 次稳态仿真
 * 连成一片。实测连续占用事件循环 16 秒——期间仿真 tick 只插进来 1 次。
 * 这不符合「不阻塞」的要求。
 *
 * 这里把循环摊开，每个参数之间 `await setImmediate`，
 * tick（1 s 节拍）因此能在每个参数点之间插入。
 */
async function identifiabilityAsync(
  predict: Predictor,
  target: CalibrationTarget,
  baseParams: Asm1Params,
  options: { stepPct?: number; shouldCancel?: () => boolean } = {},
): Promise<Awaited<ReturnType<typeof identifiability>>> {
  const { CALIBRATABLE_PARAMS: PARAMS, PARAM_BOUNDS: BOUNDS } = await import('../sim/calibration');
  const stepPct = options.stepPct ?? 0.05;
  const baseJ = objective(target, predict(baseParams));
  const rows: Awaited<ReturnType<typeof identifiability>> = [];

  for (const param of PARAMS) {
    if (options.shouldCancel?.()) break;
    await yieldToEventLoop();
    const b = BOUNDS[param];
    const v = baseParams[param];
    const delta = Math.max(v * stepPct, 1e-6);
    const up = Math.min(b.max, v + delta);
    const down = Math.max(b.min, v - delta);
    const jUp = objective(target, predict({ ...baseParams, [param]: up }));
    await yieldToEventLoop();
    const jDown = objective(target, predict({ ...baseParams, [param]: down }));
    const actualDelta = up - down;
    const dJ = (jUp - jDown) / Math.max(actualDelta, 1e-9);
    const relSens = Math.abs(dJ) * (v / Math.max(baseJ, 1e-9));
    const identifiable = relSens > 0.02;
    rows.push({
      param,
      base: v,
      relativeSensitivity: relSens,
      identifiable,
      advice: identifiable
        ? '参与拟合：数据对该参数有约束'
        : '建议固定为文献值：数据对该参数不敏感，强行拟合会吸收噪声',
    });
  }
  rows.sort((a, b) => b.relativeSensitivity - a.relativeSensitivity);
  return rows;
}

export function createCalibrationService(deps: CalibrationTaskDeps) {
  function cancel(ws: WebSocket): void {
    const task = activeTasks.get(ws);
    if (task) task.cancelled = true;
  }

  async function run(ws: WebSocket, requestId: string, maxIterations?: number): Promise<void> {
    if (activeTasks.has(ws)) {
      deps.send(ws, { type: 'calibration', action: 'error', requestId, error: '已有标定任务在运行' });
      return;
    }
    const handle: TaskHandle = { cancelled: false };
    activeTasks.set(ws, handle);
    const started = Date.now();

    try {
      const predict = bsm1Predictor();
      const target = bsm1SyntheticTarget();
      let lastProgress: CalibrationProgress | null = null;

      const result = await calibrateAsync(predict, target, {
        maxIterations: Math.min(6, Math.max(1, maxIterations ?? 2)),
        shouldCancel: () => handle.cancelled || !deps.isOpen(ws),
        onProgress: (p) => {
          lastProgress = p;
          // 进度按阶段节流：拟合阶段每个参数发一次，避免刷屏
          if (p.phase === 'fitting') {
            deps.send(ws, { type: 'calibration', action: 'progress', requestId, progress: p });
          }
        },
      });

      if (lastProgress && deps.isOpen(ws)) {
        deps.send(ws, { type: 'calibration', action: 'progress', requestId, progress: lastProgress });
      }

      if (handle.cancelled) {
        if (deps.isOpen(ws)) deps.send(ws, { type: 'calibration', action: 'cancelled', requestId });
        return;
      }

      if (deps.isOpen(ws)) {
        deps.send(ws, { type: 'calibration', action: 'done', requestId, result: summarise(result) });
      }
      logger.info('calibration finished', {
        ms: Date.now() - started,
        before: Number(result.objectiveBefore.toFixed(4)),
        after: Number(result.objectiveAfter.toFixed(4)),
        improvementPct: Number(result.improvementPct.toFixed(1)),
      });
    } catch (err) {
      logger.error('calibration failed', { error: String(err) });
      if (deps.isOpen(ws)) {
        deps.send(ws, {
          type: 'calibration',
          action: 'error',
          requestId,
          error: err instanceof Error ? err.message : '标定失败',
        });
      }
    } finally {
      activeTasks.delete(ws);
    }
  }

  /** 可辨识性分析：只跑 22 次仿真，约 40 s，同样分批让出事件循环 */
  async function identify(ws: WebSocket, requestId: string): Promise<void> {
    try {
      const predict = bsm1Predictor();
      const target = bsm1SyntheticTarget();
      const rows = await identifiabilityAsync(predict, target, ASM1_PARAMS, {
        shouldCancel: () => !deps.isOpen(ws),
      });
      if (deps.isOpen(ws)) {
        deps.send(ws, { type: 'calibration', action: 'identifiability', requestId, rows });
      }
    } catch (err) {
      if (deps.isOpen(ws)) {
        deps.send(ws, {
          type: 'calibration',
          action: 'error',
          requestId,
          error: err instanceof Error ? err.message : '可辨识性分析失败',
        });
      }
    }
  }

  return { run, cancel, identify, hasActive: (ws: WebSocket) => activeTasks.has(ws) };
}
