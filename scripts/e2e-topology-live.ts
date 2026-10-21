import WebSocket from 'ws';
import { PLANT_TOPOLOGY } from '../src/model/topology';

const url = 'ws://127.0.0.1:5173/ws';
const ws = new WebSocket(url);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let snapshots: any[] = [];
let noticeText: string[] = [];

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'hello' }));
});

ws.on('message', (data) => {
  const m = JSON.parse(data.toString());
  if (m.type === 'snapshot') snapshots.push(m.data);
  if (m.type === 'notice') noticeText.push(m.text);
});

async function main() {
  await wait(2500);
  const before = snapshots[snapshots.length - 1];
  console.log(`应用前：反应器 ${before.reactorCount} | 池容 ${before.tanks.map((t: any) => t.volume).join('/')} | 出水 NH₄ ${before.effluent.nh.toFixed(3)} | 评分 ${before.score}`);

  // 构造 6 池拓扑：在好氧池 C 之后加一个好氧池 D
  const topo: any = JSON.parse(JSON.stringify(PLANT_TOPOLOGY));
  topo.units.push({
    id: 'aerobic4',
    kind: 'aerobic',
    name: '好氧池 D',
    role: '硝化 · 扩容',
    volume: 8000,
    ports: [
      { id: 'in', kind: 'in', stream: 'mixed_liquor' },
      { id: 'out', kind: 'out', stream: 'mixed_liquor' },
      { id: 'air', kind: 'in', stream: 'air' },
    ],
  });
  topo.train.push('aerobic4');
  topo.connections = topo.connections.filter((c: any) => c.id !== 'c-aerobic3-clarifier');
  topo.connections.push(
    { id: 'c-a3-a4', from: { unit: 'aerobic3', port: 'out' }, to: { unit: 'aerobic4', port: 'in' }, stream: 'mixed_liquor' },
    { id: 'c-a4-clarifier', from: { unit: 'aerobic4', port: 'out' }, to: { unit: 'clarifier', port: 'in' }, stream: 'mixed_liquor' },
    { id: 'c-blower-a4', from: { unit: 'blower', port: 'air' }, to: { unit: 'aerobic4', port: 'air' }, stream: 'air' },
  );

  snapshots = [];
  ws.send(JSON.stringify({ type: 'topology', action: 'apply', topology: topo }));
  await wait(6000);

  const after = snapshots[snapshots.length - 1];
  if (!after) {
    console.log('未收到快照，应用可能失败。通知：', noticeText);
    ws.close();
    return;
  }
  console.log(`应用后：反应器 ${after.reactorCount} | 池容 ${after.tanks.map((t: any) => t.volume).join('/')} | 出水 NH₄ ${after.effluent.nh.toFixed(3)} | 评分 ${after.score}`);
  console.log(`反应器名称：${after.tanks.map((t: any) => t.name).join(' / ')}`);
  console.log(`通知：${noticeText.join(' | ')}`);

  const ok = after.reactorCount === 6 && after.tanks.some((t: any) => t.id === 'aerobic4');
  console.log(`\n结论：界面/协议层新增的池子被引擎真实求解 — ${ok ? '是' : '否'}`);

  // 还原
  snapshots = [];
  ws.send(JSON.stringify({ type: 'topology', action: 'apply', topology: PLANT_TOPOLOGY }));
  await wait(5000);
  const restored = snapshots[snapshots.length - 1];
  console.log(`还原后：反应器 ${restored?.reactorCount} | 出水 NH₄ ${restored?.effluent.nh.toFixed(3)}`);
  ws.close();
}

void main();
