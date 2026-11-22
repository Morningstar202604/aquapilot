import { formatClock } from '../../shared/time';

/**
 * WP7 资产面板（只读）。
 *
 * 面板只吃集成方传入的数据，不自行请求 API、不读全局状态；
 * 数据形状与 `src/server/routes/assets.ts` 的 `/api/assets` 响应一致。
 * 接线（挂到页签）由集成方在 App.tsx / tabNav.ts 完成。
 */

type AssetStatus = 'running' | 'standby' | 'fault' | 'maintenance' | 'esd_tripped';

interface AssetRow {
  id: string;
  name: string;
  category: string;
  unitName: string;
  isStandby: boolean;
  status: AssetStatus;
  faultCode: string | null;
  health: number;
  availability: number;
  runtimeMin: number;
  activeWorkOrderId: string | null;
}

interface WorkOrderRow {
  id: string;
  assetId: string;
  kind: 'preventive' | 'corrective' | 'emergency';
  status: 'open' | 'in_progress' | 'completed' | 'overdue';
  reason: string;
  overdue: boolean;
  downtimeMin: number;
}

export interface AssetsPanelData {
  summary: {
    total: number;
    running: number;
    standby: number;
    fault: number;
    maintenance: number;
    esdTripped: number;
    avgHealth: number;
    plantAvailability: number;
  };
  esd: { active: boolean; unitId: string | null; triggeredAtMin: number | null };
  assets: AssetRow[];
  workOrders: WorkOrderRow[];
}

const STATUS_LABEL: Record<AssetStatus, string> = {
  running: '运行',
  standby: '备用',
  fault: '故障',
  maintenance: '检修',
  esd_tripped: 'ESD 安全位',
};

const CATEGORY_LABEL: Record<string, string> = {
  pump: '泵',
  blower: '风机',
  mixer: '搅拌器',
  scraper: '刮泥机',
  thickener: '浓缩机',
  dewatering: '脱水机',
  dosing_pump: '加药泵',
};

const ORDER_STATUS_LABEL: Record<WorkOrderRow['status'], string> = {
  open: '待派工',
  in_progress: '检修中',
  completed: '已完工',
  overdue: '逾期',
};

function healthTone(health: number): 'good' | 'watch' | 'risk' {
  return health >= 70 ? 'good' : health >= 40 ? 'watch' : 'risk';
}

export function AssetsPanel({ data }: { data: AssetsPanelData | undefined }) {
  if (!data || data.summary.total === 0) {
    return (
      <div className="scroll-panel">
        <div className="section-label">资产与运维</div>
        <div className="empty-note">当前拓扑尚未派生设备台账（资产子系统未启用或拓扑无转动设备）。</div>
      </div>
    );
  }

  const { summary, esd, assets, workOrders } = data;
  const openOrders = workOrders.filter((w) => w.status !== 'completed');

  return (
    <div className="scroll-panel">
      <div>
        <div className="section-label">资产总览</div>
        <div className="health-block" data-grade={healthTone(summary.avgHealth)}>
          <div className="health-head">
            <span className="health-score">{summary.avgHealth}</span>
            <span className="health-label">平均健康度</span>
            <span className="health-part-detail">
              可用率 {(summary.plantAvailability * 100).toFixed(0)}% · 共 {summary.total} 台
            </span>
          </div>
          <div className="health-parts">
            <div className="health-part">
              <span className="health-part-name">运行 {summary.running}</span>
            </div>
            <div className="health-part">
              <span className="health-part-name">备用 {summary.standby}</span>
            </div>
            <div className="health-part">
              <span className="health-part-name" style={{ color: 'var(--alarm)' }}>
                故障 {summary.fault}
              </span>
            </div>
            <div className="health-part">
              <span className="health-part-name">检修 {summary.maintenance}</span>
            </div>
            <div className="health-part">
              <span className="health-part-name" style={{ color: 'var(--alarm)' }}>
                ESD {summary.esdTripped}
              </span>
            </div>
          </div>
        </div>
      </div>

      {esd.active && (
        <div className="alarm-row" data-sev="critical">
          <div className="alarm-meta">
            <span style={{ color: 'var(--alarm)' }}>ESD 已触发</span>
            {esd.unitId && <span className="alarm-unit">单元 {esd.unitId}</span>}
            {esd.triggeredAtMin !== null && <span>{formatClock(esd.triggeredAtMin)}</span>}
          </div>
          <div className="alarm-text">全部相关设备已进入安全位并锁存，需显式复位后方可恢复。</div>
        </div>
      )}

      <div>
        <div className="section-label">设备台账（{assets.length}）</div>
        <table className="analysis-table">
          <thead>
            <tr>
              <th>设备</th>
              <th>类别 / 单元</th>
              <th>状态</th>
              <th>健康度</th>
              <th>当前工单</th>
              <th>可用率</th>
              <th>运行时数</th>
            </tr>
          </thead>
          <tbody>
            {assets.map((a) => (
              <tr key={a.id} data-status={a.status}>
                <td>
                  {a.name}
                  {a.isStandby && <span className="alarm-unit">（备机）</span>}
                </td>
                <td>
                  {CATEGORY_LABEL[a.category] ?? a.category} · {a.unitName}
                </td>
                <td>
                  {STATUS_LABEL[a.status]}
                  {a.faultCode && <div className="alarm-why">{a.faultCode}</div>}
                </td>
                <td>
                  <span className="health-part-track">
                    <span
                      data-grade={healthTone(a.health)}
                      style={{ width: `${Math.max(0, Math.min(100, a.health))}%` }}
                    />
                  </span>{' '}
                  {a.health}
                </td>
                <td>{a.activeWorkOrderId ?? '—'}</td>
                <td>{(a.availability * 100).toFixed(0)}%</td>
                <td>{(a.runtimeMin / 60).toFixed(1)} h</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <div className="section-label">检修工单（未闭环 {openOrders.length}）</div>
        {openOrders.length === 0 ? (
          <div className="empty-note">当前没有未闭环工单。</div>
        ) : (
          openOrders.map((w) => (
            <div className="alarm-row" key={w.id} data-sev={w.overdue ? 'critical' : 'warning'}>
              <div className="alarm-meta">
                <span>{w.id}</span>
                <span>{ORDER_STATUS_LABEL[w.status]}</span>
                {w.overdue && <span style={{ color: 'var(--alarm)' }}>逾期</span>}
              </div>
              <div className="alarm-text">{w.reason}</div>
              {w.downtimeMin > 0 && <div className="alarm-why">停机 {Math.round(w.downtimeMin)} min</div>}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
