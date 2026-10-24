/**
 * 数据导出：把仿真历史转成 CSV / JSON 报告。
 *
 * 为什么放在服务端：导出必须与持久化同一口径（同一个 run、同一批抽样点），
 * 前端自己拼 CSV 会带上只存在于浏览器里的增量状态，事后无法复核。
 *
 * CSV 只做 RFC 4180 所需的最小处理：含逗号、引号、换行的字段加引号，
 * 内部引号翻倍。不做 Excel 公式注入防护以外的扩展——导出内容全部是
 * 数值与本系统生成的中文摘要，不来自外部输入。
 */

import type { DecisionRow, SnapshotRow } from './store';
import type { PlantSnapshot } from '../shared/protocol';

export function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvEscape).join(',')];
  for (const row of rows) lines.push(row.map(csvEscape).join(','));
  // 显式 \r\n：RFC 4180 与 Excel 的默认行为一致
  return `${lines.join('\r\n')}\r\n`;
}

export function snapshotsCsv(rows: SnapshotRow[]): string {
  return toCsv(
    [
      'run_id',
      'at_min',
      'day',
      'clock',
      'effluent_cod_mg_l',
      'effluent_nh_mg_l',
      'effluent_tn_mg_l',
      'effluent_tp_mg_l',
      'effluent_ss_mg_l',
      'mlss_mg_l',
      'srt_d',
      'energy_kw',
      'score',
    ],
    rows.map((r) => {
      const day = Math.floor(r.atMin / 1440) + 1;
      const h = Math.floor((r.atMin % 1440) / 60);
      const m = Math.floor(r.atMin % 60);
      return [
        r.runId ?? '',
        r.atMin,
        day,
        `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
        r.effluentCod,
        r.effluentNh,
        r.effluentTn,
        r.effluentTp,
        r.effluentSs,
        r.mlss,
        r.srtDays,
        r.energyKw,
        r.score,
      ];
    }),
  );
}

export function decisionsCsv(rows: DecisionRow[]): string {
  return toCsv(
    ['run_id', 'at_min', 'action', 'severity', 'summary', 'predicted_score', 'separation', 'tweaks'],
    rows.map((r) => [
      r.runId ?? '',
      r.atMin,
      r.action,
      r.severity,
      r.summary,
      r.predictedScore,
      r.separation,
      r.tweaks,
    ]),
  );
}

/**
 * 单页运行报告（Markdown）。
 *
 * 用途：值班交接、异常复盘、对外演示时一次性拿到「当前状态 + 决策 + 对照」。
 * 所有数字都来自同一份快照，不做二次推算；报告里明确写出采集时刻与数据来源，
 * 避免被当成实时承诺。
 */
export function buildOperationsReport(snap: PlantSnapshot): string {
  const day = Math.floor(snap.timeMin / 1440) + 1;
  const h = Math.floor((snap.timeMin % 1440) / 60);
  const m = Math.floor(snap.timeMin % 60);
  const clock = `D${day} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  const margins = [...snap.margins].sort((a, b) => b.ratio - a.ratio);
  const rec = snap.recommendation;
  const lines: string[] = [];
  lines.push(`# AquaPilot 运行报告 · ${clock}`);
  lines.push('');
  lines.push('> 由 AquaPilot 仿真服务自动生成。数据为仿真状态，不是现场实测。');
  lines.push('');
  lines.push('## 出水水质');
  lines.push('');
  lines.push('| 指标 | 当前值 | 限值 | 占限值 |');
  lines.push('|---|---:|---:|---:|');
  for (const row of margins) {
    lines.push(`| ${row.metric} | ${row.value.toFixed(3)} | ${row.limit} | ${(row.ratio * 100).toFixed(0)}% |`);
  }
  lines.push('');
  lines.push('## 运行状态');
  lines.push('');
  lines.push(`- 处理流量：${snap.influent.flow.toFixed(0)} m³/h（进水 COD ${snap.influent.cod.toFixed(0)} mg/L）`);
  lines.push(
    `- 溶解氧设定：${snap.controls.doSetpoint.toFixed(1)} mg/L；内回流 ${snap.controls.internalRecirc.toFixed(1)}×Q`,
  );
  lines.push(`- 污泥龄：${snap.srtDays.toFixed(1)} d；MLSS 约 ${snap.tanks[0]?.mlss ?? 0} mg/L`);
  lines.push(
    `- 二沉池泥位：${snap.clarifier.blanketM.toFixed(2)} m；固体负荷 ${snap.clarifier.slr.toFixed(1)} kg/(m²·h)`,
  );
  lines.push(
    `- 吨水电耗：${snap.energy.specificKwhM3.toFixed(3)} kWh/m³；今日成本 ¥${snap.cost.totalToday.toFixed(0)}`,
  );
  lines.push('');
  lines.push('## 当前决策');
  lines.push('');
  if (rec) {
    lines.push(`- 动作：${rec.action}（${rec.severity}）`);
    lines.push(`- 摘要：${rec.summary}`);
    lines.push(`- 预测出水评分：${rec.predictedScore}/100`);
    if (rec.tweaks.length) {
      lines.push('- 调整项：');
      for (const t of rec.tweaks) lines.push(`  - ${t.key}: ${t.from} → ${t.to}（${t.reason}）`);
    }
    if (rec.robustEvaluated && rec.ensemble) {
      lines.push(
        `- 不确定性：${rec.ensemble.samples} 组参数扰动，超限概率 ${(rec.ensemble.exceedanceProbability * 100).toFixed(0)}%`,
      );
    }
  } else {
    lines.push('- 尚无决策记录。');
  }
  lines.push('');
  lines.push('## AI / 固定策略双跑');
  lines.push('');
  if (snap.benchmark && snap.benchmark.ai.minutes > 0) {
    const b = snap.benchmark;
    const rate = (s: typeof b.ai) => ((s.compliantMinutes / Math.max(1, s.minutes)) * 100).toFixed(1);
    lines.push('| 指标 | AI 值守 | 固定策略 |');
    lines.push('|---|---:|---:|');
    lines.push(`| 出水合规率 | ${rate(b.ai)}% | ${rate(b.manual)}% |`);
    lines.push(`| 吨水电耗 kWh/m³ | ${b.ai.specificKwhM3.toFixed(3)} | ${b.manual.specificKwhM3.toFixed(3)} |`);
    lines.push(
      `| 平均出水评分 | ${(b.ai.scoreSum / Math.max(1, b.ai.minutes)).toFixed(1)} | ${(b.manual.scoreSum / Math.max(1, b.manual.minutes)).toFixed(1)} |`,
    );
    lines.push('');
    lines.push(`样本 ${Math.round(b.ai.minutes)} 分钟，两条链共享同一 seed 与进水序列。`);
  } else {
    lines.push('影子双跑样本不足。');
  }
  lines.push('');
  return lines.join('\n');
}
