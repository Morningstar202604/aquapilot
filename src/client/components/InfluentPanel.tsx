import { useState } from 'react';
import type { InfluentUiState } from '../hooks/useSimulation';

/**
 * 进水序列面板：上传 CSV → 看质量报告 → 决定是否应用。
 *
 * 三步式而不是「上传即生效」：真实水厂导出的数据几乎总有问题
 * （单位错填、探头冻结、断档），直接应用会让仿真结果悄悄偏掉。
 * 先看报告再决定，是数据工程的常识。
 */
export function InfluentPanel({
  state,
  onLoad,
  onApply,
  onClear,
}: {
  state: InfluentUiState;
  onLoad: (name: string, csv: string) => void;
  onApply: () => void;
  onClear: () => void;
}) {
  const [name, setName] = useState('');
  const [csv, setCsv] = useState('');
  const [showSample, setShowSample] = useState(false);

  const sample = [
    'minute,flow,cod,nh,tp,ss,temperature',
    '0,2000,350,34.0,4.8,180,20.0',
    '15,2100,355,34.5,4.9,182,20.1',
    '30,2250,360,35.0,5.0,185,20.2',
    '45,2400,370,36.0,5.1,190,20.3',
  ].join('\n');

  return (
    <div className="scroll-panel">
      <section className="analysis-block">
        <div className="analysis-title">真实进水序列</div>
        <div className="analysis-sub">
          加载历史进水剖面来驱动仿真，而不是用「昼夜节律 + 噪声」的合成模型。
          格式：minute,flow,cod,nh,tp,ss,temperature（可含表头，最多 2 MB）。
        </div>

        <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="序列名称（可选）"
            aria-label="序列名称"
            style={{ padding: '6px 8px', fontSize: 11 }}
          />
          <textarea
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            placeholder="粘贴 CSV 内容，或先点下方「填入示例」"
            aria-label="CSV 内容"
            rows={6}
            style={{ padding: '6px 8px', fontSize: 11, fontFamily: 'JetBrains Mono, monospace', resize: 'vertical' }}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="chip" onClick={() => setCsv(sample)}>
              填入示例
            </button>
            <button className="chip" onClick={() => setShowSample((v) => !v)}>
              {showSample ? '隐藏说明' : '格式说明'}
            </button>
          </div>
          <button
            className="btn btn-primary"
            disabled={csv.trim().length === 0 || state.loading}
            onClick={() => onLoad(name.trim() || '自定义进水', csv)}
            style={{ justifySelf: 'start' }}
          >
            {state.loading ? '解析中…' : '解析并检查质量'}
          </button>
        </div>

        {showSample && (
          <div className="analysis-note">
            第一列是仿真分钟（从 0 开始），其余按 flow(m³/h)、cod、nh、tp、ss(mg/L)、temperature(℃) 排列。
            超出末尾后自动循环，因此 24 小时剖面可以驱动任意时长仿真。 缺失列按设计值补齐。
          </div>
        )}

        {state.error && (
          <div className="analysis-note" data-warn="true" role="alert">
            {state.error}
          </div>
        )}
      </section>

      {state.report && (
        <section className="analysis-block">
          <div className="analysis-title">质量报告</div>
          <div className="analysis-sub">
            {state.report.summary
              ? `${state.report.summary.name} · ${state.report.summary.points} 点 · ${state.report.summary.days.toFixed(1)} 天`
              : '无数据'}
            {state.report.applied && ' · 已应用'}
          </div>

          <dl className="analysis-kv">
            <dt>质量评分</dt>
            <dd data-warn={!state.report.quality.usable}>{state.report.quality.score}/100</dd>
            <dt>可用性</dt>
            <dd data-warn={!state.report.quality.usable}>
              {state.report.quality.usable ? '可用于仿真' : '存在错误，不可用'}
            </dd>
            {state.report.summary && (
              <>
                <dt>平均流量</dt>
                <dd>{state.report.summary.flowMean.toFixed(0)} m³/h</dd>
                <dt>峰值流量</dt>
                <dd>{state.report.summary.flowPeak.toFixed(0)} m³/h</dd>
                <dt>平均 COD</dt>
                <dd>{state.report.summary.codMean.toFixed(0)} mg/L</dd>
                <dt>温度范围</dt>
                <dd>
                  {state.report.summary.temperatureRange[0].toFixed(1)}–
                  {state.report.summary.temperatureRange[1].toFixed(1)} ℃
                </dd>
              </>
            )}
          </dl>

          {state.report.quality.issues.length > 0 && (
            <table className="analysis-table">
              <thead>
                <tr>
                  <th>级别</th>
                  <th>问题</th>
                </tr>
              </thead>
              <tbody>
                {state.report.quality.issues.slice(0, 8).map((issue, i) => (
                  <tr key={`${issue.code}-${i}`}>
                    <td data-warn={issue.severity === 'error'}>{issue.severity}</td>
                    <td>{issue.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button
              className="btn btn-primary"
              disabled={!state.report.quality.usable || state.report.applied || state.applying}
              onClick={onApply}
            >
              {state.applying ? '应用中…' : state.report.applied ? '已应用' : '应用此序列'}
            </button>
            <button className="btn" onClick={onClear}>
              恢复合成进水
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
