import { describe, expect, it } from 'vitest';
import { handleMcpRequest, type McpFacade, type McpExperimentApi, type McpStudyApi } from '../src/server/mcp';
import { PLANT_TOPOLOGY } from '../src/model/topology';

/**
 * MCP 工具矩阵：每个工具的「服务未接、参数缺失、业务失败、成功」四条路径。
 *
 * 此前测试只覆盖了六个基础工具，实验/研究工具的错误与可选服务分支
 * 从未执行；这里用假门面锁住 MCP 与队列服务的契约。
 */

const experimentRecord = { id: 'exp_1', status: 'queued', spec: { durationMin: 60 } };
const studyRecord = { id: 'study_1', status: 'running', variants: [] };

const experiments: McpExperimentApi = {
  create: (input) => ({ ok: true, record: { ...experimentRecord, input } }),
  get: (id) => (id === 'exp_1' ? experimentRecord : null),
  list: (status, limit) => [{ status, limit }],
  cancel: (id) =>
    id === 'exp_1' ? { ok: true, record: { id, status: 'cancelled' } } : { ok: false, error: 'not found' },
};

const studies: McpStudyApi = {
  create: (input) => ({ ok: true, record: { ...studyRecord, input } }),
  get: (id) => (id === 'study_1' ? studyRecord : null),
  list: (limit) => [{ limit }],
  cancel: (id) => (id === 'study_1' ? { ok: true, record: { id, status: 'cancelled' } } : { ok: false, error: 'nope' }),
  report: (id) => (id === 'study_1' ? '# report' : null),
};

const base: McpFacade = {
  serverVersion: '0.0.0-test',
  getTopology: () => PLANT_TOPOLOGY,
  getState: () => ({ timeMin: 0 }),
  setControl: (patch) => ({ ok: true, clamped: Object.keys(patch) }),
  startScenario: () => ({ ok: true }),
  clearScenario: () => ({ ok: true }),
  resetSim: () => ({ ok: true }),
  applyRecommendation: () => ({ ok: true }),
  getMetrics: () => '# metrics',
  getReport: () => '# report',
  getScorecard: () => ({ total: 88 }),
  experiments,
  studies,
};

const rpc = (id: number, name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});

function call(name: string, args: Record<string, unknown> = {}, facade: McpFacade = base, id = 1) {
  return handleMcpRequest({
    httpMethod: 'POST',
    origin: null,
    host: 'localhost',
    protocolVersionHeader: null,
    body: rpc(id, name, args),
    facade,
  });
}

function toolResult(out: ReturnType<typeof call>): {
  content: { text: string }[];
  isError?: true;
  structuredContent?: Record<string, unknown>;
} {
  return (out.body as { result: never }).result as never;
}

describe('MCP 基础工具的分支', () => {
  it('set_control 覆盖空补丁、非有限数、业务拒绝三条错误', () => {
    expect(toolResult(call('set_control')).isError).toBe(true);
    expect(toolResult(call('set_control', { doSetpoint: 'x' })).content[0].text).toContain('finite number');
    const denied = call(
      'set_control',
      { doSetpoint: 1 },
      { ...base, setControl: () => ({ ok: false, error: 'locked' }) },
    );
    expect(toolResult(denied).isError).toBe(true);
    expect(toolResult(denied).content[0].text).toBe('locked');
  });

  it('start_scenario 覆盖未知场景与业务拒绝', () => {
    expect(toolResult(call('start_scenario', { scenario: 'meteor' })).content[0].text).toContain('Unknown scenario');
    const denied = call(
      'start_scenario',
      { scenario: 'storm' },
      {
        ...base,
        startScenario: () => ({ ok: false, error: 'busy' }),
      },
    );
    expect(toolResult(denied).content[0].text).toBe('busy');
  });

  it('apply_recommendation 无建议时是业务错误', () => {
    const out = call('apply_recommendation', {}, { ...base, applyRecommendation: () => ({ ok: false }) });
    expect(toolResult(out).isError).toBe(true);
    expect(toolResult(out).content[0].text).toContain('recommendation');
  });

  it('simulate_headless 覆盖 controls 非对象、未知控制量、非数字、未知场景', () => {
    expect(toolResult(call('simulate_headless', { durationMin: 30, controls: [] })).content[0].text).toContain(
      'controls must be an object',
    );
    expect(toolResult(call('simulate_headless', { durationMin: 30, controls: { nope: 1 } })).content[0].text).toContain(
      'Unknown control',
    );
    expect(
      toolResult(call('simulate_headless', { durationMin: 30, controls: { doSetpoint: 'x' } })).content[0].text,
    ).toContain('finite number');
    expect(toolResult(call('simulate_headless', { durationMin: 30, scenario: 'meteor' })).isError).toBe(true);
  });

  it('simulate_headless 拓扑异常时回 isError 而不是抛出', () => {
    const out = call(
      'simulate_headless',
      { durationMin: 30 },
      {
        ...base,
        getTopology: () => {
          throw new Error('no topology');
        },
      },
    );
    expect(toolResult(out).isError).toBe(true);
    expect(toolResult(out).content[0].text).toContain('Simulation failed');
  });

  it('clear/reset/scorecard/report/metrics 正常返回', () => {
    expect(toolResult(call('clear_scenario')).content[0].text).toContain('ok');
    expect(toolResult(call('reset_sim')).content[0].text).toContain('ok');
    expect(toolResult(call('get_scorecard')).structuredContent).toMatchObject({ total: 88 });
    expect(toolResult(call('get_report')).content[0].text).toBe('# report');
    expect(toolResult(call('get_metrics')).content[0].text).toBe('# metrics');
  });
});

describe('MCP 实验工具', () => {
  it('实验服务未接线时四个工具都回 isError', () => {
    const noExp = { ...base, experiments: undefined };
    for (const name of ['create_experiment', 'get_experiment', 'list_experiments', 'cancel_experiment']) {
      const out = call(name, name === 'create_experiment' ? { durationMin: 60 } : { id: 'exp_1' }, noExp);
      expect(toolResult(out).isError, name).toBe(true);
      expect(toolResult(out).content[0].text).toContain('not wired');
    }
  });

  it('create_experiment 成功与业务失败', () => {
    const ok = call('create_experiment', { durationMin: 60 });
    expect(toolResult(ok).structuredContent).toMatchObject({ id: 'exp_1' });
    const bad = call(
      'create_experiment',
      { durationMin: 60 },
      {
        ...base,
        experiments: { ...experiments, create: () => ({ ok: false, error: 'queue full' }) },
      },
    );
    expect(toolResult(bad).content[0].text).toBe('queue full');
  });

  it('get_experiment 覆盖缺 id 与不存在', () => {
    expect(toolResult(call('get_experiment', { id: '  ' })).content[0].text).toBe('id is required');
    expect(toolResult(call('get_experiment', { id: 'missing' })).content[0].text).toContain('not found');
    expect(toolResult(call('get_experiment', { id: 'exp_1' })).structuredContent).toMatchObject({ id: 'exp_1' });
  });

  it('list_experiments 的 status/limit 默认与夹取', () => {
    expect(toolResult(call('list_experiments')).structuredContent).toMatchObject([{ status: 'all', limit: 20 }]);
    expect(toolResult(call('list_experiments', { status: 'failed', limit: 0 })).structuredContent).toMatchObject([
      { status: 'failed', limit: 1 },
    ]);
    expect(toolResult(call('list_experiments', { limit: 999 })).structuredContent).toMatchObject([{ limit: 100 }]);
  });

  it('cancel_experiment 覆盖缺 id、业务失败、成功', () => {
    expect(toolResult(call('cancel_experiment', {})).content[0].text).toBe('id is required');
    expect(toolResult(call('cancel_experiment', { id: 'missing' })).isError).toBe(true);
    expect(toolResult(call('cancel_experiment', { id: 'exp_1' })).structuredContent).toMatchObject({
      status: 'cancelled',
    });
  });
});

describe('MCP 研究工具', () => {
  it('研究服务未接线时五个工具都回 isError', () => {
    const noStudy = { ...base, studies: undefined };
    const cases: [string, Record<string, unknown>][] = [
      ['create_study', { base: {}, variants: [], objectives: [] }],
      ['get_study', { id: 'study_1' }],
      ['list_studies', {}],
      ['cancel_study', { id: 'study_1' }],
      ['get_study_report', { id: 'study_1' }],
    ];
    for (const [name, args] of cases) {
      expect(toolResult(call(name, args, noStudy)).content[0].text, name).toContain('not wired');
    }
  });

  it('create_study 成功与业务失败', () => {
    expect(
      toolResult(call('create_study', { base: {}, variants: [], objectives: [] })).structuredContent,
    ).toMatchObject({ id: 'study_1' });
    const bad = call(
      'create_study',
      { base: {}, variants: [], objectives: [] },
      {
        ...base,
        studies: { ...studies, create: () => ({ ok: false, error: 'too many variants' }) },
      },
    );
    expect(toolResult(bad).content[0].text).toBe('too many variants');
  });

  it('get_study 覆盖缺 id 与不存在', () => {
    expect(toolResult(call('get_study', {})).content[0].text).toBe('id is required');
    expect(toolResult(call('get_study', { id: 'missing' })).content[0].text).toContain('Study not found');
    expect(toolResult(call('get_study', { id: 'study_1' })).structuredContent).toMatchObject({ id: 'study_1' });
  });

  it('list_studies 默认 20、上限 100、下限 1', () => {
    expect(toolResult(call('list_studies')).structuredContent).toMatchObject([{ limit: 20 }]);
    expect(toolResult(call('list_studies', { limit: 0 })).structuredContent).toMatchObject([{ limit: 1 }]);
    expect(toolResult(call('list_studies', { limit: 999 })).structuredContent).toMatchObject([{ limit: 100 }]);
  });

  it('cancel_study 覆盖缺 id、业务失败、成功', () => {
    expect(toolResult(call('cancel_study', {})).content[0].text).toBe('id is required');
    expect(toolResult(call('cancel_study', { id: 'missing' })).content[0].text).toBe('nope');
    expect(toolResult(call('cancel_study', { id: 'study_1' })).structuredContent).toMatchObject({
      status: 'cancelled',
    });
  });

  it('get_study_report 覆盖缺 id、不存在、成功', () => {
    expect(toolResult(call('get_study_report', {})).content[0].text).toBe('id is required');
    expect(toolResult(call('get_study_report', { id: 'missing' })).content[0].text).toContain('Study not found');
    expect(toolResult(call('get_study_report', { id: 'study_1' })).content[0].text).toBe('# report');
  });
});
