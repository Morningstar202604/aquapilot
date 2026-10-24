import type { PlantSnapshot } from '../../shared/protocol';

interface Props {
  snap: PlantSnapshot;
}

export function AlarmsPanel({ snap }: Props) {
  const active = snap.activeAlarms;
  const history = snap.alarms;

  return (
    <div className="scroll-panel">
      <div>
        <div className="section-label">全厂健康度</div>
        <div className="health-block" data-grade={snap.health.grade}>
          <div className="health-head">
            <span className="health-score">{snap.health.score}</span>
            <span className="health-label">
              {snap.health.grade === 'good' ? '运行良好' : snap.health.grade === 'watch' ? '需要关注' : '存在风险'}
            </span>
          </div>
          <div className="health-parts">
            {snap.health.parts.map((p) => (
              <div className="health-part" key={p.label}>
                <span className="health-part-name">{p.label}</span>
                <span className="health-part-track">
                  <span style={{ width: `${Math.max(0, Math.min(100, p.score))}%` }} />
                </span>
                <span className="health-part-detail">{p.detail}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div>
        <div className="section-label">当前活跃（{active.length}）</div>
        {active.length === 0 ? (
          <div className="empty-note">全部受控指标在限值内。</div>
        ) : (
          active.map((a) => {
            const why = snap.alarmAttribution[a.code];
            return (
              <div className="alarm-row" data-sev={a.severity} key={a.id}>
                <div className="alarm-meta">
                  <span style={{ color: a.severity === 'critical' ? 'var(--alarm)' : 'var(--amber)' }}>
                    {a.severity === 'critical' ? '严重' : '预警'}
                  </span>
                  <span>{a.code}</span>
                  {why && <span className="alarm-unit">{why.unit}</span>}
                </div>
                <div className="alarm-text">{a.message}</div>
                {why && (
                  <div className="alarm-why">
                    <div>
                      <span className="alarm-why-key">原因</span>
                      {why.cause}
                    </div>
                    <div>
                      <span className="alarm-why-key">动作</span>
                      {why.action}
                    </div>
                    <div>
                      <span className="alarm-why-key">后果</span>
                      {why.consequence}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <div>
        <div className="section-label">历史记录（{history.length}）</div>
        {history.length === 0 ? (
          <div className="empty-note">本次运行尚未触发告警。</div>
        ) : (
          history.map((a) => (
            <div className="alarm-row" data-sev={a.severity} key={a.id}>
              <div className="alarm-meta">
                <span>{a.id}</span>
                <span>{formatSimTime(a.at)}</span>
                <span style={{ color: a.severity === 'critical' ? 'var(--alarm)' : 'var(--amber)' }}>
                  {a.severity === 'critical' ? '严重' : '预警'}
                </span>
                <span>{a.code}</span>
              </div>
              <div className="alarm-text">{a.message}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function formatSimTime(minutes: number): string {
  const d = Math.floor(minutes / 1440) + 1;
  const h = Math.floor((minutes % 1440) / 60);
  const m = Math.floor(minutes % 60);
  return `D${d} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
