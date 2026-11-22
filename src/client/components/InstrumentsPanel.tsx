import { usePolledJson } from './industrial/usePolledJson';

/**
 * 仪表与联锁只读面板（WP4）。
 *
 * 数据全部来自 `/api/instruments` 与 `/api/control/interlocks`：
 * - 测点表同时给 measured / truth / 质量码，故障时能看到“读数没跟着真值动”；
 * - 联锁表给条件、是否锁存、动作，ESD 与被拒指令审计单列。
 * 只读，不提供任何写操作——写路径仍走 WebSocket 控制指令。
 */

interface Reading {
  sensorId: string;
  unitId?: string;
  variable?: string;
  measured: number | null;
  truth: number | null;
  quality: string;
  reason?: string | null;
  fault?: string;
}

interface InstrumentsData {
  timeMin: number;
  count: number;
  readings: Reading[];
}

interface Interlock {
  conditionId: string;
  active?: boolean;
  latched?: boolean;
  action?: string;
  value?: number | null;
  threshold?: number | null;
}

interface InterlocksData {
  timeMin?: number;
  interlocksEnabled?: boolean;
  interlocks: Interlock[];
  esd?: { active?: boolean; reason?: string | null };
  audit?: { action?: string; detail?: string; atMin?: number }[];
  assetGroups?: { group?: string; availability?: number }[];
}

function num(v: number | null | undefined, digits = 2): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(digits);
}

export interface InstrumentsPanelProps {
  token?: string | null;
  pollMs?: number;
}

export function InstrumentsPanel({ token, pollMs = 30_000 }: InstrumentsPanelProps) {
  const instruments = usePolledJson<InstrumentsData>('/api/instruments', token, pollMs);
  const interlocks = usePolledJson<InterlocksData>('/api/control/interlocks', token, pollMs);

  if (instruments.kind === 'error' || interlocks.kind === 'error') {
    const message = instruments.kind === 'error' ? instruments.message : (interlocks as { message: string }).message;
    return (
      <div className="scroll-panel">
        <div className="section-label">仪表与联锁</div>
        <div className="alarm-row" data-sev="warning">
          <div className="alarm-meta">
            <span style={{ color: 'var(--alarm)' }}>状态不可用</span>
          </div>
          <div className="alarm-text">{message}</div>
        </div>
      </div>
    );
  }

  if (instruments.kind !== 'ready' || interlocks.kind !== 'ready') {
    return (
      <div className="scroll-panel">
        <div className="empty-note">正在拉取仪表与联锁状态…</div>
      </div>
    );
  }

  const inst = instruments.data;
  const ctl = interlocks.data;
  const badCount = inst.readings.filter((r) => r.quality !== 'good').length;
  const latched = ctl.interlocks.filter((i) => i.latched);
  const esdActive = ctl.esd?.active === true;

  return (
    <div className="scroll-panel">
      <div className="section-label">
        仪表（{inst.count} 测点，{badCount} 异常）
        <span className="muted"> · t={num(inst.timeMin, 0)} min</span>
      </div>
      <table className="analysis-table">
        <thead>
          <tr>
            <th>测点</th>
            <th>变量</th>
            <th>测量</th>
            <th>真值</th>
            <th>质量</th>
            <th>故障</th>
          </tr>
        </thead>
        <tbody>
          {inst.readings.slice(0, 30).map((r) => (
            <tr key={r.sensorId} data-quality={r.quality}>
              <td>{r.sensorId}</td>
              <td>{r.variable ?? '—'}</td>
              <td>{num(r.measured)}</td>
              <td>{num(r.truth)}</td>
              <td style={{ color: r.quality === 'good' ? undefined : 'var(--alarm)' }}>{r.quality}</td>
              <td>{r.fault && r.fault !== 'none' ? r.fault : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {inst.readings.length > 30 && <div className="empty-note">仅显示前 30 个测点，完整列表见 /api/instruments</div>}

      <div className="section-label" style={{ marginTop: 16 }}>
        联锁（{latched.length} 锁存）
        <span className="muted">
          {' '}
          · {ctl.interlocksEnabled ? '介入物理路径' : '仅求值不介入'} · ESD {esdActive ? '已触发' : '未触发'}
        </span>
      </div>
      {ctl.interlocks.length === 0 ? (
        <div className="empty-note">当前无联锁条件</div>
      ) : (
        <table className="analysis-table">
          <thead>
            <tr>
              <th>条件</th>
              <th>当前值</th>
              <th>阈值</th>
              <th>动作</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {ctl.interlocks.map((i) => (
              <tr key={i.conditionId} data-latched={i.latched === true}>
                <td>{i.conditionId}</td>
                <td>{num(i.value)}</td>
                <td>{num(i.threshold)}</td>
                <td>{i.action ?? '—'}</td>
                <td style={{ color: i.latched ? 'var(--alarm)' : undefined }}>{i.latched ? '锁存' : '正常'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {ctl.audit && ctl.audit.length > 0 && (
        <>
          <div className="section-label" style={{ marginTop: 16 }}>
            被拒指令 / ESD 审计（{ctl.audit.length} 条）
          </div>
          <ul className="plain-list">
            {ctl.audit.slice(-5).map((a, idx) => (
              <li key={`${a.atMin ?? idx}-${idx}`}>
                {num(a.atMin, 0)} min · {a.action ?? '—'} · {a.detail ?? ''}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
