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
import { layoutTopology } from '../../model/layout';
import { alignNodes, distributeNodes, type AlignMode } from '../hooks/editorSelection';
import { deleteUnits, moveUnitsTo, setRoute } from '../../model/topologyEdit';
import { streamColor, streamLabel as streamName, unitKindAccent } from '../../shared/streamMeta';
import { PlantCanvas } from './PlantCanvas';
import type { PlantSnapshot, TopologyVersionSummary } from '../../shared/protocol';

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
  /** 外部（App 的 Delete 快捷键）需要知道当前选中项 */
  selectedId?: string | null;
  onSelectedChange?: (id: string | null) => void;
  /** 多选集合受控（App 的批量删除要拿到全部选中项）；不传则本地管理 */
  selectionIds?: string[];
  onSelectionChange?: (ids: string[]) => void;
  /** 服务端拓扑版本（回滚用）；不传则不显示「版本」页 */
  versions?: TopologyVersionSummary[];
  onRequestVersions?: () => void;
  onRevertVersion?: (revision: number) => void;
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
  chemical: ['pacDose', 'carbonDose', 'alkDose'],
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

export function ProcessEditor({
  snap,
  topology,
  onChange,
  onApply,
  dirty,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  selectedId,
  onSelectedChange,
  selectionIds,
  onSelectionChange,
  versions,
  onRequestVersions,
  onRevertVersion,
}: Props) {
  const [internalSelected, setInternalSelected] = useState<string | null>(null);
  /**
   * 选中项可以是外部受控（App 的 Delete 快捷键要用），也可以是本地状态。
   * 两者同步：外部给了就用外部，否则用内部，任何变化都回调出去。
   */
  const selected = selectedId !== undefined ? selectedId : internalSelected;
  const setSelected = (id: string | null) => {
    setInternalSelected(id);
    onSelectedChange?.(id);
  };
  const [internalSelection, setInternalSelection] = useState<string[]>([]);
  const selection = selectionIds ?? internalSelection;
  const setSelection = (ids: string[]) => {
    setInternalSelection(ids);
    onSelectionChange?.(ids);
  };
  const [pane, setPane] = useState<'inspector' | 'connections' | 'check' | 'versions'>('inspector');
  const [connectMode, setConnectMode] = useState<{ fromUnit: string; port: string; stream: StreamKind } | null>(null);

  const issues = useMemo(() => validateTopology(topology), [topology]);
  const hasPositions = Object.keys(topology.positions ?? {}).length > 0;
  const hasRoutes = Object.keys(topology.routes ?? {}).length > 0;
  const dirtyLayout = hasPositions || hasRoutes;
  const readiness = useMemo(() => checkRunReadiness(topology, snap.influent.flow), [topology, snap.influent.flow]);

  const selectedUnit = selected ? findUnit(topology, selected) : undefined;
  const errors = issues.filter((i) => i.severity === 'error');

  const addUnit = (entry: PaletteEntry, pos?: { x: number; y: number }) => {
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
    const isBio = entry.kind === 'aerobic' || entry.kind === 'anoxic' || entry.kind === 'anaerobic';
    const next: ProcessTopology = {
      ...topology,
      units: [...topology.units, unit],
      train: isBio ? [...topology.train, id] : topology.train,
      // 拖拽落点即新单元坐标；点选添加则沿用自动布局
      positions: pos ? { ...(topology.positions ?? {}), [id]: pos } : topology.positions,
    };
    /**
     * 生物池自动接入主序列。
     *
     * 拖一个池子进来却要手工画两条线才算"能用"，是实测里最劝退的一步。
     * 规则：把新池插到主序列末端（train 最后一项）与它原有下游之间——
     * 例如 好氧C → 二沉池 变成 好氧C → 新池 → 二沉池，两条边一次接好。
     * 其它类型（斜管、风机、加药等）保持独立，由用户自己连，避免乱接线。
     */
    if (isBio) {
      const lastId = topology.train[topology.train.length - 1];
      const lastUnit = lastId ? findUnit(topology, lastId) : undefined;
      const outPort = lastUnit?.ports.find((p) => p.kind === 'out' && p.stream === 'mixed_liquor');
      const inPort = unit.ports.find(
        (p) => p.kind === 'in' && (p.stream === 'mixed_liquor' || p.stream === 'influent'),
      );
      const newOut = unit.ports.find((p) => p.kind === 'out' && p.stream === 'mixed_liquor');
      if (lastUnit && outPort && inPort && newOut) {
        const downstream = topology.connections.find(
          (c) => c.from.unit === lastId && c.from.port === outPort.id && !c.recycle,
        );
        next.connections = topology.connections.map((c) =>
          downstream && c.id === downstream.id ? { ...c, from: { unit: id, port: newOut.id } } : c,
        );
        next.connections.push({
          id: `c-${lastId}-${id}`,
          from: { unit: lastId, port: outPort.id },
          to: { unit: id, port: inPort.id },
          stream: inPort.stream,
        });
        // downstream 边已经在上面改写为「新池 → 原下游」，这里不能再补一条，
        // 否则同一对端口会出现两条边（DUPLICATE_LINK）。
      }
    }
    onChange(next);
    setSelected(id);
    setPane('inspector');
  };

  const removeUnit = (id: string) => {
    onChange(deleteUnits(topology, [id]));
    if (selected === id) setSelected(null);
  };

  /**
   * 批量删除选中单元。
   *
   * 之前 Del 只删最后一个选中项，理由是"批量删除需要逐个确认下游接线"；
   * 但拓扑校验与「应用到仿真」的 readiness 已经把住关，删除动作本身
   * 只该遵守一条规则：整步可撤销。详见 model/topologyEdit。
   */
  const removeSelected = (ids: string[]) => {
    if (ids.length === 0) return;
    onChange(deleteUnits(topology, ids));
    setSelection([]);
    setSelected(null);
    setPane('inspector');
  };

  const updateUnit = (id: string, patch: Partial<UnitSpec>) => {
    onChange({
      ...topology,
      units: topology.units.map((u) => (u.id === id ? { ...u, ...patch } : u)),
    });
  };

  /**
   * 从组件库拖到画布：落点换算成图纸坐标。
   *
   * 用的是 HTML5 drag，和 SolidWorks / Aspen 的「从库里拖设备」一致；
   * 坐标减去画布原点后除以缩放比，再吸附到 14px 网格，保证对齐不歪。
   */
  const dropUnit = (e: React.DragEvent<HTMLDivElement>) => {
    const kind = e.dataTransfer.getData('application/x-aquapilot-unit') as UnitKind;
    if (!kind) return;
    const entry = PALETTE.find((p) => p.kind === kind);
    if (!entry) return;
    e.preventDefault();
    const stage = e.currentTarget.getBoundingClientRect();
    const wrap = e.currentTarget.querySelector('.canvas-wrap');
    const scaler = e.currentTarget.querySelector('.canvas-scaler') as HTMLElement | null;
    const scale = scaler ? Number((scaler.style.transform.match(/scale\(([\d.]+)\)/) ?? [])[1] ?? 1) : 1;
    const x = Math.max(0, Math.round(((e.clientX - stage.left + (wrap?.scrollLeft ?? 0)) / scale - 60) / 14) * 14);
    const y = Math.max(0, Math.round(((e.clientY - stage.top + (wrap?.scrollTop ?? 0)) / scale - 30) / 14) * 14);
    addUnit(entry, { x, y });
  };

  /**
   * 多选对齐/分布。
   *
   * 几何计算全在 hooks/editorSelection（纯函数，有单测），这里只负责
   * 把结果合并进拓扑的 positions，走同一条撤销栈。
   */
  const layoutNodes = useMemo(() => layoutTopology(topology, { laneGap: 96 }).nodes, [topology]);
  const applyMoves = (moves: Record<string, { x: number; y: number }>) => {
    if (Object.keys(moves).length === 0) return;
    onChange({ ...topology, positions: { ...(topology.positions ?? {}), ...moves } });
  };
  const alignNodesBy = (mode: AlignMode) => alignNodes(layoutNodes, selection, mode);
  const distributeNodesBy = (axis: 'x' | 'y') => distributeNodes(layoutNodes, selection, axis);

  const beginConnect = (unitId: string, port: string, stream: StreamKind) => {
    setConnectMode({ fromUnit: unitId, port, stream });
    setPane('connections');
  };

  /**
   * 建立一条连线（点击与拖拽共用的唯一实现）。
   *
   * 从出口点连线时，物流类型取「目标入口要求的类型」而不是源端口的类型：
   * 好氧池出口是 mixed_liquor、接二沉池入口没问题；二沉池的 ras 出口接
   * 厌氧池 ras 入口也对。真正会出错的是两者类型不同——那时应拒绝，而不是
   * 偷偷造一条下游校验必然失败的边。
   *
   * 为什么抽成独立函数：拖拽路径在同一个事件里既开始又结束，
   * 若复用 setConnectMode 的异步状态，闭包里读到的还是 null（实测拖拽连不上）。
   */
  const addConnection = (fromUnit: string, fromPort: string, toUnit: string, toPort: string): boolean => {
    if (fromUnit === toUnit) return false;
    const targetUnit = findUnit(topology, toUnit);
    const targetPort = targetUnit?.ports.find((p) => p.id === toPort && p.kind === 'in');
    if (!targetPort) return false;
    const exists = topology.connections.some(
      (c) => c.from.unit === fromUnit && c.from.port === fromPort && c.to.unit === toUnit && c.to.port === toPort,
    );
    if (exists) return false;
    const conn = {
      id: `c-${fromUnit}-${toUnit}-${Date.now().toString(36).slice(-4)}`,
      from: { unit: fromUnit, port: fromPort },
      to: { unit: toUnit, port: toPort },
      stream: targetPort.stream,
      recycle:
        targetPort.stream === 'internal_recycle' ||
        targetPort.stream === 'return_activated_sludge' ||
        targetPort.stream === 'waste_sludge',
    };
    onChange({ ...topology, connections: [...topology.connections, conn] });
    return true;
  };

  const completeConnect = (unitId: string, port: string) => {
    if (!connectMode) return;
    addConnection(connectMode.fromUnit, connectMode.port, unitId, port);
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
              <button
                className="palette-item"
                key={entry.kind + entry.name}
                onClick={() => addUnit(entry)}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/x-aquapilot-unit', entry.kind);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                title="点击添加，或拖到画布上放置"
              >
                <span className="palette-glyph" style={{ borderColor: unitKindAccent(entry.kind) }} />
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
          {selection.length > 1 && (
            <span className="pill" data-tone="amber" data-active>
              已选 {selection.length} 个
            </span>
          )}
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
          {dirtyLayout && (
            <button
              className="pill"
              title="把手工摆放的坐标与折点清空，回到自动分层布局与自动走线"
              onClick={() => {
                const { positions: _drop, routes: _routes, ...rest } = topology;
                onChange(rest);
              }}
            >
              自动排列
            </button>
          )}
          <button className="pill" data-active={readiness.ready} onClick={onApply} disabled={!readiness.ready}>
            应用到仿真
          </button>
          <button
            className="pill"
            title="删除选中的全部单元（可撤销）"
            aria-label="批量删除"
            disabled={selection.length === 0 && !selected}
            onClick={() => removeSelected(selection.length > 0 ? selection : selected ? [selected] : [])}
          >
            删除选中
          </button>
          {selection.length >= 2 && (
            <span className="editor-align-group" role="group" aria-label="对齐">
              <button
                className="pill"
                title="左对齐"
                aria-label="左对齐"
                onClick={() => applyMoves(alignNodesBy('left'))}
              >
                左对齐
              </button>
              <button
                className="pill"
                title="顶部对齐"
                aria-label="顶部对齐"
                onClick={() => applyMoves(alignNodesBy('top'))}
              >
                顶对齐
              </button>
              <button
                className="pill"
                title="右对齐"
                aria-label="右对齐"
                onClick={() => applyMoves(alignNodesBy('right'))}
              >
                右对齐
              </button>
              <button
                className="pill"
                title="底部对齐"
                aria-label="底部对齐"
                onClick={() => applyMoves(alignNodesBy('bottom'))}
              >
                底对齐
              </button>
              {selection.length >= 3 && (
                <>
                  <button
                    className="pill"
                    title="水平等距"
                    aria-label="水平等距"
                    onClick={() => applyMoves(distributeNodesBy('x'))}
                  >
                    横等距
                  </button>
                  <button
                    className="pill"
                    title="垂直等距"
                    aria-label="垂直等距"
                    onClick={() => applyMoves(distributeNodesBy('y'))}
                  >
                    竖等距
                  </button>
                </>
              )}
              <button
                className="pill"
                title="取消多选（Esc）"
                aria-label="取消多选"
                onClick={() => setSelection(selected ? [selected] : [])}
              >
                取消
              </button>
            </span>
          )}
        </div>

        <div className="editor-hint-bar" role="note">
          拖动移动 · Shift 点选多个 · 空白处拖框选 · 点出口→点入口连线 · 方向键微调 · Del 删除 · Ctrl+Z 撤销
        </div>
        {dirty && (
          <div className="draft-banner">
            拓扑已修改但尚未应用。运行中的厂仍是旧拓扑；点「应用到仿真」会以当前拓扑重建厂并重跑预热。
          </div>
        )}

        <div
          className="editor-canvas"
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('application/x-aquapilot-unit')) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
            }
          }}
          onDrop={dropUnit}
        >
          <EditorCanvas
            topology={topology}
            snap={snap}
            selected={selected}
            selection={selection}
            onSelectionChange={(ids) => {
              setSelection(ids);
              setSelected(ids[ids.length - 1] ?? null);
            }}
            onSelect={(id) => {
              setSelected(id);
              setSelection(id ? [id] : []);
            }}
            connectMode={connectMode}
            onCancelConnect={() => setConnectMode(null)}
            invalidIds={new Set(errors.map((e) => e.unitId).filter(Boolean) as string[])}
            onChange={onChange}
            onBeginConnect={(unitId, portId) => {
              const unit = findUnit(topology, unitId);
              const port = unit?.ports.find((p) => p.id === portId);
              if (!port) return;
              setConnectMode({ fromUnit: unitId, port: portId, stream: port.stream });
            }}
            onCompleteConnect={(unitId, portId) => completeConnect(unitId, portId)}
            onAddConnection={(fromUnit, fromPort, toUnit, toPort) => addConnection(fromUnit, fromPort, toUnit, toPort)}
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
  onChange,
  onBeginConnect,
  onCompleteConnect,
  selection,
  onSelectionChange,
  onAddConnection,
}: {
  topology: ProcessTopology;
  snap: PlantSnapshot;
  selected: string | null;
  onSelect: (id: string | null) => void;
  connectMode: { fromUnit: string; port: string; stream: StreamKind } | null;
  onCancelConnect: () => void;
  invalidIds: Set<string>;
  onChange: (topo: ProcessTopology) => void;
  onBeginConnect: (unitId: string, portId: string) => void;
  onCompleteConnect: (unitId: string, portId: string) => void;
  selection: string[];
  onSelectionChange: (ids: string[]) => void;
  /** 拖拽连线：与点击路径共用父层的 addConnection */
  onAddConnection: (fromUnit: string, fromPort: string, toUnit: string, toPort: string) => boolean;
}) {
  const moveUnit = (id: string, x: number, y: number) => {
    onChange(moveUnitsTo(topology, { [id]: { x, y } }));
  };
  const moveUnits = (moves: Record<string, { x: number; y: number }>) => {
    onChange(moveUnitsTo(topology, moves));
  };
  return (
    <div className="editor-stage">
      <PlantCanvas
        snap={snap}
        topo={topology}
        selected={selected}
        onSelect={onSelect}
        fit="flow"
        editable
        selection={selection}
        onSelectionChange={onSelectionChange}
        onMoveUnit={moveUnit}
        onMoveUnits={moveUnits}
        onRouteChange={(connectionId, points) => onChange(setRoute(topology, connectionId, points))}
        connectFrom={connectMode ? { unitId: connectMode.fromUnit, portId: connectMode.port } : null}
        onPortClick={(unitId, portId, kind) => {
          if (connectMode) {
            if (kind === 'in') onCompleteConnect(unitId, portId);
            else onBeginConnect(unitId, portId);
            return;
          }
          if (kind === 'out') onBeginConnect(unitId, portId);
        }}
        onPortDragConnect={(from, to) => onAddConnection(from.unitId, from.portId, to.unitId, to.portId)}
      />
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
