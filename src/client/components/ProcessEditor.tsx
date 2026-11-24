import { useMemo, useState } from 'react';
import {
  PLANT_TOPOLOGY,
  ProcessTopology,
  StreamKind,
  UnitKind,
  UnitSpec,
  validateTopology,
  findUnit,
} from '../../model/topology';
import { checkRunReadiness } from '../../sim/topologyEngine';
import { layoutTopology } from '../../model/layout';
import { alignNodes, distributeNodes, type AlignMode } from '../hooks/editorSelection';
import { deleteUnits, moveUnitsTo, setRoute } from '../../model/topologyEdit';
import { PALETTE, duplicateTopologyUnit, insertPaletteUnit, type PaletteEntry } from '../../model/editorPalette';
import { EditorPalette } from './EditorPalette';
import { EditorToolbar, type IoNote } from './EditorToolbar';
import { PlantCanvas } from './PlantCanvas';
import { EditorSidePane, type EditorPane } from './EditorSidePane';
import type { PlantSnapshot, TopologyVersionSummary } from '../../shared/protocol';
import { APP_VERSION } from '../../shared/version';
import { MAX_IMPORT_BYTES, exportTopology, importTopology, suggestFileName } from '../../model/topologyExchange';

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
  const [pane, setPane] = useState<EditorPane>('inspector');
  const [connectMode, setConnectMode] = useState<{ fromUnit: string; port: string; stream: StreamKind } | null>(null);

  const issues = useMemo(() => validateTopology(topology), [topology]);
  const hasPositions = Object.keys(topology.positions ?? {}).length > 0;
  const hasRoutes = Object.keys(topology.routes ?? {}).length > 0;
  const dirtyLayout = hasPositions || hasRoutes;
  const readiness = useMemo(() => checkRunReadiness(topology, snap.influent.flow), [topology, snap.influent.flow]);

  const selectedUnit = selected ? findUnit(topology, selected) : undefined;
  const unitIssues = selectedUnit ? issues.filter((i) => i.unitId === selectedUnit.id) : [];
  const errors = issues.filter((i) => i.severity === 'error');

  const addUnit = (entry: PaletteEntry, pos?: { x: number; y: number }) => {
    const result = insertPaletteUnit(topology, entry, pos);
    onChange(result.topology);
    setSelected(result.id);
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
   * 复制单元：同规格副本（含 states/interventions），位置右下偏移 40px，
   * 生物池自动进主序列末尾。连线不复制——副本是断开的，由用户自己接线。
   */
  const duplicateUnit = (id: string) => {
    const result = duplicateTopologyUnit(topology, id);
    if (!result) return;
    onChange(result.topology);
    setSelected(result.id);
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
    const scale = Number(wrap?.getAttribute('data-zoom') ?? 1) || 1;
    const tx = Number(wrap?.getAttribute('data-x') ?? 0);
    const ty = Number(wrap?.getAttribute('data-y') ?? 0);
    const x = Math.max(0, Math.round(((e.clientX - stage.left - tx) / scale - 60) / 14) * 14);
    const y = Math.max(0, Math.round(((e.clientY - stage.top - ty) / scale - 30) / 14) * 14);
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

  /**
   * 拓扑导入 / 导出。
   *
   * 导出走 Blob + a[download]，不请求服务端：这份 JSON 就是当前草稿的
   * 完整快照，多一次往返只会引入"导出的和屏幕上的不一致"的风险。
   * 导入先过 `importTopology`（与服务端同一套 sanitize），失败就把原因
   * 显示在工具栏上，绝不让一份坏文件进草稿。
   */
  const [ioNote, setIoNote] = useState<IoNote | null>(null);

  const exportCurrent = () => {
    const json = exportTopology(topology, APP_VERSION);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestFileName(topology.name);
    a.click();
    URL.revokeObjectURL(url);
    setIoNote({ kind: 'ok', text: `已导出 ${topology.units.length} 单元 / ${topology.connections.length} 物流` });
  };

  const importFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // 同一个文件连续选两次不会触发 change，必须清空 value
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      setIoNote({ kind: 'error', text: `文件 ${(file.size / 1024 / 1024).toFixed(1)} MB 超过 2 MB 上限` });
      return;
    }
    void file.text().then((text) => {
      const result = importTopology(text);
      if (!result.ok) {
        setIoNote({ kind: 'error', text: `导入失败：${result.error}` });
        return;
      }
      onChange(result.topology);
      const src = result.meta.appVersion ? `（导出自 v${result.meta.appVersion}）` : '';
      setIoNote({
        kind: 'ok',
        text: `已导入 ${result.topology.units.length} 单元 / ${result.topology.connections.length} 物流${src}，未应用`,
      });
    });
  };

  return (
    <div className="editor">
      <EditorPalette onAdd={addUnit} />

      <div className="editor-main">
        <EditorToolbar
          dirty={dirty}
          units={topology.units.length}
          connections={topology.connections.length}
          errorCount={errors.length}
          ioNote={ioNote}
          onDismissIo={() => setIoNote(null)}
          selectionCount={selection.length}
          hasSelected={Boolean(selected)}
          connectLabel={connectMode ? `${findUnit(topology, connectMode.fromUnit)?.name}.${connectMode.port}` : null}
          onCancelConnect={() => setConnectMode(null)}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={onUndo}
          onRedo={onRedo}
          onRestore={() => onChange(PLANT_TOPOLOGY)}
          onExport={exportCurrent}
          onImport={importFile}
          layoutDirty={dirtyLayout}
          onResetLayout={() => {
            const { positions: _drop, routes: _routes, ...rest } = topology;
            onChange(rest);
          }}
          ready={readiness.ready}
          onApply={onApply}
          onDeleteSelection={() => removeSelected(selection.length > 0 ? selection : selected ? [selected] : [])}
          onAlign={(mode) => applyMoves(alignNodesBy(mode))}
          onDistribute={(axis) => applyMoves(distributeNodesBy(axis))}
          onClearMulti={() => setSelection(selected ? [selected] : [])}
        />

        <div className="editor-hint-bar" role="note">
          拖动移动 · Shift 点选多个 · 空白处拖框选 · 点出口→点入口连线 · 右键/中键拖动画布 · 方向键微调 · Del 删除 ·
          Ctrl+Z 撤销
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

      <EditorSidePane
        pane={pane}
        setPane={setPane}
        topology={topology}
        selectedUnit={selectedUnit}
        unitIssues={unitIssues}
        updateUnit={updateUnit}
        moveTrain={moveTrain}
        duplicateUnit={duplicateUnit}
        removeUnit={removeUnit}
        beginConnect={beginConnect}
        completeConnect={completeConnect}
        removeConnection={removeConnection}
        versions={versions}
        onRequestVersions={onRequestVersions}
        onRevertVersion={onRevertVersion}
        readiness={readiness}
        issues={issues}
      />
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
