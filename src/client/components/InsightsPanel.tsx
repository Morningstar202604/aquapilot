import { useState } from 'react';
import type { PlantSnapshot } from '../../shared/protocol';

interface Props {
  snap: PlantSnapshot;
  aiEnabled: boolean;
}

const MANUAL_BASELINE = {
  specificKwh: 0.245,
  pacDose: 38,
  complianceRate: 0.972,
  operatorRoundsPerShift: 22,
};

export function InsightsPanel({ snap, aiEnabled }: Props) {
  const elapsedHours = Math.max(0.25, snap.totals.elapsedMin / 60);
  const actualKwhPerM3 = snap.totals.energyKwh / Math.max(1, snap.totals.inflowM3);
  const energyDelta = ((MANUAL_BASELINE.specificKwh - actualKwhPerM3) / MANUAL_BASELINE.specificKwh) * 100;
  const pacSaving = ((MANUAL_BASELINE.pacDose - snap.controls.pacDose) / MANUAL_BASELINE.pacDose) * 100;
  // 同一口径：电费 + PAC 药费 + 污泥处置，按当日水量与浓度折算
  const dailyFlowM3 = (snap.totals.inflowM3 / elapsedHours) * 24;
  const actualCostPerDay = (snap.totals.cost / elapsedHours) * 24;
  const baselineCostPerDay =
    dailyFlowM3 * MANUAL_BASELINE.specificKwh * 0.68 +
    dailyFlowM3 * (MANUAL_BASELINE.pacDose / 1000) * 2.2 +
    dailyFlowM3 * 0.009 * (snap.clarifier.xRas / 1000) * 0.36;
  const costDelta = ((baselineCostPerDay - actualCostPerDay) / Math.max(1, baselineCostPerDay)) * 100;
  const costPerDay = actualCostPerDay;
  const annualFlowM3 = dailyFlowM3 * 365;
  const baselineEnergyAnnual = annualFlowM3 * MANUAL_BASELINE.specificKwh * 0.68;
  const actualEnergyAnnual = annualFlowM3 * actualKwhPerM3 * 0.68;
  // 不做 Math.max(0, ...)：负值必须显示出来，否则会掩盖"比基准更费电"的情况
  const annualSaving = baselineEnergyAnnual - actualEnergyAnnual;

  const margin = snap.margins[0];
  const complianceRisk = margin.ratio > 1 ? '已越限' : margin.ratio > 0.85 ? '裕度不足' : '裕度充足';
  const bm = snap.benchmark;

  return (
    <div className="scroll-panel">
      <div>
        <div className="section-label">AI 值守 vs 人工基准</div>
        <div className="compare-grid">
          <Metric
            label="吨水电耗"
            actual={actualKwhPerM3.toFixed(3)}
            unit="kWh/m³"
            baseline={MANUAL_BASELINE.specificKwh.toFixed(3)}
            delta={energyDelta}
            better="lower"
          />
          <Metric
            label="PAC 投加"
            actual={snap.controls.pacDose.toFixed(0)}
            unit="mg/L"
            baseline={MANUAL_BASELINE.pacDose.toFixed(0)}
            delta={pacSaving}
            better="lower"
          />
          <Metric
            label="出水裕度"
            actual={`${(margin.ratio * 100).toFixed(0)}%`}
            unit={margin.metric}
            baseline="85%"
            delta={85 - margin.ratio * 100}
            better="lower"
          />
          <Metric
            label="日运行成本"
            actual={(costPerDay / 1000).toFixed(1)}
            unit="千元"
            baseline={(baselineCostPerDay / 1000).toFixed(1)}
            delta={costDelta}
            better="lower"
          />
        </div>
        <div className="control-hint" style={{ marginTop: 8 }}>
          基准值为人工经验控制下的同规模水厂典型运行区间，用于对照，不代表同一时段的实测。
        </div>
      </div>

      <div>
        <div className="section-label">AI vs 固定策略（同进水双跑）</div>
        {bm && bm.ai.minutes > 0 ? (
          <>
            <BenchRow
              label="出水合规率"
              ai={`${((bm.ai.compliantMinutes / Math.max(1, bm.ai.minutes)) * 100).toFixed(1)}%`}
              manual={`${((bm.manual.compliantMinutes / Math.max(1, bm.manual.minutes)) * 100).toFixed(1)}%`}
              delta={`${bm.complianceDeltaPct >= 0 ? '+' : ''}${bm.complianceDeltaPct.toFixed(1)} pct`}
              good={bm.complianceDeltaPct >= 0}
            />
            <BenchRow
              label="吨水电耗"
              ai={bm.ai.specificKwhM3.toFixed(3)}
              manual={bm.manual.specificKwhM3.toFixed(3)}
              delta={`${bm.specificEnergyDelta >= 0 ? '+' : ''}${bm.specificEnergyDelta.toFixed(3)}`}
              good={bm.specificEnergyDelta <= 0}
            />
            <BenchRow
              label="运行成本（按吨水）"
              ai={`¥${(bm.ai.cost / Math.max(1, bm.ai.inflowM3)).toFixed(4)}`}
              manual={`¥${(bm.manual.cost / Math.max(1, bm.manual.inflowM3)).toFixed(4)}`}
              delta={`${bm.costDeltaPct >= 0 ? '+' : ''}${bm.costDeltaPct.toFixed(1)}%`}
              good={bm.costDeltaPct <= 0}
            />
            <BenchRow
              label="平均出水评分"
              ai={(bm.ai.scoreSum / Math.max(1, bm.ai.minutes)).toFixed(1)}
              manual={(bm.manual.scoreSum / Math.max(1, bm.manual.minutes)).toFixed(1)}
              delta={`${bm.scoreDelta >= 0 ? '+' : ''}${bm.scoreDelta.toFixed(1)}`}
              good={bm.scoreDelta >= 0}
            />
            <div className="control-hint" style={{ marginTop: 8 }}>
              影子链与主链共享 seed 与进水序列，只改控制策略；样本 {Math.round(bm.ai.minutes)} 分钟
              {bm.mature ? '（已具备统计意义）' : '（样本不足 6 小时，仅供参考）'}。
            </div>
          </>
        ) : (
          <div className="empty-note">影子双跑刚启动，累计 6 小时后给出对照。</div>
        )}
      </div>

      <div>
        <div className="section-label">数据导出</div>
        <div className="export-row">
          <DownloadButton url="/api/export/snapshots.csv" filename="aquapilot-snapshots.csv" label="出水历史 CSV" />
          <DownloadButton url="/api/export/decisions.csv" filename="aquapilot-decisions.csv" label="决策记录 CSV" />
          <DownloadButton url="/api/export/report.md" filename="aquapilot-report.md" label="运行报告 MD" />
        </div>
        <div className="control-hint">导出当前 run 的抽样点；启用访问控制时以会话令牌请求，不把令牌写进 URL。</div>
      </div>

      <div>
        <div className="section-label">运行纪律</div>
        <div className="alt-row">
          <span className="alt-name">值守模式</span>
          <span className="alt-score" data-best={aiEnabled}>
            {aiEnabled ? 'AI 自动执行' : 'AI 仅建议'}
          </span>
        </div>
        <div className="alt-row">
          <span className="alt-name">决策周期</span>
          <span className="alt-score">15 min 仿真时间</span>
        </div>
        <div className="alt-row">
          <span className="alt-name">预测时域</span>
          <span className="alt-score">4 h 滚动</span>
        </div>
        <div className="alt-row">
          <span className="alt-name">当前合规状态</span>
          <span className="alt-score" data-best={complianceRisk === '裕度充足'}>
            {complianceRisk}
          </span>
        </div>
        <div className="alt-row">
          <span className="alt-name">人工巡检替代</span>
          <span className="alt-score">{MANUAL_BASELINE.operatorRoundsPerShift} 次/班 → 连续</span>
        </div>
      </div>

      <div>
        <div className="section-label">累计与推算</div>
        <div className="alt-row">
          <span className="alt-name">累计处理水量</span>
          <span className="alt-score">{(snap.totals.inflowM3 / 1000).toFixed(1)} 千 m³</span>
        </div>
        <div className="alt-row">
          <span className="alt-name">累计电耗</span>
          <span className="alt-score">{(snap.totals.energyKwh / 1000).toFixed(2)} MWh</span>
        </div>
        <div className="alt-row">
          <span className="alt-name">累计药剂与泥耗</span>
          <span className="alt-score">¥{(snap.totals.chemicalCost + snap.totals.sludgeCost).toFixed(0)}</span>
        </div>
        <div className="alt-row">
          <span className="alt-name">年化电费{annualSaving >= 0 ? '节省' : '超支'}（按当前负荷线性外推，仅示意）</span>
          <span className="alt-score" data-best={annualSaving > 0}>
            {annualSaving >= 0 ? '' : '−'}¥{(Math.abs(annualSaving) / 10000).toFixed(1)} 万
          </span>
        </div>
      </div>

      <div>
        <div className="section-label">当前控制方案</div>
        <div className="alt-row">
          <span className="alt-name">溶解氧 / 内回流</span>
          <span className="alt-score">
            {snap.controls.doSetpoint.toFixed(1)} · {snap.controls.internalRecirc.toFixed(1)}×Q
          </span>
        </div>
        <div className="alt-row">
          <span className="alt-name">污泥回流 / 排泥</span>
          <span className="alt-score">
            {snap.controls.rasRatio.toFixed(2)}×Q · {(snap.controls.wasRatio * 100).toFixed(2)}%
          </span>
        </div>
        <div className="alt-row">
          <span className="alt-name">污泥龄 / F/M</span>
          <span className="alt-score">
            {snap.srtDays.toFixed(1)} d · {snap.fmRatio.toFixed(3)}
          </span>
        </div>
        <div className="alt-row">
          <span className="alt-name">二沉池泥位 / SLR</span>
          <span className="alt-score">
            {snap.clarifier.blanketM.toFixed(2)} m · {snap.clarifier.slr.toFixed(1)}
          </span>
        </div>
      </div>
    </div>
  );
}

function DownloadButton({ url, filename, label }: { url: string; filename: string; label: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'error'>('idle');
  const download = async () => {
    setState('busy');
    try {
      const token = (() => {
        try {
          return window.sessionStorage.getItem('aquapilot_token');
        } catch {
          return null;
        }
      })();
      const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!res.ok) throw new Error(`${res.status}`);
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = filename;
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
    <button className="download-btn" onClick={() => void download()} disabled={state === 'busy'}>
      {state === 'error' ? '导出失败，重试' : state === 'busy' ? '导出中…' : label}
    </button>
  );
}

function BenchRow({
  label,
  ai,
  manual,
  delta,
  good,
}: {
  label: string;
  ai: string;
  manual: string;
  delta: string;
  good: boolean;
}) {
  return (
    <div className="bench-row">
      <span className="bench-name">{label}</span>
      <span className="bench-ai">{ai}</span>
      <span className="bench-manual">{manual}</span>
      <span className="bench-delta" data-good={good}>
        {delta}
      </span>
    </div>
  );
}

function Metric({
  label,
  actual,
  unit,
  baseline,
  delta,
  better,
}: {
  label: string;
  actual: string;
  unit: string;
  baseline: string;
  delta: number;
  better: 'lower' | 'higher';
}) {
  const good = better === 'lower' ? delta > 0 : delta < 0;
  return (
    <div className="compare-cell">
      <div className="compare-label">{label}</div>
      <div className="compare-actual">
        {actual}
        <span>{unit}</span>
      </div>
      <div className="compare-foot">
        <span>基准 {baseline}</span>
        <span className="compare-delta" data-good={good}>
          {delta > 0 ? '↓' : '↑'} {Math.abs(delta).toFixed(1)}%
        </span>
      </div>
    </div>
  );
}
