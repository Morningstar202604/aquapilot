import type { WebSocket } from 'ws';
import {
  CALIBRATABLE_PARAMS,
  bsm1Predictor,
  bsm1SyntheticTarget,
  calibrate as calibrateCore,
  datasetFromTarget,
  identifiability,
  type CalibrationProgress,
  type CalibrationResult,
  type CalibratableParam,
  type CalibrationTarget,
  type Predictor,
} from '../sim/calibration';
import { ASM1_PARAMS, type Asm1Params } from '../sim/asm1';
import {
  assessSufficiency,
  type CorrelationMatrix,
  type ParamInterval,
  type PredictionUncertainty,
  type SufficiencyReport,
  type UncertaintyResult,
} from '../sim/uncertainty';
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
export const MAX_ACTIVE_CALIBRATION_TASKS = 2;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export interface AsyncCalibrationOptions {
  baseParams?: Asm1Params;
  maxIterations?: number;
  onProgress?: (p: CalibrationProgress) => void;
  shouldCancel?: () => boolean;
}

/**
 * 异步标定入口。
 *
 * 核心算法和同步 CLI 只剩 `sim/calibration.ts` 一份；这里只负责注入
 * 「每次目标函数求值前让出事件循环」这一件事，不再维护第二套坐标下降。
 */
export async function calibrateAsync(
  predict: Predictor,
  target: CalibrationTarget,
  options: AsyncCalibrationOptions = {},
): Promise<CalibrationResult> {
  return calibrateCore(predict, target, {
    baseParams: options.baseParams,
    maxIterations: options.maxIterations ?? 2,
    onProgress: options.onProgress,
    shouldCancel: options.shouldCancel,
    beforeEvaluate: yieldToEventLoop,
  });
}

/**
 * 标定结果里的不确定性摘要。
 *
 * 数据不足或未跑区间分析时 `available=false`，并带上充分性判定原因；
 * 旧客户端只读既有字段（objectiveBefore/changes/...），新增字段不删旧字段。
 */
export interface UncertaintySummary {
  available: boolean;
  code: string | null;
  dataSource: 'synthetic' | 'field';
  coverage: SufficiencyReport | null;
  intervals: ParamInterval[];
  correlation: CorrelationMatrix | null;
  predictions: PredictionUncertainty | null;
}

export type CalibrationSummary = CalibrationResultSummary & { uncertainty: UncertaintySummary };

function unavailableSummary(
  coverage: SufficiencyReport | null,
  dataSource: 'synthetic' | 'field',
  code: string | null,
): UncertaintySummary {
  return {
    available: false,
    code,
    dataSource,
    coverage,
    intervals: [],
    correlation: null,
    predictions: null,
  };
}

export function summariseUncertainty(
  result: UncertaintyResult,
  predictions: PredictionUncertainty | null = null,
): UncertaintySummary {
  return {
    available: result.code === 'OK',
    code: result.code,
    dataSource: result.dataSource,
    coverage: result.coverage,
    intervals: result.intervals,
    correlation: result.correlation,
    predictions,
  };
}

export function summarise(
  result: CalibrationResult,
  base = ASM1_PARAMS,
  uncertainty?: UncertaintySummary | null,
): CalibrationSummary {
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
    uncertainty: uncertainty ?? unavailableSummary(null, 'synthetic', null),
  };
}

export function createCalibrationService(deps: CalibrationTaskDeps) {
  function cancel(ws: WebSocket): void {
    const task = activeTasks.get(ws);
    if (task) task.cancelled = true;
  }

  /** 任务准入：重复连接与全局并发上限两道门，run/identify 共用 */
  function acquireTask(ws: WebSocket, requestId: string): TaskHandle | null {
    if (activeTasks.has(ws)) {
      deps.send(ws, { type: 'calibration', action: 'error', requestId, error: '已有标定任务在运行' });
      return null;
    }
    if (activeTasks.size >= MAX_ACTIVE_CALIBRATION_TASKS) {
      deps.send(ws, { type: 'calibration', action: 'error', requestId, error: '标定任务过多，请稍后再试' });
      return null;
    }
    const handle: TaskHandle = { cancelled: false };
    activeTasks.set(ws, handle);
    return handle;
  }

  async function run(ws: WebSocket, requestId: string, maxIterations?: number): Promise<void> {
    const handle = acquireTask(ws, requestId);
    if (!handle) return;
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
        // 合成目标只有出水、没有剖面，按充分性判据不具备区间分析条件；
        // 摘要如实标注不可用与原因，不返回一组假区间冒充标定完成。
        const coverage = assessSufficiency(datasetFromTarget(target), result.fitted.length);
        const uncertaintySummary = unavailableSummary(
          coverage,
          'synthetic',
          coverage.sufficient ? null : 'CALIBRATION_INSUFFICIENT_DATA',
        );
        deps.send(ws, {
          type: 'calibration',
          action: 'done',
          requestId,
          result: summarise(result, ASM1_PARAMS, uncertaintySummary),
        });
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
    const handle = acquireTask(ws, requestId);
    if (!handle) return;
    try {
      const predict = bsm1Predictor();
      const target = bsm1SyntheticTarget();
      const rows = await identifiability(predict, target, ASM1_PARAMS, 0.05, {
        shouldCancel: () => handle.cancelled || !deps.isOpen(ws),
        beforeEvaluate: yieldToEventLoop,
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
    } finally {
      activeTasks.delete(ws);
    }
  }

  return { run, cancel, identify, hasActive: (ws: WebSocket) => activeTasks.has(ws) };
}
