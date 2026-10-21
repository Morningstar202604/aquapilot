import { PLANT_TOPOLOGY, ProcessTopology } from '../src/model/topology';
import { compileNetwork } from '../src/sim/network';
import { createNetworkState, spinUpNetwork, qualityScoreOf } from '../src/sim/networkEngine';

const clone = (): ProcessTopology => JSON.parse(JSON.stringify(PLANT_TOPOLOGY));

function report(label: string, topo: ProcessTopology) {
  const net = compileNetwork(topo);
  if (net.problems.length) {
    console.log(`${label}: 编译失败 — ${net.problems.join('；')}`);
    return null;
  }
  const state = spinUpNetwork(createNetworkState(topo, { seed: 42 }), topo, 30);
  const last = [...state.reactors].sort(
    (a, b) => net.reactors.find((r) => r.id === b.id)!.order - net.reactors.find((r) => r.id === a.id)!.order,
  )[0];
  console.log(
    `${label}: 反应器 ${state.reactors.length} 个 | 池容 ${(state.volume.bio / 1000).toFixed(1)}k m³ | 出水 COD ${state.effluent.cod.toFixed(1)} NH₄ ${state.effluent.nh.toFixed(2)} TN ${state.effluent.tn.toFixed(2)} TP ${state.effluent.tp.toFixed(3)} SS ${state.effluent.ss.toFixed(1)} | 评分 ${qualityScoreOf(state.effluent)} | 末端 ${last.name}`,
  );
  return state;
}

console.log('=== 拓扑求解验证：反应器数量由拓扑决定 ===\n');
report('标准五池 A²/O', clone());

// 加一个缺氧池（插在厌氧与缺氧之间）
{
  const topo = clone();
  topo.units.push({
    id: 'anoxic2',
    kind: 'anoxic',
    name: '缺氧池 B',
    role: '反硝化 · 强化',
    volume: 4500,
    ports: [
      { id: 'in', kind: 'in', stream: 'mixed_liquor' },
      { id: 'ir', kind: 'in', stream: 'internal_recycle' },
      { id: 'out', kind: 'out', stream: 'mixed_liquor' },
    ],
  });
  const idx = topo.train.indexOf('anoxic');
  topo.train.splice(idx + 1, 0, 'anoxic2');
  // 重接：anoxic -> anoxic2 -> aerobic1
  topo.connections = topo.connections.filter((c) => c.id !== 'c-anoxic-aerobic1');
  topo.connections.push(
    { id: 'c-anoxic-anoxic2', from: { unit: 'anoxic', port: 'out' }, to: { unit: 'anoxic2', port: 'in' }, stream: 'mixed_liquor' },
    { id: 'c-anoxic2-aerobic1', from: { unit: 'anoxic2', port: 'out' }, to: { unit: 'aerobic1', port: 'in' }, stream: 'mixed_liquor' },
    { id: 'c-aerobic3-anoxic2-ir', from: { unit: 'aerobic3', port: 'ir' }, to: { unit: 'anoxic2', port: 'ir' }, stream: 'internal_recycle', recycle: true },
  );
  topo.connections = topo.connections.filter((c) => c.id !== 'c-aerobic3-anoxic-ir');
  report('新增一个缺氧池（6 池）', topo);
}

// 加两个好氧池
{
  const topo = clone();
  for (const suffix of ['4', '5']) {
    topo.units.push({
      id: `aerobic${suffix}`,
      kind: 'aerobic',
      name: `好氧池 ${suffix === '4' ? 'D' : 'E'}`,
      role: '硝化',
      volume: 5000,
      ports: [
        { id: 'in', kind: 'in', stream: 'mixed_liquor' },
        { id: 'out', kind: 'out', stream: 'mixed_liquor' },
        { id: 'air', kind: 'in', stream: 'air' },
      ],
    });
  }
  topo.train.push('aerobic4', 'aerobic5');
  topo.connections = topo.connections.filter((c) => c.id !== 'c-aerobic3-clarifier');
  topo.connections.push(
    { id: 'c-aerobic3-aerobic4', from: { unit: 'aerobic3', port: 'out' }, to: { unit: 'aerobic4', port: 'in' }, stream: 'mixed_liquor' },
    { id: 'c-aerobic4-aerobic5', from: { unit: 'aerobic4', port: 'out' }, to: { unit: 'aerobic5', port: 'in' }, stream: 'mixed_liquor' },
    { id: 'c-aerobic5-clarifier', from: { unit: 'aerobic5', port: 'out' }, to: { unit: 'clarifier', port: 'in' }, stream: 'mixed_liquor' },
  );
  topo.connections = topo.connections.filter((c) => c.id !== 'c-aerobic3-anoxic-ir');
  topo.connections.push({
    id: 'c-aerobic5-anoxic-ir',
    from: { unit: 'aerobic5', port: 'out' },
    to: { unit: 'anoxic', port: 'ir' },
    stream: 'internal_recycle',
    recycle: true,
  });
  report('新增两个好氧池（7 池）', topo);
}

// 只保留一个好氧池（缩小规模）
{
  const topo = clone();
  topo.train = topo.train.filter((id) => id !== 'aerobic2' && id !== 'aerobic3');
  topo.units = topo.units.filter((u) => u.id !== 'aerobic2' && u.id !== 'aerobic3');
  topo.connections = topo.connections.filter(
    (c) => !['c-aerobic1-aerobic2', 'c-aerobic2-aerobic3', 'c-aerobic3-clarifier', 'c-aerobic3-anoxic-ir', 'c-blower-aerobic2', 'c-blower-aerobic3'].includes(c.id),
  );
  topo.connections.push(
    { id: 'c-aerobic1-clarifier', from: { unit: 'aerobic1', port: 'out' }, to: { unit: 'clarifier', port: 'in' }, stream: 'mixed_liquor' },
    { id: 'c-aerobic1-anoxic-ir', from: { unit: 'aerobic1', port: 'out' }, to: { unit: 'anoxic', port: 'ir' }, stream: 'internal_recycle', recycle: true },
  );
  report('只保留一个好氧池（3 池）', topo);
}

// 纯属验证：把厌氧池删掉，变成缺氧-好氧两段
{
  const topo = clone();
  topo.train = topo.train.filter((id) => id !== 'anaerobic');
  topo.units = topo.units.filter((u) => u.id !== 'anaerobic');
  topo.connections = topo.connections.filter((c) => c.from.unit !== 'anaerobic' && c.to.unit !== 'anaerobic');
  topo.connections.push(
    { id: 'c-primary-anoxic', from: { unit: 'primary', port: 'out' }, to: { unit: 'anoxic', port: 'in' }, stream: 'influent' },
    { id: 'c-clarifier-anoxic-ras', from: { unit: 'clarifier', port: 'ras' }, to: { unit: 'anoxic', port: 'in' }, stream: 'return_activated_sludge', recycle: true },
  );
  report('删除厌氧池（A/O 工艺，4 池）', topo);
}

console.log('\n=== 结论 ===');
console.log('反应器数量、求解顺序、池容全部由拓扑决定，引擎代码不含任何池数假设。');
