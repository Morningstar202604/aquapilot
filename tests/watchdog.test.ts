import { describe, expect, it } from 'vitest';
import { buildReport, evaluateChecks, overallSeverity, type CheckInput } from '../src/server/watchdog';

/**
 * 运行自检的判定逻辑。
 *
 * 这一层必须是纯函数：否则「AI 盯着日志」就变成不可复核的黑盒。
 * 每条检查都对应一个真实会发生、且能采取行动的问题。
 */

const base: CheckInput = {
  tickErrors: 0,
  tickDelta: 5,
  lastTickMs: 3,
  simulationMinutes: 120,
  paused: false,
  wsActive: 1,
  llmCalls: 10,
  llmFallbacks: 0,
  persistence: 'enabled',
  persistenceErrors: 0,
  agentWarnings: 0,
  agentPermission: 'standard',
  hookFailures: 0,
  llmConfigured: true,
  configPath: '/tmp/does-not-exist-agent-config.json',
};

const find = (checks: ReturnType<typeof evaluateChecks>, id: string) => checks.find((c) => c.id === id)!;

describe('仿真相关检查', () => {
  it('无异常时为 ok 且带推进分钟数', () => {
    const c = find(evaluateChecks(base), 'sim-ticks');
    expect(c.severity).toBe('ok');
    expect(c.detail).toContain('120');
  });

  it('有步进异常时升为 error 并给处置建议', () => {
    const c = find(evaluateChecks({ ...base, tickErrors: 3 }), 'sim-ticks');
    expect(c.severity).toBe('error');
    expect(c.detail).toContain('3');
    expect(c.action).toContain('日志');
  });

  it('暂停且不推进是 warn，不是 error', () => {
    const c = find(evaluateChecks({ ...base, paused: true, tickDelta: 0 }), 'sim-live');
    expect(c.severity).toBe('warn');
    expect(c.detail).toContain('暂停');
  });

  it('未暂停但不推进是 error', () => {
    const c = find(evaluateChecks({ ...base, tickDelta: 0 }), 'sim-live');
    expect(c.severity).toBe('error');
    expect(c.action).toContain('重启');
  });

  it('步进耗时超过 500ms 告警', () => {
    expect(find(evaluateChecks({ ...base, lastTickMs: 800 }), 'sim-latency').severity).toBe('warn');
    expect(find(evaluateChecks(base), 'sim-latency').severity).toBe('ok');
  });
});

describe('模型链路检查', () => {
  it('未配置模型时提示去配置', () => {
    const c = find(evaluateChecks({ ...base, llmConfigured: false }), 'llm');
    expect(c.severity).toBe('warn');
    expect(c.action).toContain('模型设置');
  });

  it('降级率超过一半且样本足够时告警', () => {
    const c = find(evaluateChecks({ ...base, llmCalls: 10, llmFallbacks: 7 }), 'llm');
    expect(c.severity).toBe('warn');
    expect(c.detail).toContain('70%');
  });

  it('样本太少时不因偶发失败误报', () => {
    expect(find(evaluateChecks({ ...base, llmCalls: 2, llmFallbacks: 2 }), 'llm').severity).toBe('ok');
  });

  it('正常链路为 ok', () => {
    expect(find(evaluateChecks(base), 'llm').severity).toBe('ok');
  });
});

describe('持久化与配置检查', () => {
  it('持久化关闭时提示回放不可用', () => {
    const c = find(evaluateChecks({ ...base, persistence: 'disabled' }), 'persistence');
    expect(c.severity).toBe('warn');
    expect(c.detail).toContain('回放');
  });

  it('写入失败计数转为告警', () => {
    expect(find(evaluateChecks({ ...base, persistenceErrors: 2 }), 'persistence').severity).toBe('warn');
  });

  it('Agent 配置有归一化告警时提示查看', () => {
    const c = find(evaluateChecks({ ...base, agentWarnings: 2 }), 'agent-config');
    expect(c.severity).toBe('warn');
    expect(c.action).toContain('Agent 设置');
  });

  it('钩子失败计数转为告警', () => {
    expect(find(evaluateChecks({ ...base, hookFailures: 1 }), 'hooks').severity).toBe('warn');
  });

  it('无客户端连接时提示', () => {
    expect(find(evaluateChecks({ ...base, wsActive: 0 }), 'ws').severity).toBe('warn');
  });
});

describe('总体结论', () => {
  it('error 优先于 warn', () => {
    expect(
      overallSeverity([
        { id: 'a', label: 'a', severity: 'ok', detail: '', action: '' },
        { id: 'b', label: 'b', severity: 'warn', detail: '', action: '' },
        { id: 'c', label: 'c', severity: 'error', detail: '', action: '' },
      ]),
    ).toBe('error');
  });

  it('全 ok 时总体 ok', () => {
    const checks = evaluateChecks({ ...base, configPath: __filename });
    expect(overallSeverity(checks)).toBe('ok');
  });

  it('报告带 ISO 时间与完整检查项', () => {
    const report = buildReport(base, new Date('2026-10-26T00:00:00.000Z'));
    expect(report.at).toBe('2026-10-26T00:00:00.000Z');
    expect(report.checks.length).toBeGreaterThanOrEqual(8);
  });
});

/**
 * 进水数据源新鲜度（对标 ScadaLTS 的 no-update 事件类型）。
 *
 * 关键断言：CSV 序列走完一轮后循环复用必须报 warn，而不是静默重复
 * 一段历史剖面——这是真实部署里最容易被当成"运行正常"的失真。
 */
describe('进水数据源检查', () => {
  it('未提供数据源信息时显示内置模型', () => {
    const c = find(evaluateChecks(base), 'influent-source');
    expect(c.severity).toBe('ok');
    expect(c.detail).toContain('内置');
  });

  it('合成进水恒为 ok', () => {
    const c = find(
      evaluateChecks({
        ...base,
        influentSource: { kind: 'synthetic', name: 'synthetic', spanMin: null, cycles: 0, points: 0 },
      }),
      'influent-source',
    );
    expect(c.severity).toBe('ok');
    expect(c.detail).toContain('合成');
  });

  it('CSV 首轮未走完为 ok，并报出点数与时长', () => {
    const c = find(
      evaluateChecks({
        ...base,
        influentSource: { kind: 'csv', name: 'week.csv', spanMin: 1440, cycles: 0, points: 2880 },
      }),
      'influent-source',
    );
    expect(c.severity).toBe('ok');
    expect(c.detail).toContain('2880');
    expect(c.detail).toContain('24.0');
    expect(c.detail).toContain('有效期内');
  });

  it('CSV 已循环时为 warn，并说明后续是历史重复', () => {
    const c = find(
      evaluateChecks({
        ...base,
        influentSource: { kind: 'csv', name: 'week.csv', spanMin: 1440, cycles: 2, points: 2880 },
      }),
      'influent-source',
    );
    expect(c.severity).toBe('warn');
    expect(c.detail).toContain('循环 2 轮');
    expect(c.action).toContain('持续采集');
  });

  it('零长度序列不会算出 Infinity 或 NaN', () => {
    const c = find(
      evaluateChecks({
        ...base,
        influentSource: { kind: 'csv', name: 'empty.csv', spanMin: 0, cycles: 0, points: 1 },
      }),
      'influent-source',
    );
    expect(c.detail).not.toContain('NaN');
    expect(c.detail).not.toContain('Infinity');
  });
});
