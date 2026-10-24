import type { Recommendation } from '../../ai/agent';
import type { PlantSnapshot } from '../../shared/protocol';
import { CONTROL_BOUNDS, SCENARIO_LABELS } from './labels';

interface Props {
  snap: PlantSnapshot;
  rec: Recommendation | null;
  onApply: () => void;
  onRefresh: () => void;
  aiEnabled: boolean;
  onToggleAi: (v: boolean) => void;
}

const SEV_LABEL: Record<string, string> = {
  normal: '常态运行',
  watch: '趋势预警',
  critical: '应急干预',
};

export function DecisionPanel({ snap, rec, onApply, onRefresh, aiEnabled, onToggleAi }: Props) {
  if (!rec) {
    return (
      <div className="scroll-panel">
        <div className="empty-note">AI 正在生成第一个决策周期…</div>
      </div>
    );
  }

  const tweaks = rec.tweaks;
  const scenarioActive = snap.scenario && snap.timeMin <= snap.scenario.startedAt + snap.scenario.durationMin;

  return (
    <div className="scroll-panel">
      <div>
        <div className="section-label">
          本轮决策 · 仿真第 {Math.floor(rec.generatedAt / 60)}h
          {String(Math.floor(rec.generatedAt % 60)).padStart(2, '0')}m
        </div>
        <div className="decision-card" data-sev={rec.severity}>
          <div className="decision-top">
            <span className="sev-tag" data-sev={rec.severity}>
              {SEV_LABEL[rec.severity]}
            </span>
            <span className="sev-tag">
              {rec.action === 'hold' ? '维持' : rec.action === 'emergency' ? '立即执行' : '建议微调'}
            </span>
            <span className="sev-tag" style={{ marginLeft: 'auto' }}>
              方案区分度 {Math.round(rec.separation * 100)}%
            </span>
          </div>
          <div className="decision-summary">{rec.summary}</div>

          {tweaks.length > 0 && (
            <div className="tweak-list">
              {tweaks.map((t) => (
                <div className="tweak" key={t.key}>
                  <span className="tweak-name">{CONTROL_BOUNDS[t.key]?.label ?? t.key}</span>
                  <span className="tweak-delta">
                    {formatControl(t.key, t.from)} → {formatControl(t.key, t.to)}
                  </span>
                  <span className="tweak-why">{t.reason}</span>
                </div>
              ))}
            </div>
          )}

          <ul className="rationale">
            {rec.rationale.slice(0, 4).map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>

          <div className="decision-actions">
            <button className="btn btn-primary" onClick={onApply} disabled={aiEnabled && rec.action === 'hold'}>
              {aiEnabled ? 'AI 已自动执行' : '采纳建议'}
            </button>
            <button className="btn" onClick={onRefresh}>
              重新推演
            </button>
          </div>

          <div className="control-row" style={{ paddingBottom: 0 }}>
            <div className="control-top">
              <span className="control-name">AI 自动值守</span>
              <button
                className="pill"
                data-active={aiEnabled}
                onClick={() => onToggleAi(!aiEnabled)}
                aria-pressed={aiEnabled}
              >
                <span className="dot" data-live={aiEnabled} />
                {aiEnabled ? '自动执行' : '仅建议'}
              </button>
            </div>
            <div className="control-hint">
              {aiEnabled ? '每 15 分钟仿真时间自动比选控制方案并执行' : 'AI 只给建议，所有调节需你确认'}
            </div>
          </div>
        </div>
      </div>

      {rec.alternatives.length > 0 && (
        <div>
          <div className="section-label">候选方案比选</div>
          {[rec.chosens, ...rec.alternatives].map((c, i) => (
            <div className="alt-row" key={c.label + i}>
              <span className="alt-name">
                {i === 0 ? '★ ' : ''}
                {c.label}
              </span>
              <span className="alt-score" data-best={i === 0}>
                {c.quality}/100
              </span>
              <span className="alt-score">
                {c.violations > 0 ? `${c.violations} 超标` : '无超标'} · ¥{c.cost.toFixed(0)}
              </span>
            </div>
          ))}
        </div>
      )}

      <div>
        <div className="section-label">风险与约束</div>
        <ul className="rationale">
          {rec.risks.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      </div>

      <div>
        <div className="section-label">下一时段预测</div>
        <div className="alt-row">
          <span className="alt-name">预测出水评分</span>
          <span className="alt-score">{rec.predictedScore}/100</span>
          <span className="alt-score">4 h</span>
        </div>
        <div className="alt-row">
          <span className="alt-name">预测 NH₃-N</span>
          <span className="alt-score">{rec.predictedEffluent.nh.toFixed(2)}</span>
          <span className="alt-score">/ {snap.limits.nh}</span>
        </div>
        <div className="alt-row">
          <span className="alt-name">预测 COD</span>
          <span className="alt-score">{rec.predictedEffluent.cod.toFixed(1)}</span>
          <span className="alt-score">/ {snap.limits.cod}</span>
        </div>
        <div className="alt-row">
          <span className="alt-name">预测 TP</span>
          <span className="alt-score">{rec.predictedEffluent.tp.toFixed(3)}</span>
          <span className="alt-score">/ {snap.limits.tp}</span>
        </div>
        <div className="alt-row">
          <span className="alt-name">预测 SS</span>
          <span className="alt-score">{rec.predictedEffluent.ss.toFixed(1)}</span>
          <span className="alt-score">/ {snap.limits.ss}</span>
        </div>
      </div>

      <div>
        <div className="section-label">不确定性（参数扰动）</div>
        {rec.robustEvaluated && rec.ensemble ? (
          <>
            <div className="alt-row">
              <span className="alt-name">超限概率</span>
              <span className="alt-score" data-best={rec.ensemble.exceedanceProbability === 0}>
                {(rec.ensemble.exceedanceProbability * 100).toFixed(0)}%
              </span>
              <span className="alt-score">{rec.ensemble.samples} 样本</span>
            </div>
            <div className="alt-row">
              <span className="alt-name">4 h 末 NH₃-N 区间</span>
              <span className="alt-score">{bandAtEnd(rec.ensemble, 'nh', snap.limits.nh)}</span>
            </div>
            <div className="alt-row">
              <span className="alt-name">4 h 末 COD 区间</span>
              <span className="alt-score">{bandAtEnd(rec.ensemble, 'cod', snap.limits.cod)}</span>
            </div>
            <div className="control-hint">
              P10–P90 来自进水 ±15–20%、水温 ±1.5 ℃、生物量 ±10% 的固定扰动集，不是统计置信区间。
            </div>
          </>
        ) : (
          <div className="empty-note">当前模型未提供不确定性评估（旧引擎适配器）。</div>
        )}
      </div>

      {scenarioActive && snap.scenario && (
        <div>
          <div className="section-label">进行中的场景</div>
          <div className="storm-card">
            <span className="dot" data-tone="amber" />
            <span style={{ fontSize: 11.5 }}>
              {SCENARIO_LABELS[snap.scenario.type]} · 剩余{' '}
              {Math.max(0, Math.round(snap.scenario.startedAt + snap.scenario.durationMin - snap.timeMin))} 分钟
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function formatControl(key: string, value: number): string {
  const meta = CONTROL_BOUNDS[key as keyof typeof CONTROL_BOUNDS];
  if (!meta) return value.toFixed(2);
  return `${value.toFixed(meta.precision)}${meta.unit ? ` ${meta.unit}` : ''}`;
}

function bandAtEnd(
  ensemble: NonNullable<Recommendation['ensemble']>,
  metric: 'nh' | 'cod' | 'tn' | 'tp' | 'ss',
  limit: number,
): string {
  const last = ensemble.points[ensemble.points.length - 1];
  if (!last) return '—';
  const b = last[metric];
  return `${b.p10.toFixed(2)} – ${b.p90.toFixed(2)} / ${limit}`;
}
