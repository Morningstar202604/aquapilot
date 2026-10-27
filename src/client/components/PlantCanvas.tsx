import { useEffect, useMemo, useRef, useState } from 'react';
import { layoutTopology, portAnchors, PlacedEdge, PlacedNode } from '../../model/layout';
import { UNIT_KIND_ICON } from './unitIcons';
import { moveNodes, nodesInRect, nextSelection } from '../hooks/editorSelection';
import { PLANT_TOPOLOGY, StreamKind, UnitKind, ProcessTopology } from '../../model/topology';
import type { PlantSnapshot } from '../../shared/protocol';

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
  /** 点端口的回调：first=起点，second=终点 */
  onPortClick?: (unitId: string, portId: string, kind: 'in' | 'out') => void;
  connectFrom?: { unitId: string; portId: string } | null;
  /** 人工折点提交：points=null 表示恢复自动走线 */
  onRouteChange?: (connectionId: string, points: { x: number; y: number }[] | null) => void;
}

const STREAM_COLOR: Record<StreamKind, string> = {
  // 进水和出水必须可区分：都用水绿色时，操作员在总览图上看不出哪条是原水、
  // 哪条是达标排放。进水用蓝，出水保留水绿。
  influent: '#5b9cf5',
  mixed_liquor: '#2fa88c',
  return_activated_sludge: '#f0a83c',
  waste_sludge: '#a97b3f',
  internal_recycle: '#4fd6e8',
  effluent: '#3ee0b5',
  air: '#8fd8e8',
  chemical: '#c9a0e8',
  sludge_cake: '#8a6a45',
};

const STREAM_WIDTH: Record<StreamKind, number> = {
  influent: 2.6,
  mixed_liquor: 2.4,
  return_activated_sludge: 1.8,
  waste_sludge: 1.4,
  internal_recycle: 1.8,
  effluent: 2.2,
  air: 1,
  chemical: 1.2,
  sludge_cake: 1.2,
};

const STREAM_DASH: Record<StreamKind, string | undefined> = {
  influent: undefined,
  mixed_liquor: undefined,
  return_activated_sludge: '7 5',
  waste_sludge: '5 4',
  internal_recycle: '3 5',
  effluent: undefined,
  air: '2 6',
  chemical: '2 4',
  sludge_cake: '4 4',
};

export function PlantCanvas({
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
  connectFrom = null,
  selection,
  onSelectionChange,
  onMoveUnits,
  onRouteChange,
}: Props) {
  const selectionIds = selection ?? (selected ? [selected] : []);
  const pick = (ids: string[]) => {
    if (onSelectionChange) onSelectionChange(ids);
    else onSelect(ids[0] ?? null);
  };
  const [zoom, setZoom] = useState(1);
  /**
   * 节点拖动状态。
   *
   * 只记录「拖了谁、从哪开始、原始位置」，位移在 pointermove 里换算成图纸
   * 坐标（除以当前缩放比），松手才提交一次——这样撤销栈里是"一次拖拽"，
   * 而不是每帧一条历史。
   */
  const [drag, setDrag] = useState<{
    ids: string[];
    startX: number;
    startY: number;
    /** 拖动开始时的坐标基准：移动只按「基准 + 总位移」算，避免每帧叠加 */
    origins: Record<string, { x: number; y: number }>;
  } | null>(null);
  /**
   * 连线折点拖动。
   *
   * 与节点拖动同一套思路：记住按下时的折点坐标与指针位置，移动时只算总位移，
   * 否则每帧 +14px 会把折点越推越远（节点拖动此前就有这个缺陷）。
   */
  const [routeDrag, setRouteDrag] = useState<{
    connectionId: string;
    index: number;
    origin: { x: number; y: number };
    startX: number;
    startY: number;
  } | null>(null);
  /**
   * 框选。
   *
   * 两个真相：`marqueeRef` 存最新矩形（pointerup 里必须读到本次拖拽的最终值，
   * 用 state 会因为异步更新读到上一帧甚至 null），`marquee` state 只负责画。
   */
  const marqueeRef = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  /**
   * 默认全览。
   *
   * 首屏的第一诉求是"知道全厂长什么样"，而不是"读清某个池的数字"。
   * 1:1 模式保留为细读手段：点「1:1」即可，且可横向滚动。
   */
  /**
   * 默认全览，但窄屏除外。
   *
   * 手机上全览会把整厂压到 19%，文字完全不可读；
   * 窄屏改为 1:1 + 横向滑动，至少能看清当前单元。
   * 平板/笔记本仍用全览：先看清全厂结构，再点 1:1 细读。
   */
  /**
   * 编排视图（fit='flow'）默认 1:1 + 滚动：图纸宽 2000+，全览会压到 40% 看不清；
   * 监视视图才默认全览（首屏先看全厂结构）。
   */
  const [fitToWindow, setFitToWindow] = useState(() => {
    if (fit === 'flow') return false;
    return typeof window === 'undefined' ? true : window.innerWidth > 900;
  });
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [wrapSize, setWrapSize] = useState({ w: 0, h: 0 });
  /**
   * 拖拽平移。
   *
   * 全览模式下图装得下，没有滚动余量；1:1 / 放大后才需要拖。
   * 这里用 pointer 事件手写平移而不是依赖浏览器默认行为：
   * SVG 内部节点自身有点击选中，pointerdown 只在不落在节点上时启动平移，
   * 否则会与「点选单元」冲突。
   */
  const [panning, setPanning] = useState(false);
  const panState = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as Element;
    // 节点自身与端口圆点都不启动画布平移：
    // 端口点击要能穿透到 circle 上，否则 pointer capture 会把 click 的
    // 目标改写成画布容器，"点端口进入连线模式"永远不会触发（实测踩到）。
    if (target.closest('[data-unit-node]') || target.closest('.port-dot')) return;
    const wrap = wrapRef.current;
    if (!wrap) return;
    /**
     * 空白处左键拖动：编排模式画框选，其它模式平移画布。
     * 与 Simulink/Aspen 一致——左键永远是"选择"，看远处靠滚动条与缩放。
     */
    if (editable && onSelectionChange && svgRef.current) {
      const rect = svgRef.current.getBoundingClientRect();
      const x = (e.clientX - rect.left) / effectiveZoom;
      const y = (e.clientY - rect.top) / effectiveZoom;
      marqueeRef.current = { x0: x, y0: y, x1: x, y1: y };
      setMarquee(marqueeRef.current);
      // setPointerCapture 对无效 pointerId 会抛 NotFoundError（合成事件、触屏边缘都会遇到），
      // 捕获失败不影响框选本身，不能让它中断 handler。
      try {
        wrap.setPointerCapture?.(e.pointerId);
      } catch {
        /* 指针已释放 */
      }
      return;
    }
    // 全览且无滚动余量时不需要拖拽，保持普通点击语义
    if (wrap.scrollWidth <= wrap.clientWidth && wrap.scrollHeight <= wrap.clientHeight) return;
    panState.current = { x: e.clientX, y: e.clientY, left: wrap.scrollLeft, top: wrap.scrollTop };
    setPanning(true);
    try {
      wrap.setPointerCapture?.(e.pointerId);
    } catch {
      /* 指针已释放 */
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (marqueeRef.current && svgRef.current) {
      const rect = svgRef.current.getBoundingClientRect();
      const x = Math.max(0, (e.clientX - rect.left) / effectiveZoom);
      const y = Math.max(0, (e.clientY - rect.top) / effectiveZoom);
      marqueeRef.current = { ...marqueeRef.current, x1: x, y1: y };
      setMarquee(marqueeRef.current);
      return;
    }
    const pan = panState.current;
    const wrap = wrapRef.current;
    if (!pan || !wrap) return;
    wrap.scrollLeft = pan.left - (e.clientX - pan.x);
    wrap.scrollTop = pan.top - (e.clientY - pan.y);
  };

  const endPan = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = marqueeRef.current;
    if (box) {
      const rect = {
        x: Math.min(box.x0, box.x1),
        y: Math.min(box.y0, box.y1),
        w: Math.abs(box.x1 - box.x0),
        h: Math.abs(box.y1 - box.y0),
      };
      // 小于 6px 视为误触（点击空白清除选择）
      if (rect.w > 6 && rect.h > 6) pick(nodesInRect(layout.nodes, rect));
      else pick([]);
      marqueeRef.current = null;
      setMarquee(null);
      wrapRef.current?.releasePointerCapture?.(e.pointerId);
      return;
    }
    if (!panState.current) return;
    panState.current = null;
    setPanning(false);
    wrapRef.current?.releasePointerCapture?.(e.pointerId);
  };

  /** 图纸坐标 = 屏幕位移 / 缩放比 */
  const onNodePointerDown = (e: React.PointerEvent<SVGGElement>, node: PlacedNode) => {
    if (!editable) return;
    e.stopPropagation();
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const id = node.unit.id;
    // 点未选中的单元 → 先选中它；点已选中的 → 保持整组多选再拖
    const ids = nextSelection(selectionIds, id, additive);
    if (ids.join() !== selectionIds.join()) pick(ids);
    if (!ids.includes(id)) return;
    try {
      (e.currentTarget as SVGGElement).setPointerCapture?.(e.pointerId);
    } catch {
      /* 指针已释放 */
    }
    /**
     * 基准坐标必须取「本帧渲染出来的坐标」，不能用 positions 里存的。
     * 自动布局的单元 positions 为空，按 {0,0} 起算会瞬移到左上角；
     * 而每帧都用最新布局叠加位移，同样的 14px 会被重复累加（实测 2 格变 3 格）。
     */
    const origins: Record<string, { x: number; y: number }> = {};
    for (const n of layout.nodes) if (ids.includes(n.unit.id)) origins[n.unit.id] = { x: n.x, y: n.y };
    setDrag({ ids, startX: e.clientX, startY: e.clientY, origins });
  };

  const onNodePointerMove = (e: React.PointerEvent<SVGGElement>) => {
    if (!drag) return;
    e.stopPropagation();
    const dx = (e.clientX - drag.startX) / effectiveZoom;
    const dy = (e.clientY - drag.startY) / effectiveZoom;
    const snappedDx = Math.round(dx / 14) * 14;
    const snappedDy = Math.round(dy / 14) * 14;
    if (drag.ids.length > 1 && onMoveUnits) {
      const moves = moveNodes(layout.nodes, drag.ids, dx, dy, 14, drag.origins);
      if (Object.keys(moves).length > 0) onMoveUnits(moves);
      return;
    }
    const id = drag.ids[0];
    const origin = drag.origins[id];
    if (origin) onMoveUnit?.(id, Math.max(0, origin.x + snappedDx), Math.max(0, origin.y + snappedDy));
  };

  const endNodeDrag = (e: React.PointerEvent<SVGGElement>) => {
    if (!drag) return;
    e.stopPropagation();
    try {
      (e.currentTarget as SVGGElement).releasePointerCapture?.(e.pointerId);
    } catch {
      /* 已释放 */
    }
    setDrag(null);
  };

  /** 折点句柄按下：记住原始折点与指针位置 */
  const onRoutePointerDown = (
    e: React.PointerEvent<SVGCircleElement>,
    connectionId: string,
    index: number,
    point: { x: number; y: number },
  ) => {
    if (!editable || !onRouteChange) return;
    e.stopPropagation();
    e.preventDefault();
    try {
      (e.currentTarget as SVGCircleElement).setPointerCapture?.(e.pointerId);
    } catch {
      /* 指针已释放 */
    }
    setRouteDrag({ connectionId, index, origin: point, startX: e.clientX, startY: e.clientY });
  };

  const onRoutePointerMove = (e: React.PointerEvent<SVGCircleElement>) => {
    if (!routeDrag || !onRouteChange) return;
    e.stopPropagation();
    const dx = Math.round((e.clientX - routeDrag.startX) / effectiveZoom / 14) * 14;
    const dy = Math.round((e.clientY - routeDrag.startY) / effectiveZoom / 14) * 14;
    const next = { x: Math.max(0, routeDrag.origin.x + dx), y: Math.max(0, routeDrag.origin.y + dy) };
    const existing = topo.routes?.[routeDrag.connectionId] ?? [];
    const points = existing.length > 0 ? [...existing] : [{ ...routeDrag.origin }];
    points[routeDrag.index] = next;
    onRouteChange(routeDrag.connectionId, points);
  };

  const endRouteDrag = (e: React.PointerEvent<SVGCircleElement>) => {
    if (!routeDrag) return;
    e.stopPropagation();
    try {
      (e.currentTarget as SVGCircleElement).releasePointerCapture?.(e.pointerId);
    } catch {
      /* 已释放 */
    }
    setRouteDrag(null);
  };

  /**
   * 泳道间距随容器高度自适应。
   *
   * 工艺图天然是宽扁的（约 3.2:1），而容器约 2:1，直接放进全览会:
   * 要么留出大片底部空白，要么把文字压到 5px。
   * 适当拉开三条泳道的垂直间距，可以让图形更接近容器比例，
   * 从而在同样的容器里获得更大的有效字号。
   */
  const adaptiveLaneGap = useMemo(() => {
    // 泳道间距压到刚好不重叠：间距越大整图越高，全览时字号越小。
    // 0.75 版实测 132px 时整图 646 高、缩放只有 44%，文字不可读；
    // 压到 96px 后整图约 540 高，同样视口下缩放提到 52% 以上。
    return compact ? 76 : 96;
  }, [compact]);

  const layout = useMemo(
    () =>
      layoutTopology(topo, {
        compact,
        laneGap: adaptiveLaneGap,
        // 不折行：折行后跨行连线会横穿整张图，比裁切更难读（实测对比后放弃）。
        maxRowWidth: undefined,
      }),
    [topo, compact, adaptiveLaneGap],
  );

  useEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    const ro = new ResizeObserver(() => {
      setWrapSize({ w: node.clientWidth, h: node.clientHeight });
    });
    ro.observe(node);
    setWrapSize({ w: node.clientWidth, h: node.clientHeight });
    return () => ro.disconnect();
  }, []);

  /**
   * 全览必须严格装进容器：加下限会让图形超出边界，右侧排放口与底部污泥线被裁掉。
   * 可读性靠节点字号解决（compact 模式用 22/28px 字号，缩放后仍有 13–16px）。
   */
  const fitScale =
    wrapSize.w > 0 && wrapSize.h > 0 ? Math.min(wrapSize.w / layout.width, wrapSize.h / layout.height, 1) : 1;
  const effectiveZoom = fitToWindow ? fitScale : zoom;
  const unitState = useMemo(() => Object.fromEntries(snap.tanks.map((t) => [t.id, t])), [snap.tanks]);

  const visibleEdges = layout.edges.filter((e) => showRecycle || !e.connection.recycle);
  const animate = !snap.paused;

  return (
    <div className="canvas-viewport">
      <div className="canvas-zoom-controls" role="group" aria-label="画布缩放">
        <button
          onClick={() => {
            setFitToWindow(false);
            setZoom((z) => Math.max(0.5, Number((z - 0.1).toFixed(2))));
          }}
          aria-label="缩小"
        >
          −
        </button>
        <span>{Math.round(effectiveZoom * 100)}%</span>
        <button
          onClick={() => {
            setFitToWindow(false);
            setZoom((z) => Math.min(2, Number((z + 0.1).toFixed(2))));
          }}
          aria-label="放大"
        >
          +
        </button>
        <button
          onClick={() => {
            setFitToWindow(false);
            setZoom(1);
          }}
          aria-label="实际尺寸"
          data-active={!fitToWindow}
        >
          1:1
        </button>
        <button
          onClick={() => {
            setFitToWindow(true);
            setZoom(1);
          }}
          aria-label="适应窗口"
          data-active={fitToWindow}
        >
          全览
        </button>
      </div>
      {/**
       * 图例必须放在缩放容器外面。
       * canvas-scaler 带 transform，会成为绝对定位元素的包含块，
       * 1:1 模式下图例就被钉到 646px 图纸底部（屏幕外）而看不见。
       */}
      <div className={fit === 'flow' ? 'canvas-legend canvas-legend-flow' : 'canvas-legend'}>
        <span className="canvas-legend-title">物流图例</span>
        {(
          [
            'influent',
            'mixed_liquor',
            'internal_recycle',
            'return_activated_sludge',
            'waste_sludge',
            'air',
            'chemical',
          ] as StreamKind[]
        ).map((st) => (
          <span className="canvas-legend-item" key={st}>
            <svg width="18" height="8" aria-hidden="true">
              <line
                x1="0"
                y1="4"
                x2="18"
                y2="4"
                stroke={STREAM_COLOR[st]}
                strokeWidth={Math.max(1.4, STREAM_WIDTH[st])}
                strokeDasharray={STREAM_DASH[st]}
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
        data-panning={panning}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onPointerLeave={endPan}
      >
        <div
          className="canvas-scaler"
          style={{
            transform: `scale(${effectiveZoom})`,
            transformOrigin: 'top left',
            width: layout.width,
            height: layout.height,
            // 缩放后占位尺寸随之变化，滚动区域才能正确覆盖整张图
            marginRight: `${(effectiveZoom - 1) * layout.width}px`,
            marginBottom: `${(effectiveZoom - 1) * layout.height}px`,
          }}
        >
          <svg
            ref={svgRef}
            className={`${fit === 'flow' ? 'plant-canvas plant-canvas-flow' : 'plant-canvas'}${connectFrom ? ' connecting' : ''}`}
            width={fit === 'flow' ? layout.width : undefined}
            height={fit === 'flow' ? layout.height : undefined}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            /**
             * 全览模式贴顶对齐：图形按宽度缩放后会留出上下空白，
             * 贴顶能把这部分空白推到下方（视觉上更接近"图在上、字在下"的阅读习惯），
             * 同时避免内容被垂直居中后与图例/缩放控件重叠。
             */
            preserveAspectRatio={fitToWindow ? 'xMidYMin meet' : 'xMinYMin meet'}
            role="img"
            aria-label={`${topo.name} 工艺流程实时图，共 ${topo.units.length} 个工艺单元、${topo.connections.length} 条物流连接`}
          >
            <defs>
              {Object.entries(STREAM_COLOR).map(([stream, color]) => (
                <marker
                  key={stream}
                  id={`arrow-${stream}`}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="5"
                  markerHeight="5"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill={color} opacity={0.9} />
                </marker>
              ))}
              <filter id="nodeGlow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="3" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            {layout.lanes.map((lane) => (
              <g key={lane.layer}>
                <line
                  x1={0}
                  y1={lane.y - 14}
                  x2={layout.width}
                  y2={lane.y - 14}
                  stroke="var(--line-soft)"
                  strokeWidth="1"
                  strokeDasharray="2 8"
                />
                <text x={6} y={lane.y - 20} className="lane-label">
                  {lane.label}
                </text>
              </g>
            ))}

            {visibleEdges.map((edge, i) => (
              <Edge key={edge.connection.id} edge={edge} index={i} animate={animate} showLabel={showLabels} />
            ))}

            {/**
             * 折点句柄必须画在边的上层、节点的下层：它落在连线中点上，
             * 被节点盖住就点不到。
             */}
            {editable && onRouteChange && (
              <RouteHandles
                edges={visibleEdges}
                routes={topo.routes}
                dragging={routeDrag}
                onPointerDown={onRoutePointerDown}
                onPointerMove={onRoutePointerMove}
                onPointerUp={endRouteDrag}
                onRemove={(id) => onRouteChange(id, null)}
              />
            )}

            {layout.nodes.map((node) => (
              <Node
                key={node.unit.id}
                node={node}
                snap={snap}
                selected={selectionIds.includes(node.unit.id)}
                multiSelected={selectionIds.length > 1 && selectionIds.includes(node.unit.id)}
                onSelect={onSelect}
                showLabel={showLabels}
                liveTank={unitState[node.unit.id]}
                compactView={fitToWindow || compact === true}
                editable={editable}
                dragging={Boolean(drag?.ids.includes(node.unit.id))}
                onPointerDownNode={onNodePointerDown}
                onPointerMoveNode={onNodePointerMove}
                onPointerUpNode={endNodeDrag}
              />
            ))}
            {/**
             * 端口必须画在节点之后（上层）：端口锚点正好落在节点边界上，
             * 画在下层时圆点有一半被节点矩形盖住，点中心实际点到的是节点。
             */}
            {editable &&
              layout.nodes.map((node) => (
                <PortDots
                  key={`ports-${node.unit.id}`}
                  node={node}
                  connectFrom={connectFrom}
                  onPortClick={onPortClick}
                />
              ))}
            {marquee && (
              <rect
                className="marquee-rect"
                x={Math.min(marquee.x0, marquee.x1)}
                y={Math.min(marquee.y0, marquee.y1)}
                width={Math.abs(marquee.x1 - marquee.x0)}
                height={Math.abs(marquee.y1 - marquee.y0)}
              />
            )}
          </svg>
        </div>
      </div>
    </div>
  );
}

function Edge({
  edge,
  index,
  animate,
  showLabel,
}: {
  edge: PlacedEdge;
  index: number;
  animate: boolean;
  showLabel: boolean;
}) {
  if (!edge.path) return null;
  const stream = edge.connection.stream;
  const color = STREAM_COLOR[stream];
  const width = STREAM_WIDTH[stream];
  const dash = STREAM_DASH[stream];
  const dur = 2.4 + (index % 4) * 0.5;

  return (
    <g>
      <path d={edge.path} fill="none" stroke={color} strokeWidth={width * 2.4} opacity={0.1} strokeLinecap="round" />
      <path
        d={edge.path}
        fill="none"
        stroke={color}
        strokeWidth={width}
        strokeDasharray={dash}
        opacity={0.85}
        markerEnd={`url(#arrow-${stream})`}
        strokeLinecap="round"
      />
      {animate && (
        /**
         * 流动指示必须用 CSS 动画，不能用 SVG <animate>（SMIL）。
         *
         * 实测 22 条 SMIL 动画会长期占用主线程 90%+，把仿真页拖成幻灯片；
         * `.flow-pulse` 的 stroke-dashoffset 关键帧走合成线程，实测降到 16%，
         * 且 prefers-reduced-motion 能一键关掉。
         */
        <path
          d={edge.path}
          fill="none"
          stroke="#ffffff"
          strokeWidth={Math.max(1, width * 0.45)}
          strokeDasharray="3 34"
          opacity={0.5}
          strokeLinecap="round"
          className="flow-pulse"
          style={{ animationDuration: `${dur}s` }}
        />
      )}
      {showLabel && stream !== 'air' && edge.straight && Math.abs(edge.labelX - pipeStartX(edge)) > 90 && (
        <text x={edge.labelX} y={edge.labelY} className="edge-label" textAnchor="middle">
          {streamLabel(stream)}
        </text>
      )}
    </g>
  );
}

/** 直连边的起点 x：短距离（相邻池之间）不值得标名字，标了反而糊成一片 */
function pipeStartX(edge: PlacedEdge): number {
  const m = edge.path.match(/^M\s+(-?\d+(\.\d+)?)/);
  return m ? Number(m[1]) : 0;
}

/** 端口旁的极短标签：只保留区分度最高的两个字 */
function portShortLabel(stream: StreamKind): string {
  switch (stream) {
    case 'influent':
      return '进水';
    case 'mixed_liquor':
      return '混合';
    case 'return_activated_sludge':
      return '污泥';
    case 'waste_sludge':
      return '排泥';
    case 'internal_recycle':
      return '内回';
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

function streamLabel(stream: StreamKind): string {
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

/**
 * 连线折点句柄。
 *
 * 没有折点的连线只给一个「中点手柄」：点它即在该处插入第一个折点；
 * 已有折点的连线为每个折点画一个可拖动手柄，并在中点给一个「×」用于
 * 恢复自动走线。这是流程模拟器里调整管线的常规做法（Aspen 的 route
 * 与 Visio 的连接点编辑）。
 */
function RouteHandles({
  edges,
  routes,
  dragging,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onRemove,
}: {
  edges: PlacedEdge[];
  routes?: Record<string, { x: number; y: number }[]>;
  dragging: { connectionId: string; index: number } | null;
  onPointerDown: (
    e: React.PointerEvent<SVGCircleElement>,
    connectionId: string,
    index: number,
    point: { x: number; y: number },
  ) => void;
  onPointerMove: (e: React.PointerEvent<SVGCircleElement>) => void;
  onPointerUp: (e: React.PointerEvent<SVGCircleElement>) => void;
  onRemove: (connectionId: string) => void;
}) {
  return (
    <g className="route-layer">
      {edges.map((edge) => {
        if (!edge.path) return null;
        const existing = routes?.[edge.connection.id] ?? [];
        const mid = pathMidpoint(edge.path);
        if (!mid) return null;
        const active = dragging?.connectionId === edge.connection.id;
        return (
          <g key={`route-${edge.connection.id}`}>
            {(existing.length > 0 ? existing : [mid]).map((point, index) => (
              <circle
                key={`${edge.connection.id}-${index}`}
                cx={point.x}
                cy={point.y}
                r={active && dragging?.index === index ? 6 : 4}
                className="route-handle"
                data-connection={edge.connection.id}
                data-index={index}
                onPointerDown={(e) => onPointerDown(e, edge.connection.id, index, point)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              >
                <title>{existing.length > 0 ? '拖动调整折点' : '拖动生成折点'}</title>
              </circle>
            ))}
            {existing.length > 0 && (
              <g
                className="route-reset"
                transform={`translate(${mid.x + 10} ${mid.y - 10})`}
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(edge.connection.id);
                }}
              >
                <circle r="6" />
                <text textAnchor="middle" y="3.5">
                  ×
                </text>
                <title>恢复自动走线</title>
              </g>
            )}
          </g>
        );
      })}
    </g>
  );
}

/** 折线路径的中点（按命令序列取中段端点，不依赖浏览器测量） */
function pathMidpoint(path: string): { x: number; y: number } | null {
  const cmds = path.match(/[MHV][^MHV]*/g) ?? [];
  if (cmds.length === 0) return null;
  const points: { x: number; y: number }[] = [];
  let x = 0;
  let y = 0;
  for (const cmd of cmds) {
    const nums = (cmd.slice(1).match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    if (cmd[0] === 'M') {
      x = nums[0];
      y = nums[1];
    } else if (cmd[0] === 'H') {
      x = nums[0];
    } else {
      y = nums[0];
    }
    points.push({ x, y });
  }
  if (points.length === 2) return { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
  return points[Math.floor(points.length / 2)];
}

function PortDots({
  node,
  connectFrom,
  onPortClick,
}: {
  node: PlacedNode;
  connectFrom: { unitId: string; portId: string } | null;
  onPortClick?: (unitId: string, portId: string, kind: 'in' | 'out') => void;
}) {
  return (
    <g className="port-layer">
      {portAnchors(node).map(({ port, kind, x, y }) => {
        const active = connectFrom?.unitId === node.unit.id && connectFrom.portId === port.id;
        return (
          <g key={`${node.unit.id}-${port.id}-${kind}`}>
            {/* 端口颜色 = 物流颜色：一眼看出这个口接的是进水、混合液还是空气 */}
            <circle
              cx={x}
              cy={y}
              r={active ? 6.5 : 4.5}
              className="port-dot"
              data-kind={kind}
              data-active={active}
              data-stream={port.stream}
              style={{ stroke: STREAM_COLOR[port.stream] }}
              onClick={(e) => {
                e.stopPropagation();
                onPortClick?.(node.unit.id, port.id, kind);
              }}
            >
              <title>
                {kind === 'in' ? '入口' : '出口'} {port.id} · {streamLabel(port.stream)}
                {connectFrom ? '（点击完成连线）' : kind === 'out' ? '（点击开始连线）' : ''}
              </title>
            </circle>
            {/* 悬停放大并显示物流名：小圆点单靠颜色不够，名字直接给出 */}
            <text
              x={kind === 'in' ? x - 9 : x + 9}
              y={y + 3.5}
              className="port-label"
              textAnchor={kind === 'in' ? 'end' : 'start'}
            >
              {portShortLabel(port.stream)}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function Node({
  node,
  snap,
  selected,
  multiSelected = false,
  onSelect,
  showLabel,
  liveTank,
  compactView,
  editable = false,
  dragging = false,
  onPointerDownNode,
  onPointerMoveNode,
  onPointerUpNode,
}: {
  node: PlacedNode;
  snap: PlantSnapshot;
  selected: boolean;
  multiSelected?: boolean;
  onSelect: (id: string | null) => void;
  showLabel: boolean;
  liveTank?: {
    do: number;
    mlss: number;
    cod: number;
    nh: number;
    no3: number;
    tp: number;
    alkalinity: number;
    kind: string;
  };
  compactView: boolean;
  editable?: boolean;
  dragging?: boolean;
  onPointerDownNode?: (e: React.PointerEvent<SVGGElement>, node: PlacedNode) => void;
  onPointerMoveNode?: (e: React.PointerEvent<SVGGElement>) => void;
  onPointerUpNode?: (e: React.PointerEvent<SVGGElement>) => void;
}) {
  const { unit, x, y, w, h } = node;
  const bad = isUnitAlarming(unit.kind, unit.id, snap);
  const stroke = selected ? 'var(--water)' : bad ? 'var(--alarm)' : 'var(--line)';
  const strokeWidth = selected ? 1.8 : 1;

  return (
    <g
      className="plant-node"
      data-unit-node={unit.id}
      data-editable={editable}
      data-dragging={dragging}
      data-multi={multiSelected}
      /**
       * 编排模式下选择由 pointerdown 负责（要支持 Shift 加选与整组拖动）；
       * 这里再调 onSelect 会把多选立刻塌成单选，实测踩到过。
       */
      onClick={() => {
        if (editable) return;
        onSelect(selected ? null : unit.id);
      }}
      onPointerDown={(e) => onPointerDownNode?.(e, node)}
      onPointerMove={(e) => onPointerMoveNode?.(e)}
      onPointerUp={(e) => onPointerUpNode?.(e)}
      onPointerCancel={(e) => onPointerUpNode?.(e)}
      role="button"
      tabIndex={0}
      aria-label={`${unit.name}，${unit.role}${bad ? '，存在告警' : ''}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(selected ? null : unit.id);
        }
      }}
    >
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx="2"
        fill={fillFor(unit.kind, liveTank)}
        stroke={stroke}
        strokeWidth={strokeWidth}
      />
      <rect x={x} y={y} width={w} height="20" rx="2" fill="rgba(6,16,15,0.66)" />
      <text x={x + 6} y={y + 14.5} className="unit-icon" aria-hidden="true">
        {UNIT_KIND_ICON[unit.kind] ?? '▢'}
      </text>
      <text x={x + 20} y={y + 15} className={compactView ? 'unit-title-lg' : 'unit-title'}>
        {compactView ? shortName(unit.name) : unit.name}
      </text>

      {showLabel && (
        <UnitBody unit={unit} x={x} y={y} w={w} h={h} snap={snap} liveTank={liveTank} compact={compactView} />
      )}

      {bad && <circle cx={x + w - 9} cy={y + 10} r="3.4" fill="var(--alarm)" />}
    </g>
  );
}

/** 全览只保留主名称：节点宽 124，带 "· 副标题" 会压到相邻池子 */
function shortName(name: string): string {
  return name.split(' · ')[0];
}

function fillFor(kind: UnitKind, tank?: { do: number; kind: string }): string {
  if (kind === 'aerobic' && tank) {
    const a = 0.06 + Math.min(0.2, Math.max(0, tank.do) * 0.06);
    return `rgba(79,214,232,${a})`;
  }
  if (kind === 'anaerobic' || kind === 'anoxic') return 'rgba(62,224,181,0.055)';
  if (kind === 'clarifier') return 'rgba(62,224,181,0.07)';
  if (kind === 'storage') return 'rgba(79,214,232,0.06)';
  return 'rgba(13,33,31,0.9)';
}

function UnitBody({
  unit,
  x,
  y,
  w,
  h,
  snap,
  liveTank,
  compact,
}: {
  unit: UnitSpecOnNode;
  x: number;
  y: number;
  w: number;
  h: number;
  snap: PlantSnapshot;
  liveTank?: { do: number; mlss: number; cod: number; nh: number; no3: number; tp: number; alkalinity: number };
  /** 全览模式：只画最重要的一项数值，字号更大，保证缩小时仍可辨认 */
  compact?: boolean;
}) {
  const lx = x + 7;
  let ly = y + 36;
  const line = (text: string, cls = 'unit-sub') => {
    const el = (
      <text key={`${unit.id}-${ly}`} x={lx} y={ly} className={cls}>
        {text}
      </text>
    );
    ly += 14;
    return el;
  };

  if (liveTank) {
    if (compact) {
      return (
        <g>
          <text x={lx} y={y + 58} className="unit-value-lg">
            {unit.kind === 'aerobic' ? `DO ${liveTank.do.toFixed(1)}` : `NH₄ ${liveTank.nh.toFixed(0)}`}
          </text>
          <text x={lx} y={y + 88} className="unit-sub">
            MLSS {Math.round(liveTank.mlss)}
          </text>
        </g>
      );
    }
    return (
      <g>
        {line(unit.role)}
        {line(`DO ${liveTank.do.toFixed(2)} · MLSS ${Math.round(liveTank.mlss)}`, 'unit-value')}
        {line(`NH₄ ${liveTank.nh.toFixed(1)} · NO₃ ${liveTank.no3.toFixed(1)}`)}
      </g>
    );
  }

  switch (unit.kind) {
    case 'inlet':
      return (
        <g>
          {line(unit.role)}
          {line(`${snap.influent.flow.toFixed(0)} m³/h`, 'unit-value')}
          {line(`COD ${snap.influent.cod.toFixed(0)} · NH₄ ${snap.influent.nh.toFixed(1)}`)}
        </g>
      );
    case 'outlet':
      return (
        <g>
          {line(unit.role)}
          {line(`${snap.effluent.flow.toFixed(0)} m³/h`, 'unit-value')}
          {line(`COD ${snap.effluent.cod.toFixed(1)}`)}
        </g>
      );
    case 'clarifier':
      return <ClarifierBody unit={unit} x={x} y={y} w={w} h={h} snap={snap} />;
    case 'blower':
      return (
        <g>
          {line(unit.role)}
          {line(`${snap.energy.blowerKw.toFixed(0)} kW`, 'unit-value')}
          {line(`氧设定 ${snap.controls.doSetpoint.toFixed(1)}`)}
        </g>
      );
    case 'chemical':
      return (
        <g>
          {line(unit.role)}
          {line(`PAC ${snap.controls.pacDose.toFixed(0)} mg/L`, 'unit-value')}
          {line(`碳源 ${snap.controls.carbonDose.toFixed(0)} · 碱度 ${snap.controls.alkDose.toFixed(0)}`)}
        </g>
      );
    case 'storage':
      return (
        <g>
          {line(unit.role)}
          {line(`${(snap.stormStorageM3 / 1000).toFixed(1)} 千 m³`, 'unit-value')}
          <rect x={x + 8} y={y + h - 12} width={w - 16} height="3" fill="var(--line-soft)" />
          <rect
            x={x + 8}
            y={y + h - 12}
            width={(w - 16) * Math.min(1, snap.stormStorageM3 / 16000)}
            height="3"
            fill="var(--cyan)"
          />
        </g>
      );
    case 'thickener':
      return (
        <g>
          {line(unit.role)}
          {line(`${((snap.controls.wasRatio * snap.influent.flow * 24) / 1000).toFixed(1)} 千 m³/d`, 'unit-value')}
          {line('含水率 97%')}
        </g>
      );
    case 'dewatering':
      return (
        <g>
          {line(unit.role)}
          {line(`${(snap.controls.wasRatio * snap.influent.flow * 24 * 24.9).toFixed(0)} kg/d`, 'unit-value')}
          {line('泥饼 60%')}
        </g>
      );
    case 'screening':
    case 'grit':
    case 'primary':
      return (
        <g>
          {line(unit.role)}
          {line(`${snap.influent.flow.toFixed(0)} m³/h`, 'unit-value')}
          {line('运行')}
        </g>
      );
    case 'disinfection':
      return (
        <g>
          {line(unit.role)}
          {line(`${snap.effluent.flow.toFixed(0)} m³/h`, 'unit-value')}
          {line('紫外 40 mJ/cm²')}
        </g>
      );
    default:
      return <g>{line(unit.role)}</g>;
  }
}

type UnitSpecOnNode = PlacedNode['unit'];

function ClarifierBody({
  unit,
  x,
  y,
  w,
  h,
  snap,
}: {
  unit: UnitSpecOnNode;
  x: number;
  y: number;
  w: number;
  h: number;
  snap: PlantSnapshot;
}) {
  const depth = unit.depth ?? 4.5;
  const fx = x + 6;
  const fw = w - 12;
  const fy = y + 26;
  const fh = h - 34;
  const bh = Math.min(fh, (snap.clarifier.blanketM / depth) * fh);
  const over = snap.clarifier.blanketM > depth - 0.4;

  return (
    <g>
      <rect x={fx} y={fy} width={fw} height={fh} fill="rgba(6,16,15,0.35)" />
      <rect
        x={fx}
        y={fy + fh - bh}
        width={fw}
        height={bh}
        fill={over ? 'rgba(190,80,60,0.3)' : 'rgba(150,110,70,0.26)'}
      />
      <line
        x1={fx}
        y1={fy + fh - bh}
        x2={fx + fw}
        y2={fy + fh - bh}
        stroke={over ? 'var(--alarm)' : 'var(--amber)'}
        strokeWidth="1.2"
        strokeDasharray="4 3"
      />
      <text x={fx + 4} y={fy + 12} className="unit-sub">
        出水 SS {snap.effluent.ss.toFixed(1)}
      </text>
      <text x={fx + 4} y={fy + 26} className="unit-value">
        泥位 {snap.clarifier.blanketM.toFixed(2)} m
      </text>
      <text x={fx + 4} y={fy + 40} className="unit-sub">
        SLR {snap.clarifier.slr.toFixed(1)} kg/m²·h
      </text>
    </g>
  );
}

function isUnitAlarming(kind: UnitKind, id: string, snap: PlantSnapshot): boolean {
  const live = snap.activeAlarms;
  if (!live.length) return false;
  if (kind === 'outlet')
    return live.some((a) => ['EFF_NH', 'EFF_COD', 'EFF_TP', 'EFF_SS', 'EFF_TN', 'EFF_BOD'].includes(a.code));
  if (kind === 'clarifier') return live.some((a) => a.code === 'SLUDGE_BLANKET');
  if (kind === 'aerobic') return live.some((a) => a.code === 'DO_LOW');
  if (kind === 'blower') return live.some((a) => a.code === 'DO_LOW' || a.code === 'AERATION_LOW');
  if (kind === 'anaerobic' || kind === 'anoxic') return live.some((a) => a.code === 'SRT_LOW');
  void id;
  return false;
}
