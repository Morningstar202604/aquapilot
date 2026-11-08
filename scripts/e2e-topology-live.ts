import WebSocket from 'ws';
import { PLANT_TOPOLOGY } from '../src/model/topology';

const url = 'ws://127.0.0.1:5173/ws';
const ws = new WebSocket(url);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 只输出可验证的数值，不输出服务端文本。
 *
 * 这个脚本的作用是回答「新增的反应器有没有被真实求解」，需要的是
 * 池容、出水浓度、评分这类数字。服务端通知文本（拓扑名、错误详情）
 * 属于外部输入，把它打到终端既没有诊断价值，又让 ANSI 转义序列
 * （ESC[2J 清屏、CR 覆盖行）能把失败伪装成成功。
 *
 * 因此这里不做「净化后打印」，而是从根本上不打印它：
 * 文本类字段只输出长度与是否为空，数字按固定小数位格式化。
 */
const num = (v: unknown, digits = 3): string =>
  typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : 'n/a';

const count = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

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
    `应用前：反应器 ${num(before.reactorCount, 0)} | 池容 ${before.tanks
      .map((t: any) => num(t.volume, 0))
      .join('/')} | 出水 NH₄ ${num(before.effluent?.nh)} | 评分 ${num(before.score, 1)}`,
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
    // 不拼接通知正文：只报数量，正文可能是任意服务端字符串
    throw new Error(`未收到快照，应用可能失败（期间收到 ${noticeText.length} 条通知）`);
  }
  console.log(
    `应用后：反应器 ${num(after.reactorCount, 0)} | 池容 ${after.tanks
      .map((t: any) => num(t.volume, 0))
      .join('/')} | 出水 NH₄ ${num(after.effluent?.nh)} | 评分 ${num(after.score, 1)}`,
  );
  // 只打印数值：任何来自服务端的字符串都不进终端（避免转义序列伪造输出）
  const nameChars = after.tanks.reduce((n: number, t: any) => n + String(t.name ?? '').length, 0);
  console.log(`反应器数量：${count(after.tanks)}；名称长度合计：${nameChars}`);
  console.log(`通知条数：${noticeText.length}`);

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
