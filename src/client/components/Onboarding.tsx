import { useEffect, useState } from 'react';

/**
 * 首次访问引导。
 *
 * 设计原则：**在用户迷路之前给出路标**，而不是写一份藏在 docs/ 里的说明书。
 *
 * 内容约束：
 * - 不超过 5 步（超过没人看完，不如不写）
 * - 每一步必须对应用户界面里真实存在的入口，写错名字比不写更糟
 * - 关闭动作由调用方（App）统一落记忆，组件本身不重复写存储
 *
 * 界面实际结构（`App.tsx`）：顶栏有「运行监视 / 工艺编排」两个视图；
 * 运行监视下侧栏有 10 个页签——AI 对话、决策解释、控制与工况、告警、
 * 效益、分析、校准、进水、回放、自检。引导按「看 / 调 / 挖 / 查」四类
 * 归并，避免把 10 个名字一次性砸给新用户。
 */

/** 引导步骤。导出以便测试交叉核对「引导文案 ↔ 真实页签」，防止两份清单漂移。 */
export const ONBOARDING_STEPS: { tab: string; title: string; body: string }[] = [
  {
    tab: '运行监视 · 顶部',
    title: '先看这三块：出水、能耗、健康度',
    body: '首屏左侧是工艺画布（池体、管线、实时浓度），右侧是指标卡与趋势图。颜色代表水质是否接近排放限值，不是装饰。',
  },
  {
    tab: 'AI 对话 / 决策解释',
    title: '问它「现在怎么样」，再看它「想做什么」',
    body: '「AI 对话」用中文直接提问，回答基于当前仿真数据；「决策解释」给出候选方案排名、每项调整的理由，以及为什么选择不动。',
  },
  {
    tab: '控制与工况 / 告警 / 效益',
    title: '想接管、想制造一次事故、想看省了多少钱',
    body: '「控制与工况」拖动滑块手动改控制量（AI 会自动让位一段时间），也能注入暴雨、鼓风机故障等场景；「告警」按严重度归档并给出归因；「效益」把能耗、药耗与达标情况折算成可比较的运行成本。',
  },
  {
    tab: '分析 / 校准 / 进水',
    title: '进阶：用数据回答运营问题',
    body: '「分析」算参数灵敏度与达标-成本权衡曲线；「校准」用出水数据反推模型参数；「进水」可加载真实历史 CSV 驱动仿真（含数据质量校验）。',
  },
  {
    tab: '回放 / 自检 · 工艺编排',
    title: '事后追溯、系统体检、改工艺流程',
    body: '「回放」查看历史任一时刻的状态；「自检」报告服务健康与配置问题；顶栏切到「工艺编排」可改拓扑——加一个池子，求解结果就会跟着变。',
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
  const current = ONBOARDING_STEPS[step];
  const isLast = step === ONBOARDING_STEPS.length - 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Enter') (isLast ? onClose : () => setStep((s) => Math.min(s + 1, ONBOARDING_STEPS.length - 1)))();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isLast, onClose]);

  return (
    <div className="onboarding-overlay" role="dialog" aria-modal="true" aria-label="使用引导">
      <div className="onboarding-card">
        <div className="onboarding-brand">AQUAPILOT</div>
        <div className="onboarding-step">
          {step + 1} / {ONBOARDING_STEPS.length}
        </div>
        <div className="onboarding-tab">{current.tab}</div>
        <h2 className="onboarding-title">{current.title}</h2>
        <p className="onboarding-body">{current.body}</p>
        <div className="onboarding-dots" aria-hidden="true">
          {ONBOARDING_STEPS.map((_, i) => (
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
