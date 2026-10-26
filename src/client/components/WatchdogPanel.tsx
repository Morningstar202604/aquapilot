import type { WatchdogReport } from '../../shared/protocol';

interface Props {
  report: WatchdogReport | null;
}

const TONE: Record<'ok' | 'warn' | 'error', string> = {
  ok: '正常',
  warn: '关注',
  error: '异常',
};

/**
 * 运行自检面板。
 *
 * 对应「派 AI 全程盯着日志和运行情况」这件事：把服务端每 10 秒一次的
 * 确定性检查结果显示出来，异常项直接给出下一步动作，而不是只给一个分数。
 */
export function WatchdogPanel({ report }: Props) {
  if (!report) {
    return (
      <div className="scroll-panel">
        <div className="empty-note">正在等待第一份自检报告…（服务端每 10 秒检查一次）</div>
      </div>
    );
  }
  const bad = report.checks.filter((c) => c.severity !== 'ok');
  return (
    <div className="scroll-panel">
      <div>
        <div className="section-label">运行自检</div>
        <div className="compare-grid">
          <div className="bench">
            <span className="bench-name">总体</span>
            <span className="bench-ai" data-good={report.severity === 'ok'}>
              {TONE[report.severity]}
            </span>
          </div>
          <div className="bench">
            <span className="bench-name">异常项</span>
            <span className="bench-ai" data-good={bad.length === 0}>
              {bad.length}
            </span>
          </div>
          <div className="bench">
            <span className="bench-name">检查项</span>
            <span className="bench-manual">{report.checks.length}</span>
          </div>
          <div className="bench">
            <span className="bench-name">更新时间</span>
            <span className="bench-manual">{new Date(report.at).toLocaleTimeString()}</span>
          </div>
        </div>
      </div>

      <div>
        <div className="section-label">逐项结果</div>
        {report.checks.map((c) => (
          <div className="issue" data-sev={c.severity === 'ok' ? 'info' : c.severity} key={c.id}>
            <span className="issue-code">{TONE[c.severity]}</span>
            <span>
              <b>{c.label}</b>：{c.detail}
              {c.severity !== 'ok' && <div className="control-hint">建议：{c.action}</div>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
