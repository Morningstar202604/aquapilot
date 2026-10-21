import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:5199/ws');
ws.on('open', () => ws.send(JSON.stringify({type:'hello'})));
ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.type !== 'snapshot') return;
  const base = m.data.trends;
  const one = base[base.length-1];
  const filled = Array.from({length:720}, (_,i)=>({...one, t: i*20}));
  m.data.trends = filled;
  const bytes = Buffer.byteLength(JSON.stringify(m));
  console.log('trend point bytes:', Buffer.byteLength(JSON.stringify(one)));
  console.log('snapshot with 720 trends bytes:', bytes, '=', (bytes/1024).toFixed(1), 'KB');
  console.log('per-client per-minute (1Hz):', (bytes*60/1024/1024).toFixed(2), 'MB/min;  10 clients:', (bytes*60*10/1024/1024).toFixed(1), 'MB/min');
  console.log('forecast points:', m.data.forecast?.points.length, 'alarms hist:', m.data.alarms.length, 'margins:', m.data.margins.length);
  ws.close(); process.exit(0);
});
