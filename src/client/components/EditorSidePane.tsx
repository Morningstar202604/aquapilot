import { deriveTrain, findUnit, type ProcessTopology, type TopologyIssue, type UnitSpec } from '../../model/topology';
import { checkRunReadiness } from '../../sim/topologyEngine';
import { streamColor, streamLabel as streamName } from '../../shared/streamMeta';
import type { TopologyVersionSummary } from '../../shared/protocol';

export type EditorPane = 'inspector' | 'connections' | 'check' | 'versions';

interface Props {
  pane: EditorPane;
  setPane: (pane: EditorPane) => void;
  topology: ProcessTopology;
  selectedUnit?: UnitSpec;
  unitIssues: TopologyIssue[];
  updateUnit: (id: string, patch: Partial<UnitSpec>) => void;
  moveTrain: (id: string, dir: -1 | 1) => void;
  duplicateUnit: (id: string) => void;
  removeUnit: (id: string) => void;
  beginConnect: (unitId: string, port: string, stream: UnitSpec['ports'][number]['stream']) => void;
  completeConnect: (unitId: string, port: string) => void;
  removeConnection: (id: string) => void;
  versions?: TopologyVersionSummary[];
  onRequestVersions?: () => void;
  onRevertVersion?: (revision: number) => void;
  readiness: ReturnType<typeof checkRunReadiness>;
  issues: TopologyIssue[];
}

/** 拓扑编辑器右侧四个页：属性 / 物流 / 校验 / 版本 */
export function EditorSidePane({
  pane,
  setPane,
  topology,
  selectedUnit,
  unitIssues,
  updateUnit,
  moveTrain,
  duplicateUnit,
  removeUnit,
  beginConnect,
  completeConnect,
  removeConnection,
  versions,
  onRequestVersions,
  onRevertVersion,
  readiness,
  issues,
}: Props) {
  return (
    <div className="editor-side">
      <div className="editor-tabs">
        <button className="editor-tab" data-active={pane === 'inspector'} onClick={() => setPane('inspector')}>
          属性
        </button>
        <button className="editor-tab" data-active={pane === 'connections'} onClick={() => setPane('connections')}>
          物流
        </button>
        <button className="editor-tab" data-active={pane === 'check'} onClick={() => setPane('check')}>
          校验
        </button>
        {onRevertVersion && (
          <button
            className="editor-tab"
            data-active={pane === 'versions'}
            onClick={() => {
              setPane('versions');
              onRequestVersions?.();
            }}
          >
            版本
          </button>
        )}
      </div>

      {pane === 'inspector' && (
        <div className="editor-pane">
          {!selectedUnit ? (
            <div className="empty-note">在画布上点一个单元查看属性</div>
          ) : (
            <>
              <div className="field">
                <label>单元 ID</label>
                <input value={selectedUnit.id} readOnly />
              </div>
              <div className="field">
                <label>显示名称</label>
                <input
                  value={selectedUnit.name}
                  onChange={(e) => updateUnit(selectedUnit.id, { name: e.target.value })}
                />
              </div>
              <div className="field">
                <label>工艺角色</label>
                <input
                  value={selectedUnit.role}
                  onChange={(e) => updateUnit(selectedUnit.id, { role: e.target.value })}
                />
              </div>
              {(selectedUnit.kind === 'aerobic' ||
                selectedUnit.kind === 'anoxic' ||
                selectedUnit.kind === 'anaerobic' ||
                selectedUnit.kind === 'disinfection' ||
                selectedUnit.kind === 'storage' ||
                selectedUnit.kind === 'primary') && (
                <div className="field-row">
                  <div className="field">
                    <label>容积 m³</label>
                    <input
                      type="number"
                      min="1"
                      value={selectedUnit.volume ?? 0}
                      onChange={(e) => updateUnit(selectedUnit.id, { volume: Number(e.target.value) })}
                    />
                    {(selectedUnit.volume ?? 0) <= 0 && (
                      <div className="control-hint" data-warn="true">
                        容积必须大于 0（引擎按容积推进 CSTR）
                      </div>
                    )}
                    {(selectedUnit.volume ?? 0) > 1000000 && (
                      <div className="control-hint" data-warn="true">
                        容积异常大，请确认单位是 m³
                      </div>
                    )}
                  </div>
                  <div className="field">
                    <label>类型</label>
                    <input value={selectedUnit.kind} readOnly />
                  </div>
                </div>
              )}
              {(selectedUnit.kind === 'clarifier' || selectedUnit.kind === 'thickener') && (
                <div className="field-row">
                  <div className="field">
                    <label>面积 m²</label>
                    <input
                      type="number"
                      min="1"
                      value={selectedUnit.area ?? 0}
                      onChange={(e) => updateUnit(selectedUnit.id, { area: Number(e.target.value) })}
                    />
                    {(selectedUnit.area ?? 0) <= 0 && (
                      <div className="control-hint" data-warn="true">
                        面积必须大于 0（二沉池固液分离按面积负荷计算）
                      </div>
                    )}
                  </div>
                  <div className="field">
                    <label>池深 m</label>
                    <input
                      type="number"
                      step="0.1"
                      value={selectedUnit.depth ?? 0}
                      onChange={(e) => updateUnit(selectedUnit.id, { depth: Number(e.target.value) })}
                    />
                  </div>
                </div>
              )}
              {topology.train.includes(selectedUnit.id) && (
                <div className="field">
                  <label>主序列顺序（引擎按此推进）</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn" onClick={() => moveTrain(selectedUnit.id, -1)}>
                      前移
                    </button>
                    <button className="btn" onClick={() => moveTrain(selectedUnit.id, 1)}>
                      后移
                    </button>
                  </div>
                  <div className="control-hint" style={{ marginTop: 4 }}>
                    第 {topology.train.indexOf(selectedUnit.id) + 1} / {topology.train.length} 位
                  </div>
                </div>
              )}

              {unitIssues.length > 0 && (
                <div className="field">
                  <label>本单元校验问题（{unitIssues.length}）</label>
                  {unitIssues.map((iss) => (
                    <div key={iss.code + iss.message} className="unit-issue" data-sev={iss.severity}>
                      {iss.message}
                    </div>
                  ))}
                </div>
              )}
              <button className="btn" onClick={() => duplicateUnit(selectedUnit.id)}>
                复制单元（不复制连线）
              </button>
              <div className="field">
                <label>出口端口（点击开始连线）</label>
                {selectedUnit.ports.filter((p) => p.kind === 'out').length === 0 && (
                  <div className="control-hint">无出口</div>
                )}
                {selectedUnit.ports
                  .filter((p) => p.kind === 'out')
                  .map((p) => (
                    <button
                      key={p.id}
                      className="palette-item"
                      onClick={() => beginConnect(selectedUnit.id, p.id, p.stream)}
                    >
                      <span className="palette-glyph" style={{ borderColor: streamColor(p.stream) }} />
                      <span className="palette-name">
                        {p.id} · {streamName(p.stream)}
                      </span>
                    </button>
                  ))}
              </div>

              <div className="field">
                <label>入口端口（连线时点这里完成）</label>
                {selectedUnit.ports
                  .filter((p) => p.kind === 'in')
                  .map((p) => (
                    <button key={p.id} className="palette-item" onClick={() => completeConnect(selectedUnit.id, p.id)}>
                      <span className="palette-glyph" style={{ borderColor: streamColor(p.stream) }} />
                      <span className="palette-name">
                        {p.id} · {streamName(p.stream)}
                      </span>
                    </button>
                  ))}
              </div>

              <div className="decision-actions">
                <button className="btn" onClick={() => removeUnit(selectedUnit.id)}>
                  删除单元
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {pane === 'connections' && (
        <div className="editor-pane">
          <div className="section-label">全部物流（{topology.connections.length}）</div>
          {topology.connections.map((c) => (
            <div className="conn-row" key={c.id}>
              <span className="conn-text">
                {findUnit(topology, c.from.unit)?.name ?? c.from.unit}.{c.from.port} →{' '}
                {findUnit(topology, c.to.unit)?.name ?? c.to.unit}.{c.to.port}
                <span style={{ color: 'var(--text-3)' }}> · {streamName(c.stream)}</span>
              </span>
              <button className="conn-remove" onClick={() => removeConnection(c.id)} aria-label="删除这条物流">
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {pane === 'versions' && (
        <div className="editor-pane">
          <div className="section-label">拓扑版本（最近 {versions?.length ?? 0} 版）</div>
          {(!versions || versions.length === 0) && (
            <div className="empty-note">还没有版本记录。应用一次拓扑或切换模板后会出现在这里。</div>
          )}
          {versions?.map((v) => (
            <div className="conn-row" key={v.revision} data-version={v.revision}>
              <span className="conn-text">
                v{v.revision} · {v.name}
                <span style={{ color: 'var(--text-3)' }}> · {v.label}</span>
              </span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-3)' }}>
                {v.units} 单元 / {v.connections} 物流
              </span>
              <button
                className="conn-remove"
                style={{ color: 'var(--water)' }}
                onClick={() => onRevertVersion?.(v.revision)}
                aria-label={`回滚到第 ${v.revision} 版`}
                title="以该版本内容创建新版本并重建厂"
              >
                回滚
              </button>
            </div>
          ))}
          <div className="control-hint" style={{ marginTop: 8 }}>
            回滚会以旧版内容创建一个新版本（revision 只增不减），并走与「应用到仿真」相同的校验与预热。
          </div>
        </div>
      )}

      {pane === 'check' && (
        <div className="editor-pane">
          <div className="readiness" data-ready={readiness.ready}>
            <div className="readiness-head">
              <span>{readiness.ready ? '可投入运行' : '不可运行'}</span>
              <span className="sev-tag" data-sev={readiness.ready ? 'normal' : 'critical'}>
                {readiness.blockers.length} 阻断
              </span>
            </div>
            <div className="readiness-metrics">
              <span>
                主序列 <b>{readiness.derived.trainUnits}</b>
              </span>
              <span>
                池容 <b>{(readiness.derived.bioVolume / 1000).toFixed(1)}k m³</b>
              </span>
              <span>
                HRT <b>{readiness.derived.hrtHours.toFixed(1)} h</b>
              </span>
              <span>
                好氧 <b>{(readiness.derived.aerobicVolume / 1000).toFixed(1)}k m³</b>
              </span>
            </div>
          </div>

          {readiness.blockers.map((b, i) => (
            <div className="issue" data-sev="error" key={`b${i}`}>
              <span className="issue-code">阻断</span>
              <span>{b}</span>
            </div>
          ))}
          {readiness.warnings.map((w, i) => (
            <div className="issue" data-sev="warning" key={`w${i}`}>
              <span className="issue-code">提示</span>
              <span>{w}</span>
            </div>
          ))}
          {issues.map((issue: TopologyIssue) => (
            <div
              className="issue"
              data-sev={issue.severity}
              key={issue.code + (issue.unitId ?? '') + (issue.connectionId ?? '')}
            >
              <span className="issue-code">{issue.code}</span>
              <span>{issue.message}</span>
            </div>
          ))}
          {readiness.ready && issues.filter((i) => i.severity === 'error').length === 0 && (
            <div
              className="issue"
              data-sev="warning"
              style={{ borderLeftColor: 'var(--water-dim)', color: 'var(--water)' }}
            >
              <span className="issue-code">OK</span>
              <span>拓扑校验通过，可以应用到仿真。</span>
            </div>
          )}

          <div className="section-label" style={{ marginTop: 14 }}>
            主序列与停留时间
          </div>
          {deriveTrain(topology).map((t) => (
            <div className="conn-row" key={t.spec.id}>
              <span className="conn-text">{t.spec.name}</span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-3)' }}>
                {t.spec.volume ?? 0} m³
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
