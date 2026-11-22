import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type Edge, type EdgeProps } from '@xyflow/react';
import type { StreamKind } from '../../model/topology';
import { STREAM_META, streamLabel } from '../../shared/streamMeta';

export interface PlantEdgeData extends Record<string, unknown> {
  stream: StreamKind;
  straight: boolean;
  points: { x: number; y: number }[];
  animate: boolean;
  showLabel: boolean;
  duration: number;
  /** 节点外框，用于把物流名放到不压卡片的位置 */
  obstacles: { x: number; y: number; w: number; h: number }[];
}

export type PlantFlowEdge = Edge<PlantEdgeData, 'plant'>;

function polyline(points: { x: number; y: number }[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
}

interface LabelAnchor {
  x: number;
  y: number;
  vertical: boolean;
}

/**
 * 只把标签放在一条足够长的线段中点，并沿法线方向让开线本身。
 *
 * 旧逻辑用 `points[0]` 当锚点，而路由的第一个点恰好是源端口——
 * 标签就压在节点边缘、端口圆点和卡片标题上，首字被遮住，远看像
 * 一串竖排的「进 / 水」。短距离直连（同排模块间距 30px）干脆不显示
 * 标签：图例已经按颜色区分物流，重复 17 次「进水」只会制造噪声。
 */
function labelAnchor(
  source: { x: number; y: number },
  points: { x: number; y: number }[],
  target: { x: number; y: number },
  obstacles: { x: number; y: number; w: number; h: number }[],
): LabelAnchor | null {
  const all = [source, ...points, target];
  let best: { a: { x: number; y: number }; b: { x: number; y: number }; len: number } | null = null;
  for (let i = 0; i < all.length - 1; i++) {
    const a = all[i];
    const b = all[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!best || len > best.len) best = { a, b, len };
  }
  if (!best || best.len < 56) return null;
  const vertical = Math.abs(best.b.y - best.a.y) >= Math.abs(best.b.x - best.a.x);
  const clear = (x: number, y: number) =>
    obstacles.every((r) => !(x > r.x - 14 && x < r.x + r.w + 14 && y > r.y - 14 && y < r.y + r.h + 14));
  // 长线段中段优先；若中段被卡片盖住，退到 40%/60%、30%/70%。
  for (const at of [0.5, 0.4, 0.6, 0.3, 0.7]) {
    const midX = best.a.x + (best.b.x - best.a.x) * at;
    const midY = best.a.y + (best.b.y - best.a.y) * at;
    const x = midX + (vertical ? 10 : 0);
    const y = midY - (vertical ? 0 : 10);
    if (clear(x, y)) return { x, y, vertical };
  }
  return null;
}

export function PlantEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  data,
}: EdgeProps<PlantFlowEdge>) {
  const d = data!;
  const meta = STREAM_META[d.stream];
  const route =
    d.points.length > 0 ? polyline([{ x: sourceX, y: sourceY }, ...d.points, { x: targetX, y: targetY }]) : '';
  const [smooth] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 8,
  });
  const path = route || smooth;
  const label =
    d.showLabel && d.stream !== 'air'
      ? labelAnchor({ x: sourceX, y: sourceY }, d.points, { x: targetX, y: targetY }, d.obstacles)
      : null;

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      {d.animate && (
        <path
          d={path}
          fill="none"
          stroke="rgba(16,49,43,0.5)"
          strokeWidth={Math.max(1, meta.width * 0.45)}
          strokeDasharray="3 34"
          opacity={0.5}
          strokeLinecap="round"
          className="flow-pulse"
          style={{ animationDuration: `${d.duration}s` }}
        />
      )}
      {label && (
        <EdgeLabelRenderer>
          <div
            className="edge-label flow-edge-label"
            style={{ transform: `translate(-50%, -50%) translate(${label.x}px, ${label.y}px)` }}
          >
            {streamLabel(d.stream)}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
