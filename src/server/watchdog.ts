import { existsSync } from 'node:fs';

/**
 * 运行自检（watchdog）。
 *
 * 目的：把「AI 全程盯着日志和运行情况」做成产品能力，而不是一次性的人工巡检。
 * 每 10 秒跑一次确定性检查，异常广播一次、写结构化日志，并在界面上给出可读结论。
 *
 * 设计取舍：
 * - 纯函数 evaluate：输入一份观测快照，输出问题列表，便于单测；
 * - 只报「能行动」的问题，不做泛泛的健康分；
 * - 连续问题才升级为 warn，避免抖动刷屏（由调用方维护计数）。
 */

export type CheckSeverity = 'ok' | 'warn' | 'error';

export interface CheckInput {
  tickErrors: number;
  tickDelta: number;
  lastTickMs: number;
  simulationMinutes: number;
  paused: boolean;
  wsActive: number;
  llmCalls: number;
  llmFallbacks: number;
  persistence: 'enabled' | 'disabled';
  persistenceErrors: number;
  agentWarnings: number;
  agentPermission: string;
  hookFailures: number;
  llmConfigured: boolean;
  configPath: string;
}

export interface CheckResult {
  id: string;
  label: string;
  severity: CheckSeverity;
  detail: string;
  action: string;
}

export interface WatchdogReport {
  at: string;
  severity: CheckSeverity;
  checks: CheckResult[];
}

/** 纯函数：给定观测值输出自检结论 */
export function evaluateChecks(input: CheckInput): CheckResult[] {
  const out: CheckResult[] = [];

  out.push(
    input.tickErrors > 0
      ? {
          id: 'sim-ticks',
          label: '仿真步进',
          severity: 'error',
          detail: `累计 ${input.tickErrors} 次步进异常`,
          action: '查看服务端日志 sim 相关错误，必要时重置仿真',
        }
      : {
          id: 'sim-ticks',
          label: '仿真步进',
          severity: 'ok',
          detail: `无异常，仿真已推进 ${Math.round(input.simulationMinutes)} 分钟`,
          action: '无需处理',
        },
  );

  out.push(
    input.paused && input.tickDelta === 0
      ? {
          id: 'sim-live',
          label: '时钟推进',
          severity: 'warn',
          detail: '仿真处于暂停状态，时钟未推进',
          action: '确认是否为人工暂停；否则点顶栏「已暂停」恢复',
        }
      : input.tickDelta === 0
        ? {
            id: 'sim-live',
            label: '时钟推进',
            severity: 'error',
            detail: '仿真未暂停但时钟在最近一个窗口内没有推进',
            action: '检查 tick 定时器与服务端日志，必要时重启服务',
          }
        : {
            id: 'sim-live',
            label: '时钟推进',
            severity: 'ok',
            detail: `时钟正常推进（${Math.round(input.tickDelta)} 仿真分钟/窗口）`,
            action: '无需处理',
          },
  );

  out.push(
    input.lastTickMs > 500
      ? {
          id: 'sim-latency',
          label: '步进耗时',
          severity: 'warn',
          detail: `最近一次步进 ${input.lastTickMs.toFixed(0)} ms，接近 1 s 节拍`,
          action: '减少并发控制操作或降低倍速',
        }
      : {
          id: 'sim-latency',
          label: '步进耗时',
          severity: 'ok',
          detail: `${input.lastTickMs.toFixed(0)} ms`,
          action: '无需处理',
        },
  );

  const fallbackRate = input.llmCalls > 0 ? input.llmFallbacks / input.llmCalls : 0;
  out.push(
    !input.llmConfigured
      ? {
          id: 'llm',
          label: '模型链路',
          severity: 'warn',
          detail: '尚未配置自定义模型，回答只来自规则引擎',
          action: '顶栏「模型设置」接入一个可用模型',
        }
      : fallbackRate > 0.5 && input.llmCalls >= 4
        ? {
            id: 'llm',
            label: '模型链路',
            severity: 'warn',
            detail: `${input.llmCalls} 次调用中 ${input.llmFallbacks} 次降级（${Math.round(fallbackRate * 100)}%）`,
            action: '打开「模型设置」点连接测试，核对密钥/地址/模型名',
          }
        : {
            id: 'llm',
            label: '模型链路',
            severity: 'ok',
            detail: `调用 ${input.llmCalls} 次，降级 ${input.llmFallbacks} 次`,
            action: '无需处理',
          },
  );

  out.push(
    input.persistence === 'disabled'
      ? {
          id: 'persistence',
          label: '持久化',
          severity: 'warn',
          detail: '持久化已关闭（Node 20 或 AQUAPILOT_PERSIST=0），回放不可用',
          action: '如需要回放，请使用 Node 22+ 并确认 data/ 可写',
        }
      : input.persistenceErrors > 0
        ? {
            id: 'persistence',
            label: '持久化',
            severity: 'warn',
            detail: `写入失败 ${input.persistenceErrors} 次`,
            action: '检查 data/ 目录权限与磁盘空间',
          }
        : { id: 'persistence', label: '持久化', severity: 'ok', detail: '正常', action: '无需处理' },
  );

  out.push(
    input.agentWarnings > 0
      ? {
          id: 'agent-config',
          label: 'Agent 配置',
          severity: 'warn',
          detail: `${input.agentWarnings} 条归一化告警（部分字段被忽略或夹紧）`,
          action: '打开「Agent 设置」查看顶部告警并修正',
        }
      : {
          id: 'agent-config',
          label: 'Agent 配置',
          severity: 'ok',
          detail: `权限 ${input.agentPermission}，配置可读`,
          action: '无需处理',
        },
  );

  out.push(
    input.hookFailures > 0
      ? {
          id: 'hooks',
          label: '钩子',
          severity: 'warn',
          detail: `${input.hookFailures} 次执行失败`,
          action: '检查「Agent 设置 → 钩子」的目标地址与权限',
        }
      : { id: 'hooks', label: '钩子', severity: 'ok', detail: '无失败', action: '无需处理' },
  );

  out.push(
    existsSync(input.configPath)
      ? { id: 'agent-file', label: '配置文件', severity: 'ok', detail: input.configPath, action: '无需处理' }
      : {
          id: 'agent-file',
          label: '配置文件',
          severity: 'ok',
          detail: '尚未落盘（使用默认配置）',
          action: '在「Agent 设置」里保存一次即可生成',
        },
  );

  out.push({
    id: 'ws',
    label: '客户端连接',
    severity: input.wsActive > 0 ? 'ok' : 'warn',
    detail: `${input.wsActive} 个连接`,
    action: input.wsActive > 0 ? '无需处理' : '确认浏览器页面是否已打开',
  });

  return out;
}

export function overallSeverity(checks: CheckResult[]): CheckSeverity {
  if (checks.some((c) => c.severity === 'error')) return 'error';
  if (checks.some((c) => c.severity === 'warn')) return 'warn';
  return 'ok';
}

export function buildReport(input: CheckInput, at = new Date()): WatchdogReport {
  const checks = evaluateChecks(input);
  return { at: at.toISOString(), severity: overallSeverity(checks), checks };
}
