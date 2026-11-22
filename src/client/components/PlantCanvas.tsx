import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  ViewportPortal,
  useNodesState,
  useReactFlow,
  type Connection,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { layoutTopology, portAnchors, type Layout } from '../../model/layout';
import { STREAM_LEGEND_ORDER, STREAM_META, streamColor, streamLabel } from '../../shared/streamMeta';
import { PLANT_TOPOLOGY, type ProcessTopology, type StreamKind } from '../../model/topology';
import type { PlantSnapshot } from '../../shared/protocol';
import type { ControlSettings } from '../../sim/config';
import { PlantEdge, type PlantFlowEdge } from './PlantEdge';
import { PlantNode, type PlantFlowNode, type TankHistoryPoint } from './PlantNode';

export type { TankHistoryPoint } from './PlantNode';

interface Props {
  snap: PlantSnapshot;
  topo?: ProcessTopology;
  selected: string | null;
  onSelect: (id: string | null) => void;
  showLabels?: boolean;
  showRecycle?: boolean;
  compact?: boolean;
  /** 'fill'：撑满容器（监视视图）；'flow'：按图纸尺寸绘制，由外层滚动（编排视图） */
  fit?: 'fill' | 'flow' | 'adaptive';
  /** 编排模式：节点可拖动、端口可见并可点选连线 */
  editable?: boolean;
  /** 拖动结束回调（图纸坐标）；不传则不可拖 */
  onMoveUnit?: (id: string, x: number, y: number) => void;
  /** 多选集合；不传时退回单选 selected */
  selection?: string[];
  onSelectionChange?: (ids: string[]) => void;
  /** 多选拖动：一次提交多个单元的新坐标 */
  onMoveUnits?: (moves: Record<string, { x: number; y: number }>) => void;
  /** 各反应器的 DO/MLSS/NH₄ 滚动历史（客户端逐帧积累）：单元框内画迷你趋势线 */
  tankHistory?: Record<string, TankHistoryPoint[]>;
  /** 点端口的回调：first=起点，second=终点 */
  onPortClick?: (unitId: string, portId: string, kind: 'in' | 'out') => void;
  /** 拖拽连线：从出口圆点拖到入口圆点松手即完成 */
  onPortDragConnect?: (from: { unitId: string; portId: string }, to: { unitId: string; portId: string }) => void;
  connectFrom?: { unitId: string; portId: string } | null;
  /** 人工折点提交：points=null 表示恢复自动走线 */
  onRouteChange?: (connectionId: string, points: { x: number; y: number }[] | null) => void;
}

const nodeTypes = { plant: PlantNode };
const edgeTypes = { plant: PlantEdge };

export function PlantCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <FlowCanvas {...props} />
    </ReactFlowProvider>
  );
}

/** 顺序敏感的 id 集合比较；选择集合很小，不做 Set 分配 */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function FlowCanvas({
  snap,
  topo = PLANT_TOPOLOGY,
  selected,
  onSelect,
  showLabels = true,
  showRecycle = true,
  compact,
  fit = 'fill',
  editable = false,
  onMoveUnit,
  onPortClick,
  onPortDragConnect,
  connectFrom = null,
  selection,
  onSelectionChange,
  onMoveUnits,
  onRouteChange,
  tankHistory,
}: Props) {
  const selectionIds = useMemo(() => selection ?? (selected ? [selected] : []), [selection, selected]);
  const rf = useReactFlow<PlantFlowNode, PlantFlowEdge>();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [fitToWindow, setFitToWindow] = useState(() =>
    typeof window === 'undefined' ? true : window.innerWidth > 900,
  );
  const [snapTarget, setSnapTarget] = useState<{ unitId: string; portId: string } | null>(null);
  /**
   * 大标题只属于「真正缩得很小」的全览，而不是 fitToWindow 这个模式标记。
   *
   * 桌面 1920 宽下 fitView 的实际缩放约 0.8–0.9；此时 24px 标题会顶出
   * 22px 的卡片标题栏，盖住下面的 role/流量。按实际缩放判断后，1:1、
   * 83% 全览都用正常 11.5px 标题，只有缩到 62% 以下才切换成大标题。
   */
  const compactView = compact === true || viewport.zoom < 0.62;

  const adaptiveLaneGap = compact ? 76 : 96;
  const layout = useMemo(
    () => layoutTopology(topo, { compact, laneGap: adaptiveLaneGap, maxRowWidth: undefined }),
    [topo, compact, adaptiveLaneGap],
  );
  const visibleEdges = useMemo(
    () => layout.edges.filter((e) => showRecycle || !e.connection.recycle),
    [layout.edges, showRecycle],
  );

  const suppressPortClick = useRef(false);
  const portDragRef = useRef<{
    from: { unitId: string; portId: string };
    x: number;
    y: number;
    moved: boolean;
    snap: { unitId: string; portId: string } | null;
  } | null>(null);

  const handlePortClick = (unitId: string, portId: string, kind: 'in' | 'out') => {
    if (suppressPortClick.current) {
      suppressPortClick.current = false;
      return;
    }
    onPortClick?.(unitId, portId, kind);
  };

  const startPortDrag = (unitId: string, portId: string, e: React.PointerEvent<HTMLDivElement>) => {
    portDragRef.current = { from: { unitId, portId }, x: e.clientX, y: e.clientY, moved: false, snap: null };
  };

  /** 选择集合与父层/上次同步值一致时不回写，避免受控 selection 自激循环 */
  const syncSelection = (next: string[]): void => {
    if (!onSelectionChange) return;
    if (sameIds(next, selectionIds) || sameIds(next, lastEmittedSelection.current)) return;
    lastEmittedSelection.current = next;
    onSelectionChange(next);
  };

  const pick = (id: string, additive: boolean) => {
    if (!editable) {
      onSelect(selected === id ? null : id);
      return;
    }
    let next: string[];
    if (additive) next = selectionIds.includes(id) ? selectionIds.filter((x) => x !== id) : [...selectionIds, id];
    else next = selectionIds.length > 1 && selectionIds.includes(id) ? selectionIds : [id];
    if (onSelectionChange) syncSelection(next);
    else onSelect(next[0] ?? null);
  };

  const dataRef = useRef({
    snap,
    selectionIds,
    showLabels,
    compactView,
    editable,
    connectFrom,
    snapTarget,
    tankHistory,
    onPick: pick,
    onPortClick: handlePortClick,
    onPortDragStart: startPortDrag,
  });
  dataRef.current = {
    snap,
    selectionIds,
    showLabels,
    compactView,
    editable,
    connectFrom,
    snapTarget,
    tankHistory,
    onPick: pick,
    onPortClick: handlePortClick,
    onPortDragStart: startPortDrag,
  };

  const [nodes, setNodes, onNodesChange] = useNodesState<PlantFlowNode>([]);
  /** 上一次已同步给父层的选择：防止 React Flow 的受控回写触发循环 */
  const lastEmittedSelection = useRef<string[]>([]);

  useEffect(() => {
    const current = dataRef.current;
    const unitState = Object.fromEntries(current.snap.tanks.map((t) => [t.id, t]));
    setNodes(
      layout.nodes.map((node) => ({
        id: node.unit.id,
        type: 'plant' as const,
        position: { x: node.x, y: node.y },
        width: node.w,
        height: node.h,
        measured: { width: node.w, height: node.h },
        style: { width: node.w, height: node.h },
        selected: current.selectionIds.includes(node.unit.id),
        data: {
          node,
          snap: current.snap,
          selected: current.selectionIds.includes(node.unit.id),
          multiSelected: current.selectionIds.length > 1 && current.selectionIds.includes(node.unit.id),
          showLabel: current.showLabels,
          compactView: current.compactView,
          editable: current.editable,
          liveTank: unitState[node.unit.id],
          history: current.tankHistory?.[node.unit.id],
          connectFrom: current.connectFrom,
          snapTarget: current.snapTarget,
          onPick: current.onPick,
          onPortClick: current.onPortClick,
          onPortDragStart: current.onPortDragStart,
        },
      })),
    );
  }, [layout, setNodes]);

  useEffect(() => {
    const current = dataRef.current;
    const unitState = Object.fromEntries(current.snap.tanks.map((t) => [t.id, t]));
    setNodes((prev) =>
      prev.map((node) => ({
        ...node,
        selected: current.selectionIds.includes(node.id),
        data: {
          ...node.data,
          snap: current.snap,
          selected: current.selectionIds.includes(node.id),
          multiSelected: current.selectionIds.length > 1 && current.selectionIds.includes(node.id),
          showLabel: current.showLabels,
          compactView: current.compactView,
          editable: current.editable,
          liveTank: unitState[node.id],
          history: current.tankHistory?.[node.id],
          connectFrom: current.connectFrom,
          snapTarget: current.snapTarget,
          onPick: current.onPick,
          onPortClick: current.onPortClick,
          onPortDragStart: current.onPortDragStart,
        },
      })),
    );
  }, [snap, selectionIds, showLabels, compactView, editable, connectFrom, snapTarget, tankHistory, setNodes]);

  const edges = useMemo(
    () =>
      visibleEdges.map((edge): PlantFlowEdge => {
        const meta = STREAM_META[edge.connection.stream];
        return {
          id: edge.connection.id,
          source: edge.connection.from.unit,
          target: edge.connection.to.unit,
          sourceHandle: `out:${edge.connection.from.port}`,
          targetHandle: `in:${edge.connection.to.port}`,
          type: 'plant',
          data: {
            stream: edge.connection.stream,
            straight: edge.straight,
            points: topo.routes?.[edge.connection.id] ?? [],
            animate: !snap.paused,
            showLabel: showLabels,
            duration: pulseDuration(edge.connection.stream, snap.controls),
            obstacles: layout.nodes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h })),
          },
          style: {
            stroke: meta.color,
            strokeWidth: meta.width,
            strokeDasharray: meta.dash,
          },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: meta.color,
            width: 12,
            height: 12,
          },
        };
      }),
    [visibleEdges, topo.routes, snap.paused, snap.controls, showLabels, layout.nodes],
  );

  const onConnect = (connection: Connection) => {
    const fromPort = connection.sourceHandle?.replace(/^out:/, '');
    const toPort = connection.targetHandle?.replace(/^in:/, '');
    if (!fromPort || !toPort) return;
    onPortDragConnect?.({ unitId: connection.source, portId: fromPort }, { unitId: connection.target, portId: toPort });
  };

  const onDragStop = () => {
    const selectedNodes = rf.getNodes().filter((n) => n.selected || selectionIds.includes(n.id));
    const moves = Object.fromEntries(
      selectedNodes.map((n) => [n.id, { x: Math.round(n.position.x), y: Math.round(n.position.y) }]),
    );
    if (Object.keys(moves).length === 0) return;
    if (onMoveUnits) onMoveUnits(moves);
    else if (onMoveUnit) {
      for (const [id, p] of Object.entries(moves)) onMoveUnit(id, p.x, p.y);
    }
  };

  const updateViewport = (vp: Viewport) => {
    setViewport(vp);
    const wrap = wrapRef.current;
    if (!wrap) return;
    wrap.setAttribute('data-x', `${Math.round(vp.x)}`);
    wrap.setAttribute('data-y', `${Math.round(vp.y)}`);
    wrap.setAttribute('data-zoom', `${vp.zoom}`);
  };

  return (
    <div
      className={`canvas-viewport flow-canvas${editable ? ' flow-editor-canvas' : ''}`}
      data-fit={fitToWindow ? 'true' : 'false'}
    >
      <div className="canvas-zoom-controls" role="group" aria-label="画布缩放">
        <button
          onClick={() => {
            setFitToWindow(false);
            void rf.zoomOut({ duration: 120 });
          }}
          aria-label="缩小"
        >
          −
        </button>
        <span>{Math.round(viewport.zoom * 100)}%</span>
        <button
          onClick={() => {
            setFitToWindow(false);
            void rf.zoomIn({ duration: 120 });
          }}
          aria-label="放大"
        >
          +
        </button>
        <button
          onClick={() => {
            setFitToWindow(false);
            void rf.zoomTo(1, { duration: 120 });
          }}
          aria-label="实际尺寸"
          data-active={!fitToWindow}
        >
          1:1
        </button>
        <button
          onClick={() => {
            setFitToWindow(true);
            void rf.fitView({ padding: 0.12, duration: 160 });
          }}
          aria-label="适应窗口"
          data-active={fitToWindow}
        >
          全览
        </button>
      </div>
      <div className={fit === 'flow' ? 'canvas-legend canvas-legend-flow' : 'canvas-legend'}>
        <span className="canvas-legend-title">物流图例</span>
        {STREAM_LEGEND_ORDER.map((st) => (
          <span className="canvas-legend-item" key={st}>
            <svg width="18" height="8" aria-hidden="true">
              <line
                x1="0"
                y1="4"
                x2="18"
                y2="4"
                stroke={streamColor(st)}
                strokeWidth={Math.max(1.4, STREAM_META[st].width)}
                strokeDasharray={STREAM_META[st].dash}
              />
            </svg>
            {streamLabel(st)}
          </span>
        ))}
      </div>
      <div
        className="canvas-wrap"
        ref={wrapRef}
        data-fit={fitToWindow ? 'true' : 'false'}
        data-flow-edges={edges.length}
        onPointerMove={(e) => {
          const drag = portDragRef.current;
          if (!drag) return;
          if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) >= 6) drag.moved = true;
          const rect = wrapRef.current?.getBoundingClientRect();
          const zoom = viewport.zoom || 1;
          const fx = (e.clientX - (rect?.left ?? 0) - viewport.x) / zoom;
          const fy = (e.clientY - (rect?.top ?? 0) - viewport.y) / zoom;
          let nearest: { unitId: string; portId: string; d: number } | null = null;
          for (const node of layout.nodes) {
            for (const a of portAnchors(node)) {
              if (a.kind !== 'in' || (a.port.id === drag.from.portId && node.unit.id === drag.from.unitId)) continue;
              const d = Math.hypot(a.x - fx, a.y - fy);
              if (d <= 16 && (!nearest || d < nearest.d)) nearest = { unitId: node.unit.id, portId: a.port.id, d };
            }
          }
          drag.snap = nearest ? { unitId: nearest.unitId, portId: nearest.portId } : null;
          setSnapTarget(drag.snap);
        }}
        onPointerUp={(e) => {
          const drag = portDragRef.current;
          if (!drag) return;
          portDragRef.current = null;
          setSnapTarget(null);
          if (!drag.moved) return;
          const hit = document.elementFromPoint?.(e.clientX, e.clientY) ?? null;
          const dot = hit instanceof Element ? hit.closest('.port-dot[data-kind="in"]') : null;
          const unitId = drag.snap?.unitId ?? dot?.getAttribute('data-unit');
          const portId = drag.snap?.portId ?? dot?.getAttribute('data-port');
          if (!unitId || !portId || unitId === drag.from.unitId) return;
          suppressPortClick.current = true;
          onPortDragConnect?.(drag.from, { unitId, portId });
        }}
        onPointerCancel={() => {
          portDragRef.current = null;
          setSnapTarget(null);
        }}
      >
        <ReactFlow<PlantFlowNode, PlantFlowEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onConnect={onConnect}
          onNodeClick={(e, node) => {
            if (!editable) return;
            pick(node.id, e.shiftKey);
          }}
          onSelectionEnd={() => {
            // 只在框选结束时回写，不在每次受控 setNodes 后回写：后者会与
            // React Flow 的受控 store 形成 setState 自激循环（实测 React #185）。
            if (!editable) return;
            syncSelection(
              rf
                .getNodes()
                .filter((n) => n.selected)
                .map((n) => n.id),
            );
          }}
          onNodeDragStop={onDragStop}
          onPaneClick={() => {
            if (!editable) return;
            if (onSelectionChange) syncSelection([]);
            else onSelect(null);
          }}
          onMove={(_, vp) => updateViewport(vp)}
          onInit={(instance) => {
            if (fit === 'fill' || (typeof window !== 'undefined' && window.innerWidth > 900)) {
              void instance.fitView({ padding: 0.12, duration: 0 });
            } else {
              void instance.setViewport({ x: 0, y: 0, zoom: 1 });
            }
          }}
          nodesDraggable={editable}
          nodesConnectable={editable}
          elementsSelectable={editable}
          panOnDrag={editable ? [1, 2] : true}
          selectionOnDrag={editable}
          selectionMode={SelectionMode.Partial}
          multiSelectionKeyCode="Shift"
          deleteKeyCode={null}
          minZoom={0.35}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          className={fit === 'flow' ? 'plant-canvas-flow' : undefined}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--line-soft)" />
          {layout.lanes.length > 0 && (
            <ViewportPortal>
              {layout.lanes.map((lane, i) => (
                <div
                  key={lane.layer}
                  className="canvas-lane"
                  style={{
                    left: 18,
                    top: lane.y - 16,
                    width: Math.max(320, layout.width - 36),
                    borderTopStyle: i === 0 ? 'solid' : 'dashed',
                  }}
                >
                  <span className="canvas-lane-label">{lane.label}</span>
                </div>
              ))}
            </ViewportPortal>
          )}
          {fit === 'flow' && !fitToWindow && (
            <MiniMap
              pannable
              zoomable
              nodeColor="#0c9d7e"
              maskColor="rgba(12,30,26,0.12)"
              style={{ width: 148, height: 74 }}
            />
          )}
        </ReactFlow>
        {editable && onRouteChange && (
          <RouteHandles
            layout={layout}
            edges={visibleEdges}
            routes={topo.routes}
            viewport={viewport}
            onRouteChange={onRouteChange}
          />
        )}
      </div>
    </div>
  );
}

function RouteHandles({
  layout,
  edges,
  routes,
  viewport,
  onRouteChange,
}: {
  layout: Layout;
  edges: Layout['edges'];
  routes?: Record<string, { x: number; y: number }[]>;
  viewport: Viewport;
  onRouteChange: (connectionId: string, points: { x: number; y: number }[] | null) => void;
}) {
  return (
    <div className="flow-route-overlay" aria-hidden="true">
      {edges.map((edge) => {
        const points = routes?.[edge.connection.id] ?? [];
        const source = layout.nodes.find((n) => n.unit.id === edge.connection.from.unit);
        const target = layout.nodes.find((n) => n.unit.id === edge.connection.to.unit);
        const fallback =
          source && target
            ? { x: (source.x + source.w + target.x) / 2, y: (source.y + source.h / 2 + target.y + target.h / 2) / 2 }
            : { x: 0, y: 0 };
        return (
          <RouteHandle
            key={edge.connection.id}
            connectionId={edge.connection.id}
            point={points[0] ?? fallback}
            hasRoute={points.length > 0}
            viewport={viewport}
            onRouteChange={onRouteChange}
          />
        );
      })}
    </div>
  );
}

function RouteHandle({
  connectionId,
  point,
  hasRoute,
  viewport,
  onRouteChange,
}: {
  connectionId: string;
  point: { x: number; y: number };
  hasRoute: boolean;
  viewport: Viewport;
  onRouteChange: (connectionId: string, points: { x: number; y: number }[] | null) => void;
}) {
  const dragRef = useRef<{ x: number; y: number; origin: { x: number; y: number } } | null>(null);
  const [preview, setPreview] = useState<{ x: number; y: number } | null>(null);
  const shown = preview ?? point;
  const screen = { x: shown.x * viewport.zoom + viewport.x, y: shown.y * viewport.zoom + viewport.y };

  return (
    <div className="route-layer">
      <div
        className="route-handle"
        data-connection={connectionId}
        data-index="0"
        title={hasRoute ? '拖动调整折点' : '拖动生成折点'}
        style={{ transform: `translate(-50%, -50%) translate(${screen.x}px, ${screen.y}px)` }}
        onPointerDown={(e) => {
          e.stopPropagation();
          dragRef.current = { x: e.clientX, y: e.clientY, origin: point };
          setPreview(point);
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            /* happy-dom 没有指针捕获 */
          }
        }}
        onPointerMove={(e) => {
          const drag = dragRef.current;
          if (!drag) return;
          setPreview({
            x: Math.round(drag.origin.x + (e.clientX - drag.x) / (viewport.zoom || 1)),
            y: Math.round(drag.origin.y + (e.clientY - drag.y) / (viewport.zoom || 1)),
          });
        }}
        onPointerUp={(e) => {
          const drag = dragRef.current;
          if (!drag) return;
          dragRef.current = null;
          onRouteChange(connectionId, [
            {
              x: Math.round(drag.origin.x + (e.clientX - drag.x) / (viewport.zoom || 1)),
              y: Math.round(drag.origin.y + (e.clientY - drag.y) / (viewport.zoom || 1)),
            },
          ]);
          setPreview(null);
        }}
        onPointerCancel={() => {
          dragRef.current = null;
          setPreview(null);
        }}
      />
      {hasRoute && (
        <div
          className="route-reset"
          title="恢复自动走线"
          style={{ transform: `translate(-50%, -50%) translate(${screen.x + 10}px, ${screen.y - 10}px)` }}
          onClick={(e) => {
            e.stopPropagation();
            onRouteChange(connectionId, null);
          }}
        >
          ×
        </div>
      )}
    </div>
  );
}

/**
 * 流速感应：回流/加药管线的流速由对应控制量决定，动画周期随之变化。
 * 基准周期 2.4s；scale>1 更快、<1 更慢，钳制在 0.9–4s。
 */
function pulseDuration(stream: StreamKind, controls: ControlSettings): number {
  const base = 2.4;
  let scale: number;
  switch (stream) {
    case 'return_activated_sludge':
      scale = Math.max(0.2, controls.rasRatio / 0.8);
      break;
    case 'waste_sludge':
      scale = Math.max(0.2, controls.wasRatio / 0.0085);
      break;
    case 'internal_recycle':
      scale = Math.max(0.2, controls.internalRecirc / 2);
      break;
    case 'air':
      scale = Math.max(0.3, controls.doSetpoint / 2);
      break;
    case 'chemical':
      scale = Math.max(0.2, controls.pacDose / 40);
      break;
    default:
      scale = 1;
  }
  return Math.min(4, Math.max(0.9, base / scale));
}
