import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildLlmGrounding,
  createLlmChat,
  errorText,
  llmBudget,
  reasonText,
  buildPidSummary,
} from '../src/server/llmChat';
import { createNetworkState, spinUpNetwork } from '../src/sim/networkEngine';
import { PLANT_TOPOLOGY } from '../src/model/topology';

/**
 * 对话增强链路。
 *
 * 这段有四个真实坑（都在注释里记为设计约束）：
 * ① 预算按 maxOutput 给会全烧在 reasoning 上；
 * ② 推理模型需要更长超时；
 * ③ 数字白名单拦下后要重试一次；
 * ④ 任何失败都必须保留规则答案且可见。
 */

const ruleAnswer = { title: '现状', body: '规则答案', bullets: [], confidence: 0.8, kind: 'status' } as never;

function makeNet() {
  const net = createNetworkState(PLANT_TOPOLOGY, { seed: 9 });
  spinUpNetwork(net, PLANT_TOPOLOGY, 30);
  return net;
}

describe('接地事实', () => {
  it('只包含已有数值，且不含控制器写权限或环境变量', () => {
    const net = makeNet();
    const g = buildLlmGrounding(net, null);
    expect(g.plant.length).toBeGreaterThan(0);
    expect(g.facts.length).toBeGreaterThan(10);
    for (const f of g.facts) {
      expect(String(f.value)).not.toMatch(/token|apiKey|process\.env/i);
    }
    expect(g.recommendation).toBeNull();
    expect(g.risks).toEqual([]);
  });

  it('有推荐时把摘要与风险带上', () => {
    const net = makeNet();
    const g = buildLlmGrounding(net, {
      summary: '建议微调',
      risks: ['风险A'],
    } as never);
    expect(g.recommendation).toBe('建议微调');
    expect(g.risks).toEqual(['风险A']);
  });

  it('最紧指标取自裕度表首项', () => {
    const net = makeNet();
    const g = buildLlmGrounding(net, null);
    const metric = g.facts.find((f) => f.label === '最紧指标');
    expect(metric).toBeDefined();
    expect(String(metric!.unit)).toMatch(/占限值/);
  });
});

describe('模型预算', () => {
  it('非推理模型按回答长度计算，并夹在 [512, 4096]', () => {
    const small = llmBudget({ capabilities: { reasoning: false } } as never, 100);
    expect(small.maxOutput).toBeGreaterThanOrEqual(512);
    const large = llmBudget({ capabilities: { reasoning: false } } as never, 5000);
    expect(large.maxOutput).toBe(4096);
    expect(large.timeoutMs).toBe(25000);
  });

  it('推理模型给足 token 与更长超时（否则正文永远为空）', () => {
    const r = llmBudget({ capabilities: { reasoning: true } } as never, 200);
    expect(r.maxOutput).toBe(4096);
    expect(r.timeoutMs).toBe(60000);
  });
});

describe('错误文案', () => {
  it('把降级原因翻成可读中文', () => {
    expect(reasonText('not-configured')).toMatch(/尚未配置/);
    expect(reasonText('timeout')).toMatch(/超时/);
    expect(reasonText('network-error')).toMatch(/无法连接/);
    expect(reasonText('empty-response')).toMatch(/没有返回/);
    expect(reasonText('ungrounded-numbers')).toMatch(/未经数据支持/);
    expect(reasonText('http-500')).toMatch(/500/);
    expect(reasonText(null)).toBe('调用失败');
  });

  it('errorText 处理非 Error 值', () => {
    expect(errorText(new Error('boom'))).toBe('boom');
    expect(errorText('plain')).toBe('请求失败');
  });
});

describe('增强链路的降级行为', () => {
  afterEach(() => vi.restoreAllMocks());

  it('未配置模型时保留规则答案且不发 chat', async () => {
    const sent: unknown[] = [];
    const enhance = createLlmChat({
      snapshot: () => ({ topology: PLANT_TOPOLOGY, net: makeNet(), recommendation: null }),
      isOpen: () => true,
      send: (_ws, m) => sent.push(m),
    });
    await enhance({} as never, '怎么样', ruleAnswer);
    // 未配置 → askLlm 返回 not-configured → 发一条 warn notice，不发 chat
    expect(sent.some((m) => (m as { type: string }).type === 'chat')).toBe(false);
    expect(sent.some((m) => (m as { type: string }).type === 'notice')).toBe(true);
  });

  it('连接已关闭时不再发送', async () => {
    const sent: unknown[] = [];
    const enhance = createLlmChat({
      snapshot: () => ({ topology: PLANT_TOPOLOGY, net: makeNet(), recommendation: null }),
      isOpen: () => false,
      send: (_ws, m) => sent.push(m),
    });
    await enhance({} as never, '怎么样', ruleAnswer);
    expect(sent).toEqual([]);
  });
});

describe('结构化 P&ID 摘要（FALCON 落地）', () => {
  it('包含主序列、单元容积与回流连线', () => {
    const pid = buildPidSummary(PLANT_TOPOLOGY);
    expect(pid).toContain('主序列:');
    // 主序列按 train 顺序出现
    expect(pid).toContain('→');
    // 单元清单带容积
    expect(pid).toMatch(/m³\)/);
    // 回流连线（RAS / 内回流 / WAS 至少其一）
    expect(/回流: .+--(return_activated_sludge|internal_recycle|waste_sludge)-->/.test(pid)).toBe(true);
    // 长度受控（上下文预算）
    expect(pid.length).toBeLessThan(1200);
  });
});
