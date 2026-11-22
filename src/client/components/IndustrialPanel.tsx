import { useState } from 'react';
import { AssetsPanel, type AssetsPanelData } from './AssetsPanel';
import { CompliancePanel } from './CompliancePanel';
import { ProtocolsPanel } from './ProtocolsPanel';
import { InstrumentsPanel } from './InstrumentsPanel';
import { usePolledJson } from './industrial/usePolledJson';

/**
 * 「工业」页签容器。
 *
 * 顶栏只加这一个页签，内部再分四块子视图，避免把导航撑爆：
 * - 合规报表：`/api/compliance/report`（WP6）；
 * - 资产台账：`/api/assets`（WP7，复用既有 {@link AssetsPanel}）；
 * - 协议通道：`/api/protocols/tags|status|audit`（WP8）；
 * - 仪表联锁：`/api/instruments`、`/api/control/interlocks`（WP4）。
 *
 * 子视图切换沿用现有 `.pill` 段控件样式，不引外部组件库。
 */

type SubView = 'compliance' | 'assets' | 'protocols' | 'instruments';

const SUB_VIEWS: { id: SubView; label: string }[] = [
  { id: 'compliance', label: '合规报表' },
  { id: 'assets', label: '资产台账' },
  { id: 'protocols', label: '协议通道' },
  { id: 'instruments', label: '仪表联锁' },
];

interface Props {
  /** 仿真时钟上限（分钟），合规报表窗口 to 参数 */
  timeMin: number;
  token?: string | null;
  /** 轮询节拍（ms）；默认 30 s */
  pollMs?: number;
}

/** 资产台账：快照未带 assets 子系统时自行拉 `/api/assets`，再交给只读 AssetsPanel。 */
function AssetsView({ token, pollMs }: { token?: string | null; pollMs: number }) {
  const state = usePolledJson<AssetsPanelData>('/api/assets', token, pollMs);

  if (state.kind === 'loading') {
    return (
      <div className="scroll-panel">
        <div className="empty-note">正在拉取资产台账…</div>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="scroll-panel">
        <div className="section-label">资产台账</div>
        <div className="alarm-row" data-sev="warning">
          <div className="alarm-meta">
            <span style={{ color: 'var(--alarm)' }}>台账数据不可用</span>
          </div>
          <div className="alarm-text">{state.message}</div>
        </div>
      </div>
    );
  }

  return <AssetsPanel data={state.data} />;
}

export function IndustrialPanel({ timeMin, token, pollMs = 30_000 }: Props) {
  const [view, setView] = useState<SubView>('compliance');

  return (
    <div className="scroll-panel">
      <div className="seg-row" role="group" aria-label="工业子视图">
        {SUB_VIEWS.map((v) => (
          <button
            key={v.id}
            className="pill"
            data-active={view === v.id}
            aria-pressed={view === v.id}
            onClick={() => setView(v.id)}
          >
            {v.label}
          </button>
        ))}
      </div>

      {view === 'compliance' && <CompliancePanel timeMin={timeMin} token={token} pollMs={pollMs} />}
      {view === 'assets' && <AssetsView token={token} pollMs={pollMs} />}
      {view === 'protocols' && <ProtocolsPanel token={token} pollMs={pollMs} />}
      {view === 'instruments' && <InstrumentsPanel token={token} pollMs={pollMs} />}
    </div>
  );
}
