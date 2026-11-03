import { describe, expect, it } from 'vitest';
import { answer, candidateLabel } from '../src/ai/agent';
import { PLANT_TOPOLOGY, type ProcessTopology } from '../src/model/topology';
import { validateTopology } from '../src/model/topology';
import { reasoningFields } from '../src/ai/providers';
import { createNetworkState, networkModel, spinUpNetwork } from '../src/sim/networkEngine';
import type { ForecastOutcomeX } from '../src/sim/plantModel';

/**
 * 全量代码审查（2026-11-03）锁定的 AI/模型层缺陷回归：
 * 1. candidateLabel 幅度档位解析错误 → 所有候选都标「（大幅）」，
 *    备选去重吞掉小幅候选、鲁棒预测带按 label 互相覆盖；
 * 2. recycle:true 绕过环路检测 → 校验放行的拓扑让 resolveFlows 崩溃；
 * 3. what-if 预测 NaN 时 reduce 停在初始值 → 数值发散被报成「不会超标」。
 */

describe('candidateLabel 幅度档位', () => {
  it('同一方向的小幅与大幅标签不同（去重不再吞候选）', () => {
    expect(candidateLabel('doSetpoint+0')).not.toContain('（大幅）');
    expect(candidateLabel('doSetpoint+1')).toContain('（大幅）');
    expect(candidateLabel('doSetpoint-0')).not.toContain('（大幅）');
    expect(candidateLabel('doSetpoint-1')).toContain('（大幅）');
  });

  it('小幅与大幅语义一致：只差档位后缀', () => {
    expect(candidateLabel('internalRecirc+1')).toBe(`${candidateLabel('internalRecirc+0')}（大幅）`);
  });
});

describe('环路检测不可被 recycle 标志绕过', () => {
  const unit = (id: string) => structuredClone(PLANT_TOPOLOGY.units.find((u) => u.id === id)!);
  const edge = (from: string, to: string) =>
    structuredClone(PLANT_TOPOLOGY.connections.find((c) => c.from.unit === from && c.to.unit === to)!);

  it('普通物流边标 recycle:true 后构成的环路仍被拒（CYCLE）', () => {
    const topo: ProcessTopology = {
      ...structuredClone(PLANT_TOPOLOGY),
      name: '环路攻击样例',
      units: [unit('inlet'), unit('screening'), unit('grit')],
      train: ['screening', 'grit'],
      connections: [
        edge('inlet', 'screening'),
        edge('screening', 'grit'),
        // 把回边伪装成"回流"：物流仍是普通 influent，仅 recycle 标志为 true
        {
          ...edge('screening', 'grit'),
          id: 'c-back',
          from: edge('screening', 'grit').to,
          to: edge('inlet', 'screening').from,
          recycle: true,
        },
      ],
    };
    const issues = validateTopology(topo);
    expect(issues.some((i) => i.code === 'CYCLE')).toBe(true);
  });
});

describe('what-if 数值发散不做假平安', () => {
  const base = () =>
    networkModel(PLANT_TOPOLOGY, spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 9 }), PLANT_TOPOLOGY, 5));

  it('预测轨迹全 NaN 时明确报告发散，而不是「不会突破限值」', () => {
    const real = base();
    const nanPoints: ForecastOutcomeX['points'] = [
      {
        minute: 30,
        effluent: {
          flow: 2000,
          cod: Number.NaN,
          bod: Number.NaN,
          ss: Number.NaN,
          nh: Number.NaN,
          tn: Number.NaN,
          tp: Number.NaN,
          ph: 7,
          temperature: 18,
        },
        doLevel: 2,
        blanket: 1,
        score: Number.NaN,
        energyKw: 300,
      },
    ];
    const broken = {
      ...real,
      predictWithScenario: () => ({ points: nanPoints, violations: [] }),
      predict: () => ({ points: nanPoints, violations: [] }),
    } as unknown as typeof real;
    const a = answer('如果发生暴雨会怎样', broken, null);
    expect(a.body).toContain('发散');
    expect(a.body).not.toContain('不会突破');
  });
});

describe('推理档位字段下发', () => {
  it('OpenAI 兼容端 off 不携带 reasoning_effort（假关闭修复）', () => {
    const off = reasoningFields('openai', 'off');
    expect(off.enable_thinking).toBe(false);
    expect('reasoning_effort' in off).toBe(false);
  });

  it('low 档仍下发低档思考', () => {
    const low = reasoningFields('openai', 'low');
    expect(low.reasoning_effort).toBe('low');
    expect(low.enable_thinking).toBe(true);
  });
});
