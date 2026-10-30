import { useEffect, useState } from 'react';

/**
 * 首次访问引导。
 *
 * 为什么需要：界面有 10 个页签、3 个专业面板，新用户的第一反应是
 * 「这是什么、我从哪开始」。没有引导时最专业的功能也不会被用——
 * 傻瓜式设计的核心是**在用户迷路之前给出路标**，而不是写一份
 * 藏在 docs/ 里的说明书。
 *
 * 只在首次访问显示（sessionStorage 记忆），且可跳过、可从顶栏重开。
 * 内容控制在 5 步以内：超过 5 步没人看完，不如不写。
 */

const STEPS: { tab: string; title: string; body: string }[] = [
  {
    tab: 'AI 对话',
    title: '像问同事一样提问',
    body: '直接用中文问「现在出水怎么样」「氨氮为什么升高」。回答基于当前仿真数据，每个数字都有出处。',
  },
  {
    tab: '决策解释',
    title: '看 AI 想做什么、为什么',
    body: 'AI 每 15 分钟给一次建议。这里能看到候选方案排名、每项调整的理由，以及它为什么没调。',
  },
  {
    tab: '控制与工况',
    title: '手动接管或注入工况',
    body: '拖动滑块改控制量（AI 会暂停 30 分钟让给你），或注入暴雨、设备故障等场景看系统如何应对。',
  },
  {
    tab: '分析 · 校准 · 进水',
    title: '进阶：用数据回答运营问题',
    body: '「分析」告诉你哪个参数最有效；「校准」用出水数据反推模型参数；「进水」可加载真实历史数据驱动仿真。',
  },
  {
    tab: '回放 · 自检',
    title: '事后追溯与系统体检',
    body: '「回放」查看历史任一时刻的状态；「自检」实时报告服务健康状况与配置问题。',
  },
];

const STORAGE_KEY = 'aquapilot_onboarded';

export function hasSeenOnboarding(): boolean {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return true; // 存储不可用时不打扰用户
  }
}

export function markOnboarded(): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, '1');
  } catch {
    /* 忽略 */
  }
}

export function Onboarding({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Enter') (isLast ? onClose : () => setStep((s) => Math.min(s + 1, STEPS.length - 1)))();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isLast, onClose]);

  return (
    <div className="onboarding-overlay" role="dialog" aria-modal="true" aria-label="使用引导">
      <div className="onboarding-card">
        <div className="onboarding-brand">AQUAPILOT</div>
        <div className="onboarding-step">
          {step + 1} / {STEPS.length}
        </div>
        <div className="onboarding-tab">{current.tab}</div>
        <h2 className="onboarding-title">{current.title}</h2>
        <p className="onboarding-body">{current.body}</p>
        <div className="onboarding-dots" aria-hidden="true">
          {STEPS.map((_, i) => (
            <span key={i} className="onboarding-dot" data-active={i === step} />
          ))}
        </div>
        <div className="onboarding-actions">
          <button className="chip" onClick={onClose}>
            跳过
          </button>
          {step > 0 && (
            <button className="chip" onClick={() => setStep((s) => s - 1)}>
              上一步
            </button>
          )}
          <button
            className="btn btn-primary"
            onClick={() => {
              if (isLast) {
                markOnboarded();
                onClose();
              } else {
                setStep((s) => s + 1);
              }
            }}
          >
            {isLast ? '开始使用' : '下一步'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 顶栏「?」按钮：随时重看引导 */
export function HelpButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="help-btn" onClick={onClick} aria-label="使用引导" title="使用引导">
      ?
    </button>
  );
}
