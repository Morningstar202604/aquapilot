import { useState } from 'react';
import { METRIC_KEYS } from '../../sim/sampling';
import { formatClock } from '../../shared/time';
import { authHeaders } from './industrial/http';
import { usePolledJson } from './industrial/usePolledJson';

/**
 * WP6 合规报表面板（只读）。
 *
 * 数据来自 `GET /api/compliance/report?from=0&to=<timeMin>`；CSV 走同一端点
 * `format=csv`，响应形状为 `{ format: 'csv', csv, filename }`（不是裸 CSV 文件）。
 * 窗口内无合格样品时服务端返回 422 `COMPLIANCE_NO_SAMPLES`，这里按错误状态
 * 展示文案，不给一张空白表。
 */

interface MetricDaily {
  dayMin: number;
  value: number;
}

interface MetricRow {
  metric: string;
  label: string;
  limit: number;
  sampleCount: number;
  acceptedCount: number;
  rejectedCount: number;
  daily: MetricDaily[];
  validAssessmentDays: number;
  compliantDays: number;
  complianceRatePct: number | null;
  completenessPct: number | null;
  monthlyMean: number | null;
  p95: number | null;
  exceedDayCount: number;
}

interface ComplianceReportBody {
  window: { fromMin: number; toMin: number };
  standardId: string;
  dataSource: string;
  generatedAtMin: number;
  metrics: Record<string, MetricRow>;
  samples: unknown[];
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; code?: string }
  | { kind: 'ready'; report: ComplianceReportBody };

interface Props {
  /** 仿真时钟上限（分钟）；报表窗口固定 from=0 */
  timeMin: number;
  token?: string | null;
  /** 轮询节拍（ms）；默认 30 s */
  pollMs?: number;
}

const pct = (v: number | null): string => (v === null ? '—' : `${v.toFixed(1)}%`);
const mgL = (v: number | null): string => (v === null ? '—' : `${v.toFixed(2)} mg/L`);

function sourceLabel(source: string): string {
  return source === 'synthetic' ? '合成数据（仿真生成，非现场实测）' : '现场数据';
}

/** 合规报表 CSV 导出：先取 JSON 包，再用包里的 csv 文本落盘。 */
function CsvDownload({
  url,
  filename,
  token,
  label,
}: {
  url: string;
  filename: string;
  token?: string | null;
  label: string;
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'error'>('idle');

  const download = async () => {
    setState('busy');
    try {
      const res = await fetch(url, { headers: authHeaders(token) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { format?: string; csv?: string; filename?: string };
      const blob = new Blob([json.csv ?? ''], { type: 'text/csv;charset=utf-8' });
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = json.filename ?? filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
      setState('idle');
    } catch {
      setState('error');
    }
  };

  return (
    <button className="download-btn" data-href={url} onClick={() => void download()} disabled={state === 'busy'}>
      {state === 'error' ? '导出失败，重试' : state === 'busy' ? '导出中…' : label}
    </button>
  );
}

export function CompliancePanel({ timeMin, token, pollMs = 30_000 }: Props) {
  const reportUrl = `/api/compliance/report?from=0&to=${timeMin}`;
  const csvUrl = `${reportUrl}&format=csv`;

  const polled = usePolledJson<ComplianceReportBody>(reportUrl, token, pollMs);
  const state: LoadState = polled.kind === 'ready' ? { kind: 'ready', report: polled.data } : polled;

  if (state.kind === 'loading') {
    return (
      <div className="scroll-panel">
        <div className="empty-note">正在拉取合规报表…</div>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="scroll-panel">
        <div className="section-label">合规报表</div>
        <div className="alarm-row" data-sev="warning">
          <div className="alarm-meta">
            <span style={{ color: 'var(--alarm)' }}>报表不可用</span>
            {state.code && <span className="alarm-unit">{state.code}</span>}
          </div>
          <div className="alarm-text">{state.message}</div>
        </div>
      </div>
    );
  }

  const { report } = state;
  const rows = METRIC_KEYS.map((key) => report.metrics[key]).filter((r): r is MetricRow => Boolean(r));
  const acceptedTotal = rows.reduce((sum, r) => sum + r.acceptedCount, 0);
  const rejectedTotal = rows.reduce((sum, r) => sum + r.rejectedCount, 0);

  return (
    <div className="scroll-panel">
      <div>
        <div className="section-label">合规报表</div>
        <div className="alt-row">
          <span className="alt-name">执行标准</span>
          <span className="alt-score">{report.standardId}</span>
        </div>
        <div className="alt-row">
          <span className="alt-name">统计窗口</span>
          <span className="alt-score">
            {formatClock(report.window.fromMin)} – {formatClock(report.window.toMin)}
          </span>
        </div>
        <div className="alt-row">
          <span className="alt-name">数据来源</span>
          <span className="alt-score" data-best={report.dataSource !== 'synthetic'}>
            {sourceLabel(report.dataSource)}（{report.dataSource}）
          </span>
        </div>
        <div className="alt-row">
          <span className="alt-name">QA 样品</span>
          <span className="alt-score">
            合格 {acceptedTotal} · 作废 {rejectedTotal}
          </span>
        </div>
        <div className="export-row" style={{ marginTop: 8 }}>
          <CsvDownload url={csvUrl} filename="compliance-report.csv" token={token} label="合规报表 CSV" />
        </div>
      </div>

      <div>
        <div className="section-label">指标考核（{rows.length}）</div>
        <table className="analysis-table">
          <thead>
            <tr>
              <th>指标</th>
              <th>限值</th>
              <th>日均值</th>
              <th>有效考核日</th>
              <th>达标率</th>
              <th>95 分位</th>
              <th>超标日</th>
              <th>完整率</th>
              <th>作废样</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const latestDaily = r.daily.length > 0 ? r.daily[r.daily.length - 1].value : null;
              const dailyValue = latestDaily ?? r.monthlyMean;
              return (
                <tr key={r.metric}>
                  <td>{r.label}</td>
                  <td>≤ {r.limit} mg/L</td>
                  <td>{mgL(dailyValue)}</td>
                  <td>{r.validAssessmentDays} d</td>
                  <td data-warn={r.complianceRatePct !== null && r.complianceRatePct < 100}>
                    {pct(r.complianceRatePct)}
                  </td>
                  <td>{mgL(r.p95)}</td>
                  <td data-warn={r.exceedDayCount > 0}>{r.exceedDayCount} d</td>
                  <td>{pct(r.completenessPct)}</td>
                  <td>{r.rejectedCount}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="control-hint" style={{ marginTop: 8 }}>
          日均值取最近一个有效考核日的 24h 混合样均值；达标率分母为有效考核日，不是分钟数。
        </div>
      </div>
    </div>
  );
}
