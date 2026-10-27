import type { ProcessTopology } from './topology';
import type { TankState } from '../sim/plantTypes';

/**
 * 主序列沿程剖面。
 *
 * 单元检视器给的是「这个池子现在怎么样」，操作员还需要「水从第一个池到
 * 最后一个池是怎么变的」——沿程 DO/氨氮/硝酸盐的走势是判断硝化与反硝化
 * 是否发生在上游段、厌氧区是否被内回流带氧的直接证据。
 *
 * 纯函数：输入拓扑 + 快照里的反应器状态，输出按 train 顺序排列的行。
 * 这样不依赖 React 也能验证顺序、缺失单元与当前单元高亮。
 */

export interface TrainProfileRow {
  index: number;
  id: string;
  name: string;
  kind: 'anaerobic' | 'anoxic' | 'aerobic';
  volume: number;
  /** 是否有实时状态（拓扑里的池子可能还没被求解器实例化） */
  live: boolean;
  do: number;
  nh: number;
  no3: number;
  tp: number;
  mlss: number;
  /** 是否为检视器当前打开的单元 */
  current: boolean;
}

export function buildTrainProfile(topo: ProcessTopology, tanks: TankState[], currentUnitId: string): TrainProfileRow[] {
  const byId = new Map(tanks.map((t) => [t.id, t]));
  const rows: TrainProfileRow[] = [];
  topo.train.forEach((id, i) => {
    const spec = topo.units.find((u) => u.id === id);
    if (!spec) return;
    const live = byId.get(id);
    const kind = spec.kind === 'anaerobic' || spec.kind === 'anoxic' ? spec.kind : 'aerobic';
    rows.push({
      index: i + 1,
      id,
      name: spec.name,
      kind,
      volume: spec.volume ?? live?.volume ?? 0,
      live: Boolean(live),
      do: live?.do ?? 0,
      nh: live?.nh ?? 0,
      no3: live?.no3 ?? 0,
      tp: live?.tp ?? 0,
      mlss: live?.mlss ?? 0,
      current: id === currentUnitId,
    });
  });
  return rows;
}

/**
 * 沿程是否需要展示。
 *
 * 三个条件缺一不可：至少两行（单池没有"沿程"）、至少一行有实时数据
 * （否则只是拓扑清单）、且当前单元本身在主序列里（在鼓风机上开检视器
 * 不该看到反应池沿程——那是别的单元的信息）。
 */
export function shouldShowTrainProfile(rows: TrainProfileRow[]): boolean {
  return rows.length >= 2 && rows.some((r) => r.live) && rows.some((r) => r.current);
}
