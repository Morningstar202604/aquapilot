import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:5199/ws');
let frames = [];
let t0 = Date.now();
ws.on('open', () => ws.send(JSON.stringify({type:'hello'})));
ws.on('message', (d) => {
  const s = d.toString();
  let m; try { m = JSON.parse(s); } catch { return; }
  if (m.type === 'snapshot') {
    frames.push({bytes: Buffer.byteLength(s), trends: m.data.trends.length, at: Date.now()-t0, alarms: m.data.alarms.length, forecast: m.data.forecast ? m.data.forecast.points.length : 0, tanks: m.data.tanks.length});
  }
});
setTimeout(() => {
  console.log('frames captured:', frames.length);
  if (frames.length) {
    const sizes = frames.map(f=>f.bytes);
    console.log('first:', frames[0]);
    console.log('last:', frames[frames.length-1]);
    console.log('avg bytes:', Math.round(sizes.reduce((a,b)=>a+b,0)/sizes.length));
    console.log('max bytes:', Math.max(...sizes));
    const deltas = frames.slice(1).map((f,i)=>f.at-frames[i].at);
    console.log('intervals(ms):', deltas.slice(0,12).join(','));
  }
  // measure serialization cost server side proxy: snapshot JSON size extrapolation
  ws.close(); process.exit(0);
}, 12000);
