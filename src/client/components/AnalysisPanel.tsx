import type { AnalysisSnapshot } from '../../sim/analysis';

/**
 * 运行分析面板：灵敏度 / Pareto 前沿 / 质量平衡。
 *
 * 三块内容回答三个运营真问题：
 *   ① 现在调哪个旋钮最有效？（而不是「所有旋钮都列一遍」）
 *   ② 达标与省钱之间有哪些同样好的选择？（加权分把取舍藏起来了）
 *   ③ 这些累计数字自洽吗？（模型可信度的底线）
 *
 * 数据按需计算（一次 ~25 个 4h 预测），打开面板才触发，不做实时推送。
 */
export function AnalysisPanel({
  analysis,
  loading,
  error,
  onRun,
}: {
  analysis: AnalysisSnapshot | null;
  loading: boolean;
  error: string | null;
  onRun: () => void;
}) {
  if (!analysis && !loading && !error) {
    return (
      <div className="scroll-panel">
        <div className="empty-note">
          对当前工况做一次参数灵敏度与 Pareto 分析。
          <br />
          约需 0.3–1 秒（20+ 次 4 小时预测），不会影响仿真推进。
        </div>
        <button className="btn btn-primary" onClick={onRun} style={{ alignSelf: 'flex-start' }}>
          开始分析
        </button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="scroll-panel">
        <div className="empty-note">正在计算灵敏度与 Pareto 前沿…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="scroll-panel">
        <div className="panel-empty" role="alert">
          分析失败：{error}
        </div>
        <button className="btn" onClick={onRun}>
          重试
        </button>
      </div>
    );
  }

  if (!analysis) return null;

  const actionable = analysis.sensitivity.filter((r) => r.actionable);
  const frontier = analysis.pareto.filter((p) => !p.dominated);
  const mb = analysis.massBalance;

  return (
    <div className="scroll-panel">
      <div className="analysis-head">
        <span className="section-label">运行分析 · 第 {Math.round(analysis.generatedAtMin / 60)} 小时</span>
        <button className="chip" onClick={onRun}>
          重新分析
        </button>
      </div>

      <div className="analysis-note">
        结果基于生成时刻的工况快照。调整控制量或注入场景后，建议重新分析—— 灵敏度排序会随工况变化。
      </div>

      <section className="analysis-block">
        <div className="analysis-title">参数灵敏度</div>
        <div className="analysis-sub">每 10% 量程变化对「最差出水指标占限值比例」的影响，按有效性排序</div>
        {actionable.length === 0 ? (
          <div className="analysis-empty">当前没有显著有效的调节量：工况对这些参数的响应都很弱。</div>
        ) : (
          <ul className="analysis-list">
            {actionable.slice(0, 5).map((r) => (
              <li key={r.key} className="analysis-row">
                <span className="analysis-name">{r.label}</span>
                <span className="analysis-bar">
                  <span
                    className="analysis-bar-fill"
                    data-positive={r.normalized > 0}
                    style={{
                      width: `${Math.min(100, Math.abs(r.normalized) * 400)}%`,
                    }}
                  />
                </span>
                <span className="analysis-value" data-positive={r.normalized > 0}>
                  {r.normalized > 0 ? '↑' : '↓'} {(Math.abs(r.normalized) * 100).toFixed(1)}%
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="analysis-note">
          {actionable.length > 0
            ? `优先关注：${actionable[0].label}。${actionable[0].verdict}`
            : '灵敏度过低时，AI 的微调收益会落在扰动噪声内，这正是决策死区存在的原因。'}
        </div>
      </section>

      <section className="analysis-block">
        <div className="analysis-title">Pareto 前沿（达标裕度 vs 运行成本）</div>
        <div className="analysis-sub">只列非支配方案：不存在「出水更好且更便宜」的替代</div>
        <table className="analysis-table">
          <thead>
            <tr>
              <th>方案</th>
              <th>最差占限值</th>
              <th>成本变化</th>
              <th>评分</th>
            </tr>
          </thead>
          <tbody>
            {frontier.map((p, i) => (
              <tr key={`${p.label}-${i}`}>
                <td>{p.label}</td>
                <td data-warn={p.worstRatio > 1}>{(p.worstRatio * 100).toFixed(0)}%</td>
                <td data-warn={p.costDelta > 0}>
                  {p.costDelta >= 0 ? '+' : '−'}¥{Math.abs(p.costDelta).toFixed(0)}
                </td>
                <td>{p.score.toFixed(0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="analysis-note">
          共评估 {analysis.pareto.length} 个方案，其中 {frontier.length} 个非支配。
          「维持现状」也在表内：若它被支配，说明存在明确更优的选择。
        </div>
      </section>

      <section className="analysis-block">
        <div className="analysis-title">全厂质量平衡审计</div>
        <div className="analysis-sub">进水 COD 应等于出水 + 排泥 + 曝气氧化 + 系统内库存变化</div>
        <dl className="analysis-kv">
          <dt>进水累计 COD</dt>
          <dd>{(mb.influentCodKg / 1000).toFixed(1)} t</dd>
          <dt>出水带走</dt>
          <dd>−{(mb.effluentCodKg / 1000).toFixed(1)} t</dd>
          <dt>排泥带走（×1.42）</dt>
          <dd>−{(mb.wastedCodKg / 1000).toFixed(1)} t</dd>
          <dt>曝气氧化</dt>
          <dd>−{(mb.oxidizedCodKg / 1000).toFixed(1)} t</dd>
          <dt>系统内库存变化</dt>
          <dd data-warn={mb.storedCodKg < 0}>
            {mb.storedCodKg >= 0 ? '+' : '−'}
            {Math.abs(mb.storedCodKg / 1000).toFixed(1)} t
          </dd>
          <dt>未解释差额</dt>
          <dd data-warn={!mb.selfConsistent}>{mb.closurePct.toFixed(1)}%</dd>
        </dl>
        {mb.mode === 'approximate' && (
          <div className="analysis-note">
            当前为 ASM1 模式：三条去向的取样口径不同，审计按 ±20% 近似判定，不能当作严格守恒证明。
          </div>
        )}
        <div className="analysis-note" data-warn={!mb.selfConsistent}>
          {mb.note}
        </div>
      </section>
    </div>
  );
}
