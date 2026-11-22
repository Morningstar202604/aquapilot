import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { PlantSnapshot } from '../../shared/protocol';
import { portAnchors, type PlacedNode } from '../../model/layout';
import { streamColor, streamShort, unitKindAccent, unitKindIcon } from '../../shared/streamMeta';
import type { UnitKind } from '../../model/topology';
import { BLANKET_MARGIN_M } from '../../sim/alarmRules';
import { fitCompactTitle } from './labels';

/**
 * 画布节点渲染。
 *
 * React Flow 负责拖拽、框选、缩放与端口连接；节点本身只负责「长什么样」。
 * 这里刻意保留原有 `.plant-node` / `[data-unit-node]` 契约，外层的选择、
 * 测试与样式不用跟着框架一起改。
 */

export interface TankHistoryPoint {
  do: number;
  mlss: number;
  nh: number;
}

type LiveTank = PlantSnapshot['tanks'][number];

export interface PlantNodeData extends Record<string, unknown> {
  node: PlacedNode;
  snap: PlantSnapshot;
  selected: boolean;
  multiSelected: boolean;
  showLabel: boolean;
  compactView: boolean;
  editable: boolean;
  liveTank?: LiveTank;
  history?: TankHistoryPoint[];
  connectFrom?: { unitId: string; portId: string } | null;
  snapTarget?: { unitId: string; portId: string } | null;
  onPick: (id: string, additive: boolean) => void;
  onPortClick?: (unitId: string, portId: string, kind: 'in' | 'out') => void;
  onPortDragStart?: (unitId: string, portId: string, e: React.PointerEvent<HTMLDivElement>) => void;
}

export type PlantFlowNode = Node<PlantNodeData, 'plant'>;

export function PlantNode({ data, selected, dragging }: NodeProps<PlantFlowNode>) {
  const { node, snap, editable, compactView, showLabel, liveTank, history } = data;
  const { unit, w, h } = node;
  const bad = isUnitAlarming(unit.kind, snap);
  const stroke = selected || data.selected ? 'var(--water)' : bad ? 'var(--alarm)' : editable ? '#9dbfb5' : '#adc8c0';
  const strokeWidth = selected || data.selected ? 2 : editable ? 1.4 : 1.2;
  const compactTitle = compactView
    ? fitCompactTitle(unit.name, w)
    : fitCompactTitle(unit.name, w, { padding: 30, max: 11.5, min: 9 });
  const headerH = compactView ? 30 : 22;
  const accent = unitKindAccent(unit.kind);
  const anchors = portAnchors(node);

  return (
    <div className={`plant-node-wrap${dragging ? ' is-dragging' : ''}`} style={{ width: w, height: h }}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="plant-node-svg" aria-hidden="true">
        <g
          className="plant-node"
          data-unit-node={unit.id}
          data-kind={unit.kind}
          data-editable={editable}
          data-dragging={dragging || undefined}
          data-multi={data.multiSelected ? 'true' : undefined}
          role="button"
          tabIndex={0}
          aria-label={`${unit.name}，${unit.role}${bad ? '，存在告警' : ''}`}
          onPointerDown={(e) => {
            if (editable) data.onPick(unit.id, e.shiftKey);
          }}
          onClick={(e) => {
            if (editable) return;
            e.stopPropagation();
            data.onPick(unit.id, false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              data.onPick(unit.id, false);
            }
          }}
        >
          <rect
            x={0}
            y={0}
            width={w}
            height={h}
            rx="6"
            fill={fillFor(unit.kind, editable)}
            stroke={stroke}
            strokeWidth={strokeWidth}
          />
          <rect x={1.2} y={2} width={3.2} height={h - 4} rx="1.6" fill={accent} opacity={0.9} />
          <rect x={0} y={0} width={w} height={headerH} rx="6" fill={editable ? '#ffffff' : 'rgba(255,255,255,0.92)'} />
          <rect x={0} y={0} width={w} height={headerH} rx="6" fill={accent} opacity={0.1} />
          <rect x={0} y={headerH - 6} width={w} height={6} fill={editable ? '#ffffff' : 'rgba(255,255,255,0.92)'} />
          <line x1={0} y1={headerH} x2={w} y2={headerH} stroke={editable ? '#c5d9d2' : '#cbdcd6'} strokeWidth="1" />
          {!compactView && (
            <text x={8} y={15} className="unit-icon" aria-hidden="true">
              {unitKindIcon(unit.kind) ?? '▢'}
            </text>
          )}
          {compactView ? (
            <text x={10} y={headerH - 9} className="unit-title-lg" style={{ fontSize: `${compactTitle.fontSize}px` }}>
              {compactTitle.text}
            </text>
          ) : (
            <text x={22} y={15} className="unit-title" style={{ fontSize: `${compactTitle.fontSize}px` }}>
              {compactTitle.text}
            </text>
          )}
          {showLabel && (
            <UnitBody
              unit={unit}
              x={0}
              y={0}
              w={w}
              h={h}
              snap={snap}
              liveTank={liveTank}
              history={history}
              compact={compactView}
              editable={editable}
            />
          )}
          {bad && <circle cx={w - 10} cy={headerH / 2} r="3.4" fill="var(--alarm)" />}
        </g>
      </svg>
      <div className="port-layer" data-unit={unit.id} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        {anchors.map(({ port, kind, x, y }) => {
          const active = data.connectFrom?.unitId === unit.id && data.connectFrom.portId === port.id;
          return (
            <Handle
              key={`${unit.id}-${port.id}-${kind}`}
              id={`${kind}:${port.id}`}
              type={kind === 'in' ? 'target' : 'source'}
              position={kind === 'in' ? Position.Left : Position.Right}
              isConnectable={false}
              className={editable ? 'port-dot' : 'plant-port-anchor'}
              data-unit={unit.id}
              data-kind={kind}
              data-port={port.id}
              data-stream={port.stream}
              data-active={active ? 'true' : undefined}
              data-snap={data.snapTarget?.unitId === unit.id && data.snapTarget.portId === port.id ? 'true' : undefined}
              style={{
                left: x - node.x,
                top: y - node.y,
                position: 'absolute',
                width: 9,
                height: 9,
                borderRadius: '50%',
                border: editable ? `1.5px solid ${streamColor(port.stream)}` : 'none',
                background: editable ? 'var(--panel)' : 'transparent',
                stroke: editable ? streamColor(port.stream) : undefined,
                pointerEvents: editable ? 'all' : 'none',
              }}
              onPointerDown={(e) => {
                if (!editable || kind !== 'out') return;
                e.stopPropagation();
                data.onPortDragStart?.(unit.id, port.id, e);
              }}
              onClick={(e) => {
                if (!editable) return;
                e.stopPropagation();
                data.onPortClick?.(unit.id, port.id, kind);
              }}
            >
              {editable && (
                <span className="port-hint" aria-hidden="true">
                  {streamShort(port.stream)}
                </span>
              )}
            </Handle>
          );
        })}
      </div>
    </div>
  );
}

function fillFor(kind: UnitKind, opaque?: boolean): string {
  if (opaque) {
    if (kind === 'aerobic') return '#eef7f5';
    if (kind === 'anaerobic' || kind === 'anoxic') return '#f2f7f4';
    if (kind === 'clarifier' || kind === 'thickener') return '#f0f6f4';
    if (kind === 'storage') return '#eef5f8';
    return '#f6f9f8';
  }
  /**
   * 监视模式也使用不透明底色：半透明填充会让网格和背后的边透出来，
   * 17 个单元看起来像贴在同一张纸上，而不是 17 个独立设备。DO 动态
   * 改由标题栏左侧色条和正文数值表达，不再用整块透明度编码。
   */
  if (kind === 'aerobic') return '#edf8f5';
  if (kind === 'anaerobic' || kind === 'anoxic') return '#f1f8f4';
  if (kind === 'clarifier' || kind === 'thickener') return '#eff6f4';
  if (kind === 'storage') return '#edf5f9';
  return '#f5faf8';
}

function UnitBody({
  unit,
  x,
  y,
  w,
  h,
  snap,
  liveTank,
  history,
  compact,
  editable,
}: {
  unit: PlacedNode['unit'];
  x: number;
  y: number;
  w: number;
  h: number;
  snap: PlantSnapshot;
  liveTank?: LiveTank;
  history?: TankHistoryPoint[];
  compact?: boolean;
  editable?: boolean;
}) {
  const lx = x + 7;
  let ly = y + 36;
  const line = (text: string, cls = 'unit-sub') => {
    const el = (
      <text key={`${unit.id}-${ly}-${text}`} x={lx} y={ly} className={cls}>
        {text}
      </text>
    );
    ly += 14;
    return el;
  };

  if (editable) {
    const detail =
      unit.volume !== undefined ? `容积 ${unit.volume} m³` : unit.area !== undefined ? `面积 ${unit.area} m²` : null;
    return (
      <g>
        {line(unit.role)}
        {detail && line(detail, 'unit-structural')}
      </g>
    );
  }

  if (liveTank) {
    if (compact) {
      return (
        <g>
          <text x={lx} y={y + 58} className="unit-value-lg">
            {unit.kind === 'aerobic' ? `DO ${liveTank.do.toFixed(1)}` : `NH₄ ${liveTank.nh.toFixed(0)}`}
          </text>
          <text x={lx} y={y + 88} className="unit-sub-lg">
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
        {history && history.length > 3 && (
          <TankSparkline
            history={history}
            metric={unit.kind === 'aerobic' ? 'do' : 'nh'}
            x={x + 8}
            y={y + h - 22}
            width={w - 16}
            height={14}
          />
        )}
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

function ClarifierBody({
  unit,
  x,
  y,
  w,
  h,
  snap,
}: {
  unit: PlacedNode['unit'];
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
  const over = snap.clarifier.blanketM > depth - BLANKET_MARGIN_M;

  return (
    <g>
      <rect x={fx} y={fy} width={fw} height={fh} fill="rgba(255,255,255,0.5)" />
      <rect x={fx} y={fy + fh - bh} width={fw} height={bh} fill="rgba(141,110,70,0.18)" />
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

function TankSparkline({
  history,
  metric,
  x,
  y,
  width,
  height,
}: {
  history: TankHistoryPoint[];
  metric: 'do' | 'nh';
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  const vals = history.map((pt) => Math.max(0, pt[metric]));
  const max = Math.max(metric === 'do' ? 2 : 1, ...vals);
  const step = width / (history.length - 1);
  const pts = history
    .map((_, i) => `${(x + i * step).toFixed(1)},${(y + height - (vals[i] / max) * height).toFixed(1)}`)
    .join(' ');
  const color = metric === 'do' ? 'var(--water)' : 'var(--amber)';
  return (
    <g aria-hidden="true">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.2" opacity="0.85" />
    </g>
  );
}

function isUnitAlarming(kind: UnitKind, snap: PlantSnapshot): boolean {
  const live = snap.activeAlarms;
  if (!live.length) return false;
  if (kind === 'outlet')
    return live.some((a) => ['EFF_NH', 'EFF_COD', 'EFF_TP', 'EFF_SS', 'EFF_TN', 'EFF_BOD'].includes(a.code));
  if (kind === 'clarifier') return live.some((a) => a.code === 'SLUDGE_BLANKET');
  if (kind === 'aerobic') return live.some((a) => a.code === 'DO_LOW');
  if (kind === 'blower') return live.some((a) => a.code === 'DO_LOW' || a.code === 'AERATION_LOW');
  if (kind === 'anaerobic' || kind === 'anoxic') return live.some((a) => a.code === 'SRT_LOW');
  return false;
}
