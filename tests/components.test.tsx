// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DecisionPanel } from '../src/client/components/DecisionPanel';
import { AlarmsPanel } from '../src/client/components/AlarmsPanel';
import { ControlPanel } from '../src/client/components/ControlPanel';
import { InsightsPanel } from '../src/client/components/InsightsPanel';
import { ChatPanel } from '../src/client/components/ChatPanel';
import { makeSnapshot } from './fixtures/snapshot';
import type { Recommendation } from '../src/ai/agent';

/**
 * 组件级测试。
 *
 * 关注三件事，不测样式细节：
 * 1. 关键数值/文案是否真的渲染出来（防止"数据没接上"）
 * 2. 交互回调是否带着正确的参数触发（防止"按钮接错线"）
 * 3. 空/异常状态是否有可读提示（防止白屏）
 */

afterEach(cleanup);

const recommendation: Recommendation = {
  action: 'adjust',
  severity: 'normal',
  summary: '建议微调 1 项：内回流比 2.0→1.6。',
  rationale: ['当前出水最紧约束为 SS：8.20 / 10 mg/L（占限值 82%）。'],
  chosens: {
    label: '降低内回流比',
    score: 600,
    quality: 72,
    violations: 0,
    cost: 1200,
    energyPeak: 300,
    worstRatio: 0.82,
    controls: { ...makeSnapshot().controls, internalRecirc: 1.6 },
    exceedanceProbability: null,
  },
  alternatives: [],
  predictedEffluent: makeSnapshot().effluent,
  predictedScore: 72,
  horizonMin: 240,
  separation: 0.66,
  risks: ['当前无高风险项，维持 15 分钟级滚动复核'],
  tweaks: [{ key: 'internalRecirc', from: 2, to: 1.6, reason: '减少缺氧区溶解氧冲击并节电' }],
  generatedAt: 90,
  ensemble: null,
  robustEvaluated: false,
};

describe('DecisionPanel', () => {
  it('渲染推荐摘要、微调项与预测值', () => {
    const onApply = vi.fn();
    const onRefresh = vi.fn();
    render(
      <DecisionPanel
        snap={makeSnapshot()}
        rec={recommendation}
        onApply={onApply}
        onRefresh={onRefresh}
        aiEnabled={false}
        onToggleAi={vi.fn()}
      />,
    );
    expect(screen.getByText(/建议微调 1 项/)).toBeTruthy();
    expect(screen.getByText(/减少缺氧区溶解氧冲击并节电/)).toBeTruthy();
    expect(screen.getByText('72/100')).toBeTruthy();
    expect(screen.getByText(/66%/)).toBeTruthy();
  });

  it('建议模式下点击"采纳建议"触发回调', () => {
    const onApply = vi.fn();
    render(
      <DecisionPanel
        snap={makeSnapshot()}
        rec={recommendation}
        onApply={onApply}
        onRefresh={vi.fn()}
        aiEnabled={false}
        onToggleAi={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '采纳建议' }));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('AI 值守且动作为 hold 时执行按钮不可点', () => {
    render(
      <DecisionPanel
        snap={makeSnapshot()}
        rec={{ ...recommendation, action: 'hold' }}
        onApply={vi.fn()}
        onRefresh={vi.fn()}
        aiEnabled
        onToggleAi={vi.fn()}
      />,
    );
    const btn = screen.getByRole('button', { name: 'AI 已自动执行' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('没有推荐时给出等待提示而不是空白', () => {
    render(
      <DecisionPanel
        snap={makeSnapshot()}
        rec={null}
        onApply={vi.fn()}
        onRefresh={vi.fn()}
        aiEnabled
        onToggleAi={vi.fn()}
      />,
    );
    expect(screen.getByText(/正在生成第一个决策周期/)).toBeTruthy();
  });

  it('切换 AI 值守模式会传出反转后的值', () => {
    const onToggleAi = vi.fn();
    render(
      <DecisionPanel
        snap={makeSnapshot()}
        rec={recommendation}
        onApply={vi.fn()}
        onRefresh={vi.fn()}
        aiEnabled
        onToggleAi={onToggleAi}
      />,
    );
    const toggle = screen.getAllByRole('button', { name: /自动执行/ }).at(-1)!;
    fireEvent.click(toggle);
    expect(onToggleAi).toHaveBeenCalledWith(false);
  });
});

describe('DecisionPanel 不确定性', () => {
  it('有集合预测时展示超限概率与区间，并声明口径', () => {
    const rec: Recommendation = {
      ...recommendation,
      robustEvaluated: true,
      ensemble: {
        points: [
          {
            minute: 240,
            cod: { p10: 30, p50: 35, p90: 42 },
            nh: { p10: 0.4, p50: 0.6, p90: 0.9 },
            tn: { p10: 10, p50: 12, p90: 14 },
            tp: { p10: 0.1, p50: 0.2, p90: 0.3 },
            ss: { p10: 5, p50: 7, p90: 9 },
            score: { p10: 60, p50: 70, p90: 80 },
          },
        ],
        exceedanceProbability: 0.33,
        worstRatio: 0.95,
        samples: 3,
      },
    };
    render(
      <DecisionPanel
        snap={makeSnapshot()}
        rec={rec}
        onApply={vi.fn()}
        onRefresh={vi.fn()}
        aiEnabled={false}
        onToggleAi={vi.fn()}
      />,
    );
    expect(screen.getByText('33%')).toBeTruthy();
    expect(screen.getByText('3 样本')).toBeTruthy();
    expect(screen.getAllByText(/0\.40 – 0\.90/).length).toBeGreaterThan(0);
    expect(screen.getByText(/不是统计置信区间/)).toBeTruthy();
  });

  it('未评估时明确说未提供，而不是显示 0%', () => {
    render(
      <DecisionPanel
        snap={makeSnapshot()}
        rec={{ ...recommendation, robustEvaluated: false, ensemble: null }}
        onApply={vi.fn()}
        onRefresh={vi.fn()}
        aiEnabled={false}
        onToggleAi={vi.fn()}
      />,
    );
    expect(screen.getByText(/未提供不确定性评估/)).toBeTruthy();
    expect(screen.queryByText('0%')).toBeNull();
  });
});

describe('InsightsPanel 双跑', () => {
  it('渲染 AI 与固定策略三列与样本提示', () => {
    render(
      <InsightsPanel
        snap={makeSnapshot({
          benchmark: {
            ai: {
              minutes: 600,
              compliantMinutes: 580,
              scoreSum: 48000,
              energyKwh: 120,
              cost: 3000,
              inflowM3: 800,
              specificKwhM3: 0.15,
            },
            manual: {
              minutes: 600,
              compliantMinutes: 500,
              scoreSum: 42000,
              energyKwh: 130,
              cost: 3600,
              inflowM3: 800,
              specificKwhM3: 0.1625,
            },
            complianceDeltaPct: 13.3,
            specificEnergyDelta: -0.0125,
            costDeltaPct: -16.7,
            scoreDelta: 10,
            mature: true,
          },
        })}
        aiEnabled
      />,
    );
    expect(screen.getByText('出水合规率')).toBeTruthy();
    expect(screen.getByText('96.7%')).toBeTruthy();
    expect(screen.getByText('83.3%')).toBeTruthy();
    expect(screen.getByText(/已具备统计意义/)).toBeTruthy();
  });
});

describe('AlarmsPanel', () => {
  it('无告警时两个分区都给出明确说明', () => {
    render(<AlarmsPanel snap={makeSnapshot()} />);
    expect(screen.getByText(/全部受控指标在限值内/)).toBeTruthy();
    expect(screen.getByText(/尚未触发告警/)).toBeTruthy();
  });

  it('活跃告警按严重程度渲染', () => {
    render(
      <AlarmsPanel
        snap={makeSnapshot({
          activeAlarms: [
            { id: 'L1', at: 100, severity: 'critical', code: 'EFF_NH', message: '出水氨氮 6.10 mg/L 超限' },
            { id: 'L2', at: 110, severity: 'warning', code: 'EFF_SS', message: '出水悬浮物 11.0 mg/L 超限' },
          ],
        })}
      />,
    );
    expect(screen.getByText('严重')).toBeTruthy();
    expect(screen.getByText('预警')).toBeTruthy();
    expect(screen.getByText(/6.10 mg\/L 超限/)).toBeTruthy();
  });
});

describe('ControlPanel', () => {
  it('渲染全部控制回路', () => {
    render(
      <ControlPanel
        snap={makeSnapshot()}
        onChange={vi.fn()}
        onStartScenario={vi.fn()}
        onClearScenario={vi.fn()}
        onApplyPreset={vi.fn()}
        aiEnabled
      />,
    );
    expect(screen.getByText('好氧区溶解氧设定')).toBeTruthy();
    expect(screen.getByText('内回流比')).toBeTruthy();
    expect(screen.getByText('剩余污泥排放')).toBeTruthy();
  });

  it('拖动滑块传出该回路的新值', () => {
    const onChange = vi.fn();
    render(
      <ControlPanel
        snap={makeSnapshot()}
        onChange={onChange}
        onStartScenario={vi.fn()}
        onClearScenario={vi.fn()}
        onApplyPreset={vi.fn()}
        aiEnabled
      />,
    );
    const slider = document.getElementById('ctl-doSetpoint') as HTMLInputElement;
    fireEvent.change(slider, { target: { value: '3.2' } });
    expect(onChange).toHaveBeenCalledWith({ doSetpoint: 3.2 });
  });

  it('点击场景卡片启动对应工况', () => {
    const onStartScenario = vi.fn();
    render(
      <ControlPanel
        snap={makeSnapshot()}
        onChange={vi.fn()}
        onStartScenario={onStartScenario}
        onClearScenario={vi.fn()}
        onApplyPreset={vi.fn()}
        aiEnabled
      />,
    );
    fireEvent.click(screen.getByText('暴雨冲击'));
    expect(onStartScenario).toHaveBeenCalledWith('storm');
  });

  it('有活动场景时提供解除入口', () => {
    const onClearScenario = vi.fn();
    render(
      <ControlPanel
        snap={makeSnapshot({
          scenario: { type: 'storm', startedAt: 100, durationMin: 360, magnitude: 1 },
        })}
        onChange={vi.fn()}
        onStartScenario={vi.fn()}
        onClearScenario={onClearScenario}
        onApplyPreset={vi.fn()}
        aiEnabled
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /清除场景/ }));
    expect(onClearScenario).toHaveBeenCalled();
  });
});

describe('InsightsPanel', () => {
  it('展示吨水电耗与基准对比', () => {
    render(<InsightsPanel snap={makeSnapshot()} aiEnabled />);
    expect(screen.getByText('吨水电耗')).toBeTruthy();
    expect(screen.getByText('AI 自动执行')).toBeTruthy();
    expect(screen.getByText(/基准 0\.245/)).toBeTruthy();
  });

  it('合规状态跟随最紧指标变化', () => {
    const tight = makeSnapshot({ margins: [{ metric: 'SS', ratio: 0.9, value: 9, limit: 10 }] });
    const { rerender } = render(<InsightsPanel snap={tight} aiEnabled />);
    expect(screen.getByText('裕度不足')).toBeTruthy();
    rerender(
      <InsightsPanel snap={makeSnapshot({ margins: [{ metric: 'SS', ratio: 0.4, value: 4, limit: 10 }] })} aiEnabled />,
    );
    expect(screen.getByText('裕度充足')).toBeTruthy();
  });
});

describe('ChatPanel', () => {
  it('空状态显示 AI 在岗与实时摘要', () => {
    render(<ChatPanel chat={[]} onAsk={vi.fn()} connected snap={makeSnapshot()} />);
    expect(screen.getByText(/AI 值班员在岗/)).toBeTruthy();
    expect(document.querySelector('.chat-brief')?.textContent).toContain('72/100');
    expect(document.querySelector('.chat-brief')?.textContent).toContain('TN 83%');
  });

  it('点击建议问题触发提问', () => {
    const onAsk = vi.fn();
    render(<ChatPanel chat={[]} onAsk={onAsk} connected snap={makeSnapshot()} />);
    fireEvent.click(screen.getByRole('button', { name: '现在运行怎么样' }));
    expect(onAsk).toHaveBeenCalledWith('现在运行怎么样');
  });

  it('断线时输入与建议按钮都禁用', () => {
    render(<ChatPanel chat={[]} onAsk={vi.fn()} connected={false} snap={makeSnapshot()} />);
    const input = screen.getByLabelText('向 AI 值班员提问') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect((screen.getByRole('button', { name: '现在运行怎么样' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('渲染问答消息与置信度', () => {
    render(
      <ChatPanel
        chat={[
          { id: 1, role: 'user', text: '现在怎么样', at: 0 },
          {
            id: 2,
            role: 'ai',
            text: '',
            at: 0,
            answer: {
              title: '当前全厂运行状态',
              body: '出水稳定。',
              bullets: ['COD 34.2 mg/L'],
              confidence: 0.93,
              kind: 'status',
            },
          },
        ]}
        onAsk={vi.fn()}
        connected
        snap={makeSnapshot()}
      />,
    );
    expect(screen.getByText('当前全厂运行状态')).toBeTruthy();
    expect(screen.getByText('COD 34.2 mg/L')).toBeTruthy();
    expect(screen.getByText('93%')).toBeTruthy();
  });
});
