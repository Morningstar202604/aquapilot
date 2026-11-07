import WebSocket from 'ws';
import { PLANT_TOPOLOGY } from '../src/model/topology';

const url = 'ws://127.0.0.1:5173/ws';
const ws = new WebSocket(url);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 终端输出净化。
 *
 * `noticeText` 里的字符串来自服务端广播，而服务端会把用户可控内容
 * （拓扑名、场景名、错误详情）拼进提示。直接 console.log 会让
 * ANSI 转义序列生效：ESC[2J 清屏、CR 覆盖已打印的行，
 * 一个伪造的通知就能把整段诊断输出伪装成「全部通过」。
 * 这里剥离控制字符，只保留可打印文本。
 */
const CONTROL_CHARS = new RegExp('[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]', 'g');
const safe = (v: unknown): string => String(v).replace(CONTROL_CHARS, '?').replace(new RegExp('[\r\n]+', 'g'), ' ');
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
  if (!before) {
    ws.close();
    throw new Error('应用前未收到快照');
  }
  console.log(
    safe(
      `应用前：反应器 ${before.reactorCount} | 池容 ${before.tanks.map((t: any) => t.volume).join('/')} | 出水 NH₄ ${before.effluent.nh.toFixed(3)} | 评分 ${before.score}`,
    ),
  );

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
    {
      id: 'c-a3-a4',
      from: { unit: 'aerobic3', port: 'out' },
      to: { unit: 'aerobic4', port: 'in' },
      stream: 'mixed_liquor',
    },
    {
      id: 'c-a4-clarifier',
      from: { unit: 'aerobic4', port: 'out' },
      to: { unit: 'clarifier', port: 'in' },
      stream: 'mixed_liquor',
    },
    { id: 'c-blower-a4', from: { unit: 'blower', port: 'air' }, to: { unit: 'aerobic4', port: 'air' }, stream: 'air' },
  );

  snapshots = [];
  ws.send(JSON.stringify({ type: 'topology', action: 'apply', topology: topo }));
  await wait(6000);

  const after = snapshots[snapshots.length - 1];
  if (!after) {
    ws.close();
    throw new Error(safe(`未收到快照，应用可能失败。通知：${noticeText.join(' | ')}`));
  }
  console.log(
    safe(
      `应用后：反应器 ${after.reactorCount} | 池容 ${after.tanks.map((t: any) => t.volume).join('/')} | 出水 NH₄ ${after.effluent.nh.toFixed(3)} | 评分 ${after.score}`,
    ),
  );
  console.log(safe(`反应器名称：${after.tanks.map((t: any) => t.name).join(' / ')}`));
  console.log(safe(`通知：${noticeText.join(' | ')}`));

  const ok = after.reactorCount === 6 && after.tanks.some((t: any) => t.id === 'aerobic4');
  console.log(`\n结论：界面/协议层新增的池子被引擎真实求解 — ${ok ? '是' : '否'}`);
  if (!ok) {
    ws.close();
    throw new Error('新增拓扑未被引擎真实求解');
  }

  // 还原
  snapshots = [];
  ws.send(JSON.stringify({ type: 'topology', action: 'apply', topology: PLANT_TOPOLOGY }));
  await wait(5000);
  const restored = snapshots[snapshots.length - 1];
  if (!restored || restored.reactorCount !== PLANT_TOPOLOGY.train.length) {
    ws.close();
    throw new Error(`还原后拓扑异常：${restored?.reactorCount ?? '无快照'}`);
  }
  console.log(`还原后：反应器 ${restored.reactorCount} | 出水 NH₄ ${restored.effluent.nh.toFixed(3)}`);
  ws.close();
}

void main();
