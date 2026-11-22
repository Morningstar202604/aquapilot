import { useCallback, useState } from 'react';
import { formatClock } from '../../shared/time';
import { fetchJson } from './industrial/http';
import { usePolling } from './industrial/usePolledJson';

/**
 * WP8 协议通道面板（只读）。
 *
 * 数据来自三个只读端点：
 * - `GET /api/protocols/tags`    标签表（地址 / 类型 / 单位 / 量程 / 读写策略）；
 * - `GET /api/protocols/status`  各通道连接状态；
 * - `GET /api/protocols/audit`   最近写入审计（成功 / 拒绝 / 超时 / 未知标签 / 断开）。
 *
 * 本页对接的是进程内模拟服务器：点表、量程与状态均为仿真口径，未接现场 PLC。
 */

interface TagRow {
  id: string;
  label: string;
  dataType: string;
  unit: string;
  access: 'read' | 'write';
  scale: { rawPerUnit: number; unitMin: number; unitMax: number };
  address: { opcua: string; modbusRegister: number; mqtt: string };
  description: string;
}

interface ChannelRow {
  protocol: string;
  state: 'connecting' | 'connected' | 'degraded' | 'disconnected';
  reconnectAttempts: number;
  lastError?: string;
  connectedAt?: string;
}

interface AuditRow {
  seq: number;
  at: string;
  atMin: number;
  actor: string;
  role: string;
  protocol: string;
  tag: string;
  address: string;
  requestedValue: number | boolean | string | null;
  result: 'success' | 'denied' | 'timeout' | 'unknown_tag' | 'disconnected';
  reason: string;
  code?: string;
}

interface ProtocolsBody {
  tags: TagRow[];
  channels: ChannelRow[];
  audit: AuditRow[];
  total: number;
}

type LoadState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; body: ProtocolsBody };

interface Props {
  token?: string | null;
  pollMs?: number;
}

const PROTOCOL_LABEL: Record<string, string> = {
  opcua: 'OPC UA',
  modbus: 'Modbus TCP',
  mqtt: 'MQTT',
};

const STATE_LABEL: Record<ChannelRow['state'], string> = {
  connected: '已连接',
  degraded: '降级运行',
  disconnected: '断开',
  connecting: '连接中',
};

const RESULT_LABEL: Record<AuditRow['result'], string> = {
  success: '成功',
  denied: '拒绝',
  timeout: '超时',
  unknown_tag: '未知标签',
  disconnected: '断开',
};

function formatValue(v: AuditRow['requestedValue']): string {
  if (v === null) return '—';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

export function ProtocolsPanel({ token, pollMs = 30_000 }: Props) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  const load = useCallback(async () => {
    try {
      const [tagsRes, statusRes, auditRes] = await Promise.all([
        fetchJson<{ tags: TagRow[] }>('/api/protocols/tags', token),
        fetchJson<{ channels: ChannelRow[] }>('/api/protocols/status', token),
        fetchJson<{ audit: AuditRow[]; total: number }>('/api/protocols/audit', token),
      ]);
      setState({
        kind: 'ready',
        body: {
          tags: tagsRes.tags ?? [],
          channels: statusRes.channels ?? [],
          audit: auditRes.audit ?? [],
          total: auditRes.total ?? 0,
        },
      });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, [token]);

  usePolling(load, pollMs);

  if (state.kind === 'loading') {
    return (
      <div className="scroll-panel">
        <div className="empty-note">正在拉取协议通道状态…</div>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="scroll-panel">
        <div className="section-label">协议通道</div>
        <div className="alarm-row" data-sev="warning">
          <div className="alarm-meta">
            <span style={{ color: 'var(--alarm)' }}>通道数据不可用</span>
          </div>
          <div className="alarm-text">{state.message}</div>
        </div>
      </div>
    );
  }

  const { tags, channels, audit, total } = state.body;

  return (
    <div className="scroll-panel">
      <div className="control-hint" style={{ marginBottom: 10 }}>
        模拟服务器，未接现场 PLC：点表、量程与连接状态均为仿真口径，不代表现场实时链路。
      </div>

      <div>
        <div className="section-label">通道状态（{channels.length}）</div>
        {channels.length === 0 ? (
          <div className="empty-note">当前没有注册的协议通道。</div>
        ) : (
          <table className="analysis-table">
            <thead>
              <tr>
                <th>协议</th>
                <th>状态</th>
                <th>重连次数</th>
                <th>备注</th>
              </tr>
            </thead>
            <tbody>
              {channels.map((c) => (
                <tr key={c.protocol} data-status={c.state}>
                  <td>{PROTOCOL_LABEL[c.protocol] ?? c.protocol}</td>
                  <td style={{ color: c.state === 'disconnected' ? 'var(--alarm)' : undefined }}>
                    {STATE_LABEL[c.state]}
                  </td>
                  <td>{c.reconnectAttempts}</td>
                  <td>{c.lastError ?? (c.connectedAt ? `接通于 ${c.connectedAt}` : '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div>
        <div className="section-label">标签表（{tags.length}）</div>
        {tags.length === 0 ? (
          <div className="empty-note">标签映射表为空。</div>
        ) : (
          <table className="analysis-table">
            <thead>
              <tr>
                <th>标签</th>
                <th>地址（OPC UA）</th>
                <th>类型</th>
                <th>单位</th>
                <th>量程</th>
                <th>读写策略</th>
              </tr>
            </thead>
            <tbody>
              {tags.map((t) => (
                <tr key={t.id} title={t.description}>
                  <td>{t.label}</td>
                  <td>{t.address.opcua}</td>
                  <td>{t.dataType}</td>
                  <td>{t.unit || '—'}</td>
                  <td>
                    {t.scale.unitMin}–{t.scale.unitMax} {t.unit}
                  </td>
                  <td>{t.access === 'read' ? '只读' : '可写'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div>
        <div className="section-label">
          最近写审计（{audit.length} / 共 {total}）
        </div>
        {audit.length === 0 ? (
          <div className="empty-note">最近没有写入审计记录。</div>
        ) : (
          audit.map((entry) => (
            <div
              className="alarm-row"
              key={entry.seq}
              data-sev={entry.result === 'denied' || entry.result === 'disconnected' ? 'critical' : 'warning'}
            >
              <div className="alarm-meta">
                <span>#{entry.seq}</span>
                <span>{PROTOCOL_LABEL[entry.protocol] ?? entry.protocol}</span>
                <span>{entry.atMin >= 0 ? formatClock(entry.atMin) : entry.at.slice(11, 19)}</span>
                <span className="alarm-unit">{entry.actor}</span>
              </div>
              <div className="alarm-text">
                {entry.tag} = {formatValue(entry.requestedValue)} · {RESULT_LABEL[entry.result]}
                {entry.reason ? `：${entry.reason}` : ''}
              </div>
              {entry.code && <div className="alarm-why">{entry.code}</div>}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
