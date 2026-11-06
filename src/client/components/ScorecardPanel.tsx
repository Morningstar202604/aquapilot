import type { Scorecard } from '../../sim/scorecard';

/**
 * 运营评分卡面板。
 *
 * 存在的意义不是"再给一个分数"，而是把分数拆成**可追问的四个维度**：
 * 出水达标（法定约束）、能效（钱）、生物稳定（会不会崩）、危机处置
 * （扰动来了扛不扛得住）。每个维度都列扣分依据，避免"78 分"这种
 * 无法行动的结论。
 *
 * 口径提示写死在面板顶部：同一个出水按一级 A 与按 BSM1 基准口径评估
 * 结果不同，不标口径的分数是不可比的。
 */
export function ScorecardPanel({ card }: { card: Scorecard | undefined }) {
  if (!card || card.dimensions.length === 0) {
    return (
      <div className="scroll-panel">
        <div className="section-label">运营评分卡</div>
        <div className="empty-note">
          还在积累采样点（至少需要几个趋势点才能评分）。
          <br />
          评分直接由仿真结果复算，不由 AI 自评。
        </div>
      </div>
    );
  }

  const tone = card.total >= 80 ? 'good' : card.total >= 60 ? 'watch' : 'risk';
  /**
   * 样本不足时不给"好/坏"配色：3 个点算出来的 96 分与跑满一天算出的 96 分
   * 不是同一件事，用绿色表扬它会让用户误以为已经验证过了。
   */
  const lowConfidence = card.confidence !== 'stable';
  const confidenceText =
    card.confidence === 'insufficient'
      ? '样本不足（<12 点）：分数仅供冒烟参考，不能用于横向比较'
      : card.confidence === 'provisional'
        ? '样本偏少（<240 点）：建议至少跑满 8 小时仿真再比较分数'
        : '';

  return (
    <div className="scroll-panel">
      <div>
        <div className="section-label">运营评分卡</div>
        <div className="score-card" data-tone={lowConfidence ? 'unknown' : tone}>
          <div className="score-head">
            <span className="score-total">{card.total}</span>
            <span className="score-unit">/ 100</span>
            <span className="score-standard">{card.standard.label}</span>
          </div>
          <div className="score-note">
            {card.samples} 个采样点 · 覆盖 {(card.spanMin / 60).toFixed(1)} h · 分数由仿真结果复算（非 AI 自评）
          </div>
          {lowConfidence && (
            <div className="score-confidence" role="status">
              {confidenceText}
            </div>
          )}
        </div>
      </div>

      {card.dimensions.map((d) => (
        <div className="score-dim" key={d.key}>
          <div className="score-dim-head">
            <span className="score-dim-name">{d.label}</span>
            <span className="score-dim-weight">权重 {d.weight}%</span>
            <span className="score-dim-value" data-tone={d.score >= 80 ? 'good' : d.score >= 60 ? 'watch' : 'risk'}>
              {d.score}
            </span>
          </div>
          <div className="score-bar">
            <span
              style={{ width: `${Math.max(0, Math.min(100, d.score))}%` }}
              data-tone={d.score >= 80 ? 'good' : d.score >= 60 ? 'watch' : 'risk'}
            />
          </div>
          <div className="score-dim-detail">{d.detail}</div>
          {d.deductions.length > 0 && (
            <ul className="score-why">
              {d.deductions.slice(0, 4).map((why, i) => (
                <li key={i}>{why}</li>
              ))}
            </ul>
          )}
        </div>
      ))}

      {card.violations.length > 0 && (
        <div>
          <div className="section-label">超标分布</div>
          <div className="score-violations">
            {card.violations.map((v) => (
              <span className="score-violation" key={v.metric}>
                {v.metric.toUpperCase()} <b>{v.minutes}</b>
              </span>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="section-label">能耗对照</div>
        <div className="alt-row">
          <span className="alt-name">常态吨水电耗</span>
          <span className="alt-score">{card.energy.normalKwhM3.toFixed(3)} kWh/m³</span>
        </div>
        <div className="alt-row">
          <span className="alt-name">场景内吨水电耗</span>
          {/*
            没有场景时不能显示 0.000：那会被读成「危机工况不耗电」。
            评测里「没有数据」与「数值是 0」必须严格区分（Home Assistant
            把 unavailable 与 off 分开处理，是同一个理由）。
          */}
          <span className="alt-score">
            {card.energy.scenarioKwhM3 > 0 ? `${card.energy.scenarioKwhM3.toFixed(3)} kWh/m³` : '本次未注入扰动'}
          </span>
        </div>
        <div className="control-hint">
          场景内能耗不参与打分（危机工况本来就该多耗电），列出是为了看「用多少电换回了达标」。
        </div>
      </div>
    </div>
  );
}
