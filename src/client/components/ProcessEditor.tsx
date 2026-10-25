import { useMemo, useState } from 'react';
import {
  PLANT_TOPOLOGY,
  ProcessTopology,
  StreamKind,
  UnitKind,
  UnitSpec,
  validateTopology,
  TopologyIssue,
  findUnit,
  deriveTrain,
} from '../../model/topology';
import { checkRunReadiness } from '../../sim/topologyEngine';
import { PlantCanvas } from './PlantCanvas';
import type { PlantSnapshot } from '../../shared/protocol';

interface Props {
  snap: PlantSnapshot;
  topology: ProcessTopology;
  onChange: (topo: ProcessTopology) => void;
  onApply: () => void;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}

interface PaletteEntry {
  kind: UnitKind;
  name: string;
  role: string;
  group: string;
  ports: { id: string; kind: 'in' | 'out'; stream: StreamKind }[];
  volume?: number;
  area?: number;
  depth?: number;
}

const PALETTE: PaletteEntry[] = [
  {
    group: '预处理',
    kind: 'screening',
    name: '格栅',
    role: '拦截',
    ports: [
      { id: 'in', kind: 'in', stream: 'influent' },
      { id: 'out', kind: 'out', stream: 'influent' },
    ],
  },
  {
    group: '预处理',
    kind: 'grit',
    name: '沉砂池',
    role: '除砂',
    ports: [
      { id: 'in', kind: 'in', stream: 'influent' },
      { id: 'out', kind: 'out', stream: 'influent' },
    ],
  },
  {
    group: '预处理',
    kind: 'primary',
    name: '初沉池',
    role: '去悬浮物',
    volume: 2400,
    area: 900,
    depth: 3.2,
    ports: [
      { id: 'in', kind: 'in', stream: 'influent' },
      { id: 'out', kind: 'out', stream: 'influent' },
      { id: 'sludge', kind: 'out', stream: 'waste_sludge' },
    ],
  },
  {
    group: '生物处理',
    kind: 'anaerobic',
    name: '厌氧池',
    role: '释磷',
    volume: 3000,
    ports: [
      { id: 'in', kind: 'in', stream: 'influent' },
      { id: 'ras', kind: 'in', stream: 'return_activated_sludge' },
      { id: 'out', kind: 'out', stream: 'mixed_liquor' },
    ],
  },
  {
    group: '生物处理',
    kind: 'anoxic',
    name: '缺氧池',
    role: '反硝化',
    volume: 4500,
    ports: [
      { id: 'in', kind: 'in', stream: 'mixed_liquor' },
      { id: 'ir', kind: 'in', stream: 'internal_recycle' },
      { id: 'out', kind: 'out', stream: 'mixed_liquor' },
    ],
  },
  {
    group: '生物处理',
    kind: 'aerobic',
    name: '好氧池',
    role: '硝化',
    volume: 5000,
    ports: [
      { id: 'in', kind: 'in', stream: 'mixed_liquor' },
      { id: 'out', kind: 'out', stream: 'mixed_liquor' },
      { id: 'air', kind: 'in', stream: 'air' },
      { id: 'chem', kind: 'in', stream: 'chemical' },
    ],
  },
  {
    group: '固液分离',
    kind: 'clarifier',
    name: '二沉池',
    role: '泥水分离',
    area: 3600,
    depth: 4.5,
    ports: [
      { id: 'in', kind: 'in', stream: 'mixed_liquor' },
      { id: 'out', kind: 'out', stream: 'effluent' },
      { id: 'ras', kind: 'out', stream: 'return_activated_sludge' },
      { id: 'was', kind: 'out', stream: 'waste_sludge' },
    ],
  },
  {
    group: '固液分离',
    kind: 'disinfection',
    name: '消毒池',
    role: '灭活',
    volume: 1800,
    ports: [
      { id: 'in', kind: 'in', stream: 'effluent' },
      { id: 'out', kind: 'out', stream: 'effluent' },
    ],
  },
  {
    group: '调蓄',
    kind: 'storage',
    name: '调蓄池',
    role: '削峰',
    volume: 16000,
    ports: [
      { id: 'in', kind: 'in', stream: 'influent' },
      { id: 'out', kind: 'out', stream: 'influent' },
    ],
  },
  {
    group: '公用工程',
    kind: 'blower',
    name: '鼓风机房',
    role: '供氧',
    ports: [{ id: 'air', kind: 'out', stream: 'air' }],
  },
  {
    group: '公用工程',
    kind: 'chemical',
    name: '加药间',
    role: '加药',
    ports: [{ id: 'chem', kind: 'out', stream: 'chemical' }],
  },
  {
    group: '污泥',
    kind: 'thickener',
    name: '浓缩池',
    role: '减容',
    area: 320,
    depth: 4,
    ports: [
      { id: 'in', kind: 'in', stream: 'waste_sludge' },
      { id: 'out', kind: 'out', stream: 'waste_sludge' },
    ],
  },
  {
    group: '污泥',
    kind: 'dewatering',
    name: '脱水机房',
    role: '出泥',
    ports: [
      { id: 'in', kind: 'in', stream: 'waste_sludge' },
      { id: 'out', kind: 'out', stream: 'sludge_cake' },
    ],
  },
];

const INTERVENTION_BY_KIND: Partial<Record<UnitKind, UnitSpec['interventions']>> = {
  anaerobic: [],
  anoxic: ['carbonDose'],
  aerobic: ['doSetpoint', 'pacDose', 'alkDose'],
  clarifier: ['rasRatio', 'wasRatio'],
  storage: ['stormStore'],
  blower: ['aerationOn'],
  chemical: ['pacDose', 'carbonDose', 'alkDose'],
  screening: ['pumpSpeed'],
};

const STATE_BY_KIND: Partial<Record<UnitKind, string[]>> = {
  anaerobic: ['cod', 'nh', 'no3', 'tp', 'do', 'mlss', 'alk'],
  anoxic: ['cod', 'nh', 'no3', 'tp', 'do', 'mlss', 'alk'],
  aerobic: ['cod', 'nh', 'no3', 'tp', 'do', 'mlss', 'alk'],
  clarifier: ['blanket', 'xRas', 'xEff', 'slr'],
  disinfection: ['cod', 'nh', 'tp', 'ss'],
  storage: ['volume'],
  blower: ['airflow'],
  chemical: ['pac', 'carbon', 'alk'],
};

function nextId(topo: ProcessTopology, kind: UnitKind): string {
  let i = 1;
  while (topo.units.some((u) => u.id === `${kind}${i}`)) i += 1;
  return `${kind}${i}`;
}

export function ProcessEditor({ snap, topology, onChange, onApply, dirty, canUndo, canRedo, onUndo, onRedo }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [pane, setPane] = useState<'inspector' | 'connections' | 'check'>('inspector');
  const [connectMode, setConnectMode] = useState<{ fromUnit: string; port: string; stream: StreamKind } | null>(null);

  const issues = useMemo(() => validateTopology(topology), [topology]);
  const readiness = useMemo(() => checkRunReadiness(topology, snap.influent.flow), [topology, snap.influent.flow]);

  const selectedUnit = selected ? findUnit(topology, selected) : undefined;
  const errors = issues.filter((i) => i.severity === 'error');

  const addUnit = (entry: PaletteEntry) => {
    const id = nextId(topology, entry.kind);
    const unit: UnitSpec = {
      id,
      kind: entry.kind,
      name: entry.name,
      role: entry.role,
      volume: entry.volume,
      area: entry.area,
      depth: entry.depth,
      ports: entry.ports.map((p, i) => ({ ...p, order: i })),
      states: STATE_BY_KIND[entry.kind],
      interventions: INTERVENTION_BY_KIND[entry.kind],
    };
    const next: ProcessTopology = {
      ...topology,
      units: [...topology.units, unit],
      train:
        entry.kind === 'aerobic' || entry.kind === 'anoxic' || entry.kind === 'anaerobic'
          ? [...topology.train, id]
          : topology.train,
    };
    onChange(next);
    setSelected(id);
    setPane('inspector');
  };

  const removeUnit = (id: string) => {
    const next: ProcessTopology = {
      ...topology,
      units: topology.units.filter((u) => u.id !== id),
      connections: topology.connections.filter((c) => c.from.unit !== id && c.to.unit !== id),
      train: topology.train.filter((t) => t !== id),
    };
    onChange(next);
    if (selected === id) setSelected(null);
  };

  const updateUnit = (id: string, patch: Partial<UnitSpec>) => {
    onChange({
      ...topology,
      units: topology.units.map((u) => (u.id === id ? { ...u, ...patch } : u)),
    });
  };

  const beginConnect = (unitId: string, port: string, stream: StreamKind) => {
    setConnectMode({ fromUnit: unitId, port, stream });
    setPane('connections');
  };

  const completeConnect = (unitId: string, port: string) => {
    if (!connectMode) return;
    if (connectMode.fromUnit === unitId) {
      setConnectMode(null);
      return;
    }
    const conn = {
      id: `c-${connectMode.fromUnit}-${unitId}-${Date.now().toString(36).slice(-4)}`,
      from: { unit: connectMode.fromUnit, port: connectMode.port },
      to: { unit: unitId, port },
      stream: connectMode.stream,
      recycle:
        connectMode.stream === 'internal_recycle' ||
        connectMode.stream === 'return_activated_sludge' ||
        connectMode.stream === 'waste_sludge',
    };
    onChange({ ...topology, connections: [...topology.connections, conn] });
    setConnectMode(null);
  };

  const removeConnection = (id: string) => {
    onChange({ ...topology, connections: topology.connections.filter((c) => c.id !== id) });
  };

  const moveTrain = (id: string, dir: -1 | 1) => {
    const idx = topology.train.indexOf(id);
    if (idx < 0) return;
    const next = [...topology.train];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    onChange({ ...topology, train: next });
  };

  return (
    <div className="editor">
      <div className="editor-palette">
        {['预处理', '生物处理', '固液分离', '调蓄', '公用工程', '污泥'].map((group) => (
          <div key={group}>
            <div className="palette-group-title">{group}</div>
            {PALETTE.filter((p) => p.group === group).map((entry) => (
              <button className="palette-item" key={entry.kind + entry.name} onClick={() => addUnit(entry)}>
                <span className="palette-glyph" style={{ borderColor: glyphColor(entry.kind) }} />
                <span className="palette-name">{entry.name}</span>
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="editor-main">
        <div className="editor-toolbar">
          <span className="pill" data-tone={dirty ? 'amber' : undefined}>
            <span className="dot" data-tone={dirty ? 'amber' : undefined} />
            {dirty ? '草稿未应用' : '与运行中一致'}
          </span>
          <span className="pill">
            {topology.units.length} 单元 · {topology.connections.length} 物流
          </span>
          <span className="pill">{errors.length} 错误</span>
          <span className="toolbar-spacer" />
          {connectMode && (
            <span className="pill" data-tone="amber">
              从 {findUnit(topology, connectMode.fromUnit)?.name}.{connectMode.port} 连线中 · 点目标端口
              <button style={{ marginLeft: 6, color: 'inherit' }} onClick={() => setConnectMode(null)}>
                取消
              </button>
            </span>
          )}

          <button className="pill" onClick={onUndo} disabled={!canUndo} title="撤销上一步编辑（Ctrl/Cmd+Z）">
            ↶ 撤销
          </button>
          <button className="pill" onClick={onRedo} disabled={!canRedo} title="重做（Ctrl/Cmd+Shift+Z）">
            ↷ 重做
          </button>
          <button className="pill" onClick={() => onChange(PLANT_TOPOLOGY)}>
            恢复标准厂
          </button>
          <button className="pill" data-active={readiness.ready} onClick={onApply} disabled={!readiness.ready}>
            应用到仿真
          </button>
        </div>

        {dirty && (
          <div className="draft-banner">
            拓扑已修改但尚未应用。运行中的厂仍是旧拓扑；点「应用到仿真」会以当前拓扑重建厂并重跑预热。
          </div>
        )}

        <div className="editor-canvas">
          <EditorCanvas
            topology={topology}
            snap={snap}
            selected={selected}
            onSelect={setSelected}
            connectMode={connectMode}
            onCancelConnect={() => setConnectMode(null)}
            invalidIds={new Set(errors.map((e) => e.unitId).filter(Boolean) as string[])}
          />
        </div>
      </div>

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
                        value={selectedUnit.volume ?? 0}
                        onChange={(e) => updateUnit(selectedUnit.id, { volume: Number(e.target.value) })}
                      />
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
                        value={selectedUnit.area ?? 0}
                        onChange={(e) => updateUnit(selectedUnit.id, { area: Number(e.target.value) })}
                      />
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
                      <button
                        key={p.id}
                        className="palette-item"
                        onClick={() => completeConnect(selectedUnit.id, p.id)}
                      >
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
    </div>
  );
}

function EditorCanvas({
  topology,
  snap,
  selected,
  onSelect,
  connectMode,
  onCancelConnect,
  invalidIds,
}: {
  topology: ProcessTopology;
  snap: PlantSnapshot;
  selected: string | null;
  onSelect: (id: string | null) => void;
  connectMode: { fromUnit: string; port: string; stream: StreamKind } | null;
  onCancelConnect: () => void;
  invalidIds: Set<string>;
}) {
  return (
    <div className="editor-stage">
      <PlantCanvas snap={snap} topo={topology} selected={selected} onSelect={onSelect} compact fit="adaptive" />
      {invalidIds.size > 0 && (
        <div className="draft-banner" style={{ position: 'absolute', left: 8, top: 8 }}>
          {invalidIds.size} 个单元存在拓扑错误（红框），点「校验」查看原因
        </div>
      )}
      {connectMode && (
        <div className="notice" style={{ position: 'absolute', left: 8, bottom: 8 }}>
          连线模式：点目标单元的入口端口完成 · 源 {connectMode.fromUnit}.{connectMode.port}
          <button style={{ marginLeft: 8, color: 'var(--water)' }} onClick={() => onCancelConnect()}>
            退出
          </button>
        </div>
      )}
    </div>
  );
}

function glyphColor(kind: UnitKind): string {
  if (kind === 'aerobic') return 'var(--cyan)';
  if (kind === 'anaerobic' || kind === 'anoxic') return 'var(--water-dim)';
  if (kind === 'clarifier') return 'var(--amber)';
  if (kind === 'blower') return 'var(--cyan)';
  if (kind === 'chemical') return 'var(--purple-dim, #7a5f8a)';
  return 'var(--text-3)';
}

function streamColor(stream: StreamKind): string {
  switch (stream) {
    case 'influent':
      return 'var(--water)';
    case 'mixed_liquor':
      return 'var(--water-dim)';
    case 'return_activated_sludge':
    case 'waste_sludge':
      return 'var(--amber)';
    case 'internal_recycle':
      return 'var(--cyan)';
    case 'effluent':
      return 'var(--water)';
    case 'air':
      return '#8fd8e8';
    case 'chemical':
      return '#c9a0e8';
    case 'sludge_cake':
      return '#8a6a45';
  }
}

function streamName(stream: StreamKind): string {
  switch (stream) {
    case 'influent':
      return '进水';
    case 'mixed_liquor':
      return '混合液';
    case 'return_activated_sludge':
      return '污泥回流';
    case 'waste_sludge':
      return '剩余污泥';
    case 'internal_recycle':
      return '内回流';
    case 'effluent':
      return '出水';
    case 'air':
      return '空气';
    case 'chemical':
      return '药剂';
    case 'sludge_cake':
      return '泥饼';
  }
}
