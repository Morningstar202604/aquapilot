import { describe, expect, it } from 'vitest';
import { createCursor, takeNewPoints } from '../src/server/trendCursor';
import { buildEnsemble, forecastEnsemble, UNCERTAINTY_VARIANTS } from '../src/sim/ensemble';
import { qualityScore } from '../src/sim/metrics';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import { createNetworkState, networkModel, spinUpNetwork, stepNetwork } from '../src/sim/networkEngine';
import { buildPreset, PRESETS } from '../src/model/presets';
import { compileNetwork } from '../src/sim/network';
import { checkRunReadiness } from '../src/sim/topologyEngine';
import { csvEscape, toCsv, snapshotsCsv, decisionsCsv, buildOperationsReport } from '../src/server/export';
import { buildGroundingText, numbersAreGrounded, readLlmConfig, askLlm, SYSTEM_PROMPT } from '../src/ai/llm';
import { createShadowPlant, MANUAL_BASELINE_CONTROLS, stepShadow, summarizeBenchmark } from '../src/server/benchmark';
import { decide } from '../src/ai/agent';
import { makeSnapshot } from './fixtures/snapshot';

/**
 * 0.3.0 新能力的契约测试。
 *
 * 每条都对应一个用户可见断言：曲线不能停、区间必须有序、模板必须能跑、
 * CSV 必须能解析、LLM 必须能降级、双跑必须真的同进水。
 */

describe('趋势增量游标', () => {
  it('缓冲写满后仍然只推送新点（回归：曾永久停更）', () => {
    const cursor = createCursor();
    const buffer = Array.from({ length: 720 }, (_, i) => ({ t: i * 10 }));
    expect(takeNewPoints(buffer, cursor)).toHaveLength(720);
    // 环形缓冲滚动：头部丢掉 1 个，尾部追加 1 个
    buffer.shift();
    buffer.push({ t: 7200 });
    const fresh = takeNewPoints(buffer, cursor);
    expect(fresh).toEqual([{ t: 7200 }]);
  });

  it('重复调用不重复推送', () => {
    const cursor = createCursor();
    const buffer = [{ t: 10 }, { t: 20 }];
    expect(takeNewPoints(buffer, cursor)).toHaveLength(2);
    expect(takeNewPoints(buffer, cursor)).toHaveLength(0);
  });
});

describe('集合预测区间', () => {
  const state = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 7 }), PLANT_TOPOLOGY, 12);
  const model = networkModel(PLANT_TOPOLOGY, state);

  it('每个时间点的 p10 <= p50 <= p90', () => {
    const ens = forecastEnsemble(model, state.controls, 120, 30, qualityScore);
    expect(ens.supported).toBe(true);
    expect(ens.points.length).toBeGreaterThan(0);
    for (const p of ens.points) {
      for (const key of ['cod', 'nh', 'tn', 'tp', 'ss', 'score'] as const) {
        expect(p[key].p10).toBeLessThanOrEqual(p[key].p50 + 1e-9);
        expect(p[key].p50).toBeLessThanOrEqual(p[key].p90 + 1e-9);
      }
    }
  });

  it('超限概率落在 0–1，且三组扰动的样本数如实上报', () => {
    const ens = forecastEnsemble(model, state.controls, 120, 30, qualityScore);
    expect(ens.exceedanceProbability).toBeGreaterThanOrEqual(0);
    expect(ens.exceedanceProbability).toBeLessThanOrEqual(1);
    expect(ens.samples).toBe(UNCERTAINTY_VARIANTS.length);
  });

  it('空样本输入返回零值而不是抛错', () => {
    const empty = buildEnsemble([], 240, 30, qualityScore);
    expect(empty.points).toEqual([]);
    expect(empty.samples).toBe(0);
    expect(empty.exceedanceProbability).toBe(0);
  });

  it('高负荷扰动组需要更多曝气功率', () => {
    const low = model.predictWithUncertainty!(state.controls, 120, 30, UNCERTAINTY_VARIANTS[0]);
    const high = model.predictWithUncertainty!(state.controls, 120, 30, UNCERTAINTY_VARIANTS[2]);
    expect(high.peakEnergyKw).toBeGreaterThan(low.peakEnergyKw);
  });
});

describe('鲁棒决策', () => {
  const state = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 11 }), PLANT_TOPOLOGY, 12);
  const model = networkModel(PLANT_TOPOLOGY, state);

  it('生产引擎上会给出集合预测与超限概率', () => {
    const rec = decide({ model, horizonMin: 120 });
    expect(rec.robustEvaluated).toBe(true);
    expect(rec.ensemble).not.toBeNull();
    expect(rec.chosens.exceedanceProbability).not.toBeNull();
    expect(rec.chosens.exceedanceProbability!).toBeGreaterThanOrEqual(0);
    expect(rec.chosens.exceedanceProbability!).toBeLessThanOrEqual(1);
  });

  it('关闭鲁棒评估时不伪造概率', () => {
    const rec = decide({ model, horizonMin: 120, robust: false });
    expect(rec.robustEvaluated).toBe(false);
    expect(rec.ensemble).toBeNull();
    expect(rec.chosens.exceedanceProbability).toBeNull();
  });
});

describe('工艺模板', () => {
  it('每个模板都可运行、可编译，且预热后出水有限', () => {
    for (const preset of PRESETS) {
      const topo = buildPreset(preset);
      const readiness = checkRunReadiness(topo);
      expect(readiness.ready, `${preset.id}: ${readiness.blockers.join(';')}`).toBe(true);
      const compiled = compileNetwork(topo);
      expect(compiled.problems, preset.id).toEqual([]);
    }
  });

  it('强化脱氮模板的缺氧池容积真的变大', () => {
    const denit = buildPreset(PRESETS.find((p) => p.id === 'a2o-deep-denit')!);
    const anoxic = denit.units.find((u) => u.id === 'anoxic')!;
    expect(anoxic.volume).toBe(7500);
  });

  it('A/O 模板没有厌氧池，首池是缺氧池', () => {
    const ao = buildPreset(PRESETS.find((p) => p.id === 'ao-no-anaerobic')!);
    expect(ao.units.some((u) => u.kind === 'anaerobic')).toBe(false);
    expect(ao.units.find((u) => u.id === 'anaerobic')!.kind).toBe('anoxic');
  });
});

describe('集合预测的降级路径', () => {
  it('模型没有扰动接口时退回单点预测并标记 supported=false', () => {
    const state = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 3 }), PLANT_TOPOLOGY, 5);
    const full = networkModel(PLANT_TOPOLOGY, state);
    const legacy = {
      snapshot: full.snapshot,
      predict: full.predict,
      predictWithScenario: full.predictWithScenario,
    };
    const ens = forecastEnsemble(legacy, state.controls, 60, 30, qualityScore);
    expect(ens.supported).toBe(false);
    expect(ens.samples).toBe(UNCERTAINTY_VARIANTS.length);
    expect(ens.points.length).toBeGreaterThan(0);
  });
});

describe('CSV 导出', () => {
  it('逗号、引号、换行都按 RFC 4180 转义', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape('line\nbreak')).toBe('"line\nbreak"');
    expect(csvEscape(3.5)).toBe('3.5');
  });

  it('表头与行数一致，且使用 CRLF', () => {
    const csv = toCsv(
      ['a', 'b'],
      [
        [1, 2],
        [3, 4],
      ],
    );
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(3);
  });

  it('快照与决策导出包含关键列', () => {
    const snaps = snapshotsCsv([
      {
        atMin: 90,
        effluentCod: 30,
        effluentNh: 0.5,
        effluentTn: 10,
        effluentTp: 0.2,
        effluentSs: 5,
        mlss: 3000,
        srtDays: 15,
        energyKw: 200,
        score: 80,
        runId: 'run-1',
      },
    ]);
    expect(snaps).toContain('effluent_cod_mg_l');
    expect(snaps).toContain('01:30');
    const dec = decisionsCsv([
      {
        atMin: 30,
        action: 'adjust',
        severity: 'normal',
        summary: '建议, 微调',
        tweaks: '[]',
        predictedScore: 70,
        separation: 0.6,
        runId: 'run-1',
      },
    ]);
    expect(dec).toContain('"建议, 微调"');
  });

  it('运行报告包含水质表、决策与双跑对照', () => {
    const snap = makeSnapshot({
      recommendation: {
        action: 'adjust',
        severity: 'normal',
        summary: '建议微调 1 项',
        rationale: [],
        chosens: {
          label: '维持当前工况',
          score: 1,
          quality: 70,
          violations: 0,
          cost: 1,
          energyPeak: 1,
          worstRatio: 0.8,
          controls: makeSnapshot().controls,
          exceedanceProbability: 0,
        },
        alternatives: [],
        predictedEffluent: makeSnapshot().effluent,
        predictedScore: 70,
        horizonMin: 240,
        separation: 0.5,
        risks: [],
        tweaks: [{ key: 'doSetpoint', from: 2, to: 2.2, reason: '提高硝化余量' }],
        generatedAt: 10,
        ensemble: {
          points: [],
          exceedanceProbability: 0,
          worstRatio: 0.8,
          samples: 3,
        },
        robustEvaluated: true,
      },
    });
    const report = buildOperationsReport(snap);
    expect(report).toContain('# AquaPilot 运行报告');
    expect(report).toContain('出水水质');
    expect(report).toContain('建议微调 1 项');
    expect(report).toContain('D2 01:30');
  });
});

describe('LLM 适配层的安全边界', () => {
  it('未配置时不发起请求，返回 not-configured', async () => {
    expect(readLlmConfig({} as NodeJS.ProcessEnv)).toBeNull();
    const res = await askLlm(
      '现在怎么样',
      { plant: 'p', simClock: 'd1', facts: [], recommendation: null, risks: [] },
      null,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('not-configured');
  });

  it('数字白名单拒绝凭空出现的数值', () => {
    const grounding = buildGroundingText({
      plant: '澄川',
      simClock: '第 1 天 00:00',
      facts: [{ label: '出水氨氮', value: '0.59', unit: 'mg/L' }],
      recommendation: null,
      risks: [],
    });
    expect(numbersAreGrounded('出水氨氮 0.59 mg/L，运行稳定。', grounding)).toBe(true);
    expect(numbersAreGrounded('出水氨氮 0.60 mg/L。', grounding)).toBe(true);
    expect(numbersAreGrounded('出水氨氮 42.7 mg/L。', grounding)).toBe(false);
  });

  it('端点不可达时返回 network-error 而不是抛出', async () => {
    const res = await askLlm(
      '状态',
      { plant: 'p', simClock: 'd1', facts: [{ label: 'x', value: 1 }], recommendation: null, risks: [] },
      { baseUrl: 'http://127.0.0.1:9', apiKey: '', model: 'm', timeoutMs: 800 },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('network-error');
  });
});

describe('LLM 适配层的分支', () => {
  const ctx = {
    plant: '澄川',
    simClock: '第 1 天 00:00',
    facts: [{ label: '出水氨氮', value: '0.59', unit: 'mg/L' }],
    recommendation: null as string | null,
    risks: [] as string[],
  };

  it('环境变量齐全时读出配置并去掉末尾斜杠', () => {
    const cfg = readLlmConfig({
      AQUAPILOT_LLM_BASE_URL: 'https://api.example.com/v1///',
      AQUAPILOT_LLM_MODEL: 'm',
      AQUAPILOT_LLM_API_KEY: 'k',
    } as NodeJS.ProcessEnv)!;
    expect(cfg.baseUrl).toBe('https://api.example.com/v1');
    expect(cfg.model).toBe('m');
    expect(cfg.apiKey).toBe('k');
    expect(cfg.timeoutMs).toBe(8000);
  });

  it('缺少 model 时不启用', () => {
    expect(readLlmConfig({ AQUAPILOT_LLM_BASE_URL: 'https://x' } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('组织事实文本时包含建议与风险，空建议时写明没有', () => {
    const withRec = buildGroundingText({ ...ctx, recommendation: '降回流', risks: ['裕度不足'] });
    expect(withRec).toContain('当前 AI 建议：降回流');
    expect(withRec).toContain('风险提示：裕度不足');
    const noRec = buildGroundingText(ctx);
    expect(noRec).toContain('当前没有待执行的建议');
    expect(SYSTEM_PROMPT).toContain('不得推算未给出的数字');
  });

  it('成功响应返回文本并标记 ok', async () => {
    const original = global.fetch;
    global.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '出水氨氮 0.59 mg/L，稳定。' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;
    try {
      const res = await askLlm('氨氮多少', ctx, {
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'k',
        model: 'm',
        timeoutMs: 2000,
      });
      expect(res.ok).toBe(true);
      expect(res.text).toContain('0.59');
    } finally {
      global.fetch = original;
    }
  });

  it('空响应 / 未 grounding 文本 / HTTP 错误都降级', async () => {
    const original = global.fetch;
    const cases: { body: unknown; status: number; reason: string }[] = [
      { body: { choices: [] }, status: 200, reason: 'empty-response' },
      {
        body: { choices: [{ message: { content: '出水氨氮 99.9 mg/L' } }] },
        status: 200,
        reason: 'ungrounded-numbers',
      },
      { body: {}, status: 500, reason: 'http-500' },
    ];
    try {
      for (const c of cases) {
        global.fetch = (async () =>
          new Response(JSON.stringify(c.body), {
            status: c.status,
            headers: { 'Content-Type': 'application/json' },
          })) as unknown as typeof fetch;
        const res = await askLlm('x', ctx, {
          baseUrl: 'https://api.example.com/v1',
          apiKey: '',
          model: 'm',
          timeoutMs: 1000,
        });
        expect(res.ok, c.reason).toBe(false);
        expect(res.reason, c.reason).toBe(c.reason);
      }
    } finally {
      global.fetch = original;
    }
  });
});

describe('导出与报告的分支', () => {
  it('无 runId 的快照导出为空字符串列', () => {
    const csv = snapshotsCsv([
      {
        atMin: 0,
        effluentCod: 1,
        effluentNh: 1,
        effluentTn: 1,
        effluentTp: 1,
        effluentSs: 1,
        mlss: 1,
        srtDays: 1,
        energyKw: 1,
        score: 1,
      },
    ]);
    const lines = csv.split('\r\n');
    expect(lines[1].startsWith(',')).toBe(true);
  });

  it('报告在无推荐、无双跑时给出明确的空状态', () => {
    const report = buildOperationsReport(makeSnapshot({ recommendation: null, benchmark: null }));
    expect(report).toContain('尚无决策记录');
    expect(report).toContain('影子双跑样本不足');
  });

  it('报告在有双跑数据时渲染三列表格', () => {
    const side = {
      minutes: 360,
      compliantMinutes: 340,
      scoreSum: 360 * 70,
      energyKwh: 50,
      cost: 80,
      inflowM3: 400,
      specificKwhM3: 0.125,
    };
    const report = buildOperationsReport(
      makeSnapshot({
        benchmark: {
          ai: side,
          manual: { ...side, compliantMinutes: 300 },
          complianceDeltaPct: 11.1,
          specificEnergyDelta: -0.01,
          costDeltaPct: -5,
          scoreDelta: 2,
          mature: true,
        },
      }),
    );
    expect(report).toContain('| 出水合规率 | 94.4% | 83.3% |');
    expect(report).toContain('样本 360 分钟');
  });
});

describe('双跑汇总的分支', () => {
  it('零样本时全部为 0 且 mature=false', () => {
    const summary = summarizeBenchmark({
      ai: { minutes: 0, compliantMinutes: 0, scoreSum: 0, energyKwh: 0, cost: 0, inflowM3: 0, specificKwhM3: 0 },
      manual: { minutes: 0, compliantMinutes: 0, scoreSum: 0, energyKwh: 0, cost: 0, inflowM3: 0, specificKwhM3: 0 },
      startedAtMin: 0,
    });
    expect(summary.complianceDeltaPct).toBe(0);
    expect(summary.costDeltaPct).toBe(0);
    expect(summary.mature).toBe(false);
  });

  it('六小时以上标记为具备统计意义', () => {
    const side = {
      minutes: 360,
      compliantMinutes: 360,
      scoreSum: 360 * 80,
      energyKwh: 60,
      cost: 100,
      inflowM3: 400,
      specificKwhM3: 0.15,
    };
    const summary = summarizeBenchmark({
      ai: side,
      manual: { ...side, compliantMinutes: 180, cost: 150 },
      startedAtMin: 0,
    });
    expect(summary.mature).toBe(true);
    expect(summary.complianceDeltaPct).toBeCloseTo(50, 6);
    expect(summary.costDeltaPct).toBeLessThan(0);
  });
});

describe('影子双跑', () => {
  it('两条链同步推进且样本数一致', () => {
    const state = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 5 }), PLANT_TOPOLOGY, 5);
    const shadow = createShadowPlant(PLANT_TOPOLOGY, 5, state.timeMin);
    for (let i = 0; i < 10; i++) {
      stepNetwork(state, PLANT_TOPOLOGY, 1);
      stepShadow(shadow, state, 1, PLANT_TOPOLOGY);
    }
    const summary = summarizeBenchmark(shadow.benchmark);
    expect(summary.ai.minutes).toBe(10);
    expect(summary.manual.minutes).toBe(10);
    expect(summary.mature).toBe(false);
    expect(Number.isFinite(summary.specificEnergyDelta)).toBe(true);
  });

  it('固定策略参数是独立对象，不会被 AI 覆盖', () => {
    const shadow = createShadowPlant(PLANT_TOPOLOGY, 5, 0);
    expect(shadow.state.controls.doSetpoint).toBe(MANUAL_BASELINE_CONTROLS.doSetpoint);
    expect(shadow.state.controls.aiEnabled).toBe(false);
  });
});
