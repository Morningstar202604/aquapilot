import type { CalibrationUiState } from '../hooks/useSimulation';

/**
 * 参数校准面板。
 *
 * 两步式交互（不是一个大按钮）：
 *   ① 先做可辨识性分析（约 40 s）——告诉用户「你的数据能标定哪些参数」；
 *   ② 再决定是否花 2–3 分钟做完整标定。
 *
 * 为什么必须分开：很多参数对出水没有可测量的影响（例如 k_a 在稳态下
 * 几乎不可见）。直接跑完整标定会把这些参数拟合成噪声，看起来「改善了」
 * 实际是过拟合。先看可辨识性，再决定拟谁，是标定工程的标准做法。
 *
 * 数据来源：默认用 BSM1 官方 Table 6 稳态值作为合成观测——这不是真实水厂
 * 数据，验证的是**标定流程正确性**，不是参数真实性。界面上必须写清楚。
 */
export function CalibrationPanel({
  state,
  onIdentify,
  onStart,
  onCancel,
}: {
  state: CalibrationUiState;
  onIdentify: () => void;
  onStart: () => void;
  onCancel: () => void;
}) {
  const { running, phase, progress, identifiability, result, error } = state;

  return (
    <div className="scroll-panel">
      <section className="analysis-block">
        <div className="analysis-title">模型参数校准</div>
        <div className="analysis-sub">
          用观测出水反推 ASM1 动力学参数。默认用 BSM1 官方 Table 6 稳态值作为合成观测，
          验证的是标定流程正确性，不是参数真实性。
        </div>

        {error && (
          <div className="analysis-note" data-warn="true" role="alert">
            {error}
          </div>
        )}

        {running && (
          <div className="analysis-note">
            {phase === 'identifiability' ? '正在分析参数可辨识性（约 40 秒）…' : '正在拟合参数…'}
            {progress && phase === 'fitting' && ` ${progress.done}/${progress.total}`}
            <button className="chip" style={{ marginLeft: 8 }} onClick={onCancel}>
              中止
            </button>
          </div>
        )}

        {!running && (
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn" onClick={onIdentify}>
              {identifiability ? '重新分析可辨识性' : '分析可辨识性'}
            </button>
            <button
              className="btn btn-primary"
              onClick={onStart}
              disabled={!identifiability}
              /* 禁用必须带原因：只把按钮置灰，用户不知道要先做什么 */
              title={identifiability ? '先跑可辨识性，再对可辨识的参数做拟合' : '请先完成「分析可辨识性」'}
            >
              开始标定
            </button>
          </div>
        )}
        {!running && !identifiability && (
          <div className="analysis-note">先做可辨识性分析：不可辨识的参数不应参与拟合，否则会把噪声拟合进来。</div>
        )}
      </section>

      {identifiability && (
        <section className="analysis-block">
          <div className="analysis-title">参数可辨识性</div>
          <div className="analysis-sub">相对灵敏度 = 参数变化对目标函数的影响。低于阈值的参数建议固定为文献值。</div>
          <table className="analysis-table">
            <thead>
              <tr>
                <th>参数</th>
                <th>相对灵敏度</th>
                <th>判定</th>
              </tr>
            </thead>
            <tbody>
              {identifiability.map((r) => (
                <tr key={r.param}>
                  <td>{r.param}</td>
                  <td>{r.relativeSensitivity.toFixed(3)}</td>
                  <td data-warn={!r.identifiable}>{r.identifiable ? '参与拟合' : '固定'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="analysis-note">
            共 {identifiability.filter((r) => r.identifiable).length} / {identifiability.length}{' '}
            个参数可被当前数据约束。
          </div>
        </section>
      )}

      {result && (
        <section className="analysis-block">
          <div className="analysis-title">标定结果</div>
          <div className="analysis-sub">
            目标函数 {result.objectiveBefore.toFixed(4)} → {result.objectiveAfter.toFixed(4)}
            （改善 {result.improvementPct.toFixed(1)}%），{result.converged ? '已收敛' : '达到迭代上限'}
          </div>
          <table className="analysis-table">
            <thead>
              <tr>
                <th>参数</th>
                <th>标定前</th>
                <th>标定后</th>
                <th>变化</th>
              </tr>
            </thead>
            <tbody>
              {result.changes.map((c) => (
                <tr key={c.param}>
                  <td>{c.param}</td>
                  <td>{c.before.toFixed(3)}</td>
                  <td>{c.after.toFixed(3)}</td>
                  <td data-warn={Math.abs(c.changePct) > 50}>
                    {c.changePct >= 0 ? '+' : ''}
                    {c.changePct.toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="analysis-note">
            固定不拟合：{result.fixed.length > 0 ? result.fixed.join('、') : '无'}。
            标定结果不会自动写入运行参数——需要人工确认后才会生效。
          </div>
        </section>
      )}
    </div>
  );
}
