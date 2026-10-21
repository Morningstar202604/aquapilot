import WebSocket from 'ws';

const url = 'ws://127.0.0.1:5173/ws';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function attack(label: string, payload: string) {
  return new Promise<void>((resolve) => {
    const ws = new WebSocket(url);
    const notices: string[] = [];
    ws.on('open', () => ws.send(payload));
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'notice') notices.push(m.text);
    });
    ws.on('close', () => resolve());
    ws.on('error', () => resolve());
    setTimeout(() => {
      console.log(`  ${label.padEnd(28)} → ${notices.length ? '已拒绝: ' + notices[0].slice(0, 40) : '无响应'}`);
      ws.close();
      resolve();
    }, 1200);
  });
}

console.log('=== WebSocket 攻击测试 ===');
await attack('null 消息', 'null');
await attack('空对象', '{}');
await attack('数组', '[]');
await attack('topology=null', JSON.stringify({ type: 'topology', action: 'apply', topology: null }));
await attack('control 非法值', JSON.stringify({ type: 'control', patch: { doSetpoint: null, rasRatio: 'abc' } }));
await attack('control 越界值', JSON.stringify({ type: 'control', patch: { doSetpoint: 1e9, pacDose: 1e6 } }));
await attack('speed=abc', JSON.stringify({ type: 'speed', value: 'abc' }));
await attack('未知场景', JSON.stringify({ type: 'scenario', kind: 'start', scenario: 'nuke' }));
await attack('超长文本', JSON.stringify({ type: 'chat', text: 'x'.repeat(5000) }));

await wait(500);
console.log('\n=== 服务存活检查 ===');
const res = await fetch('http://127.0.0.1:5173/api/snapshot').catch(() => null);
console.log('  /api/snapshot:', res?.status ?? 'DEAD');
if (res?.ok) {
  const d = await res.json();
  console.log('  出水 COD:', d.effluent.cod?.toFixed?.(1), 'NH4:', d.effluent.nh?.toFixed?.(2));
  console.log('  控制量 doSetpoint:', d.controls.doSetpoint, '(应仍为合法值)');
}
