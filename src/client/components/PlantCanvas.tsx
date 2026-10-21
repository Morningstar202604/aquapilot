import { useMemo, useState } from 'react';
import { layoutTopology, PlacedEdge, PlacedNode } from '../../model/layout';
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
  fit?: 'fill' | 'flow';
}

const STREAM_COLOR: Record<StreamKind, string> = {
  influent: '#3ee0b5',
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
}: Props) {
  const layout = useMemo(
    () => layoutTopology(topo, { compact, laneGap: compact ? 88 : 150 }),
    [topo, compact],
  );
  /**
   * 缩放状态。
   *
   * 不再把整厂压缩进容器宽度——那样池子一多字号会掉到 4px（实测 27 池时）。
   * 改为 1:1 绘制 + 可调缩放 + 横向滚动，保证文字始终可读。
   */
  const [zoom, setZoom] = useState(1);
  const unitState = useMemo(() => Object.fromEntries(snap.tanks.map((t) => [t.id, t])), [snap.tanks]);

  const visibleEdges = layout.edges.filter((e) => showRecycle || !e.connection.recycle);
  const animate = !snap.paused;

  return (
    <div className="canvas-viewport">
      <div className="canvas-zoom-controls" role="group" aria-label="画布缩放">
        <button onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.1).toFixed(2))))} aria-label="缩小">
          −
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom((z) => Math.min(2, Number((z + 0.1).toFixed(2))))} aria-label="放大">
          +
        </button>
        <button onClick={() => setZoom(1)} aria-label="重置为 100%">
          1:1
        </button>
      </div>
      <div className="canvas-wrap">
        <div
          className="canvas-scaler"
          style={{
            transform: `scale(${zoom})`,
            transformOrigin: 'top left',
            width: layout.width,
            height: layout.height,
            // 缩放后占位尺寸随之变化，滚动区域才能正确覆盖整张图
            marginRight: `${(zoom - 1) * layout.width}px`,
            marginBottom: `${(zoom - 1) * layout.height}px`,
          }}
        >
      <div className={fit === 'flow' ? 'canvas-legend canvas-legend-flow' : 'canvas-legend'}>
        <span className="canvas-legend-title">物流图例</span>
        {(['influent', 'mixed_liquor', 'internal_recycle', 'return_activated_sludge', 'waste_sludge', 'air', 'chemical'] as StreamKind[]).map((st) => (
          <span className="canvas-legend-item" key={st}>
            <svg width="18" height="8" aria-hidden="true">
              <line x1="0" y1="4" x2="18" y2="4" stroke={STREAM_COLOR[st]} strokeWidth={Math.max(1.4, STREAM_WIDTH[st])} strokeDasharray={STREAM_DASH[st]} />
            </svg>
            {streamLabel(st)}
          </span>
        ))}
      </div>

      <svg
        className={fit === 'flow' ? 'plant-canvas plant-canvas-flow' : 'plant-canvas'}
        width={fit === 'flow' ? layout.width : undefined}
        height={fit === 'flow' ? layout.height : undefined}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        preserveAspectRatio="xMinYMid meet"
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
            <line x1={0} y1={lane.y - 14} x2={layout.width} y2={lane.y - 14} stroke="var(--line-soft)" strokeWidth="1" strokeDasharray="2 8" />
            <text x={6} y={lane.y - 20} className="lane-label">
              {lane.label}
            </text>
          </g>
        ))}

        {visibleEdges.map((edge, i) => (
          <Edge key={edge.connection.id} edge={edge} index={i} animate={animate} showLabel={showLabels} />
        ))}

        {layout.nodes.map((node) => (
          <Node
            key={node.unit.id}
            node={node}
            snap={snap}
            selected={selected === node.unit.id}
            onSelect={onSelect}
            showLabel={showLabels}
            liveTank={unitState[node.unit.id]}
          />
        ))}
      </svg>
        </div>
      </div>
    </div>
  );
}

function Edge({ edge, index, animate, showLabel }: { edge: PlacedEdge; index: number; animate: boolean; showLabel: boolean }) {
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
        <path
          d={edge.path}
          fill="none"
          stroke="#ffffff"
          strokeWidth={Math.max(1, width * 0.45)}
          strokeDasharray="3 34"
          opacity={0.5}
          strokeLinecap="round"
        >
          <animate attributeName="stroke-dashoffset" from="37" to="0" dur={`${dur}s`} repeatCount="indefinite" />
        </path>
      )}
      {showLabel && stream !== 'air' && (
        <text x={edge.labelX} y={edge.labelY} className="edge-label" textAnchor="middle">
          {streamLabel(stream)}
        </text>
      )}
    </g>
  );
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

function Node({
  node,
  snap,
  selected,
  onSelect,
  showLabel,
  liveTank,
}: {
  node: PlacedNode;
  snap: PlantSnapshot;
  selected: boolean;
  onSelect: (id: string | null) => void;
  showLabel: boolean;
  liveTank?: { do: number; mlss: number; cod: number; nh: number; no3: number; tp: number; alkalinity: number; kind: string };
}) {
  const { unit, x, y, w, h } = node;
  const bad = isUnitAlarming(unit.kind, unit.id, snap);
  const stroke = selected ? 'var(--water)' : bad ? 'var(--alarm)' : 'var(--line)';
  const strokeWidth = selected ? 1.8 : 1;

  return (
    <g
      className="plant-node"
      onClick={() => onSelect(selected ? null : unit.id)}
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
      <rect x={x} y={y} width={w} height={h} rx="2" fill={fillFor(unit.kind, liveTank)} stroke={stroke} strokeWidth={strokeWidth} />
      <rect x={x} y={y} width={w} height="20" rx="2" fill="rgba(6,16,15,0.66)" />
      <text x={x + 7} y={y + 14} className="unit-title">
        {unit.name}
      </text>

      {showLabel && <UnitBody unit={unit} x={x} y={y} w={w} h={h} snap={snap} liveTank={liveTank} />}

      {bad && <circle cx={x + w - 9} cy={y + 10} r="3.4" fill="var(--alarm)" />}
    </g>
  );
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
}: {
  unit: UnitSpecOnNode;
  x: number;
  y: number;
  w: number;
  h: number;
  snap: PlantSnapshot;
  liveTank?: { do: number; mlss: number; cod: number; nh: number; no3: number; tp: number; alkalinity: number };
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
          <rect x={x + 8} y={y + h - 12} width={(w - 16) * Math.min(1, snap.stormStorageM3 / 16000)} height="3" fill="var(--cyan)" />
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

function ClarifierBody({ unit, x, y, w, h, snap }: { unit: UnitSpecOnNode; x: number; y: number; w: number; h: number; snap: PlantSnapshot }) {
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
      <rect x={fx} y={fy + fh - bh} width={fw} height={bh} fill={over ? 'rgba(190,80,60,0.3)' : 'rgba(150,110,70,0.26)'} />
      <line x1={fx} y1={fy + fh - bh} x2={fx + fw} y2={fy + fh - bh} stroke={over ? 'var(--alarm)' : 'var(--amber)'} strokeWidth="1.2" strokeDasharray="4 3" />
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
  if (kind === 'outlet') return live.some((a) => ['EFF_NH', 'EFF_COD', 'EFF_TP', 'EFF_SS'].includes(a.code));
  if (kind === 'clarifier') return live.some((a) => a.code === 'SLUDGE_BLANKET');
  if (kind === 'aerobic') return live.some((a) => a.code === 'DO_LOW');
  if (kind === 'blower') return live.some((a) => a.code === 'DO_LOW' || a.code === 'AERATION_LOW');
  if (kind === 'anaerobic' || kind === 'anoxic') return live.some((a) => a.code === 'SRT_LOW');
  void id;
  return false;
}
