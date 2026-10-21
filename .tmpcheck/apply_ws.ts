import WebSocket from 'ws';
import { PLANT_TOPOLOGY, ProcessTopology } from '../src/model/topology';

const topo: ProcessTopology = JSON.parse(JSON.stringify(PLANT_TOPOLOGY));
let prev = 'aerobic3';
const idx = topo.train.indexOf('aerobic3');
for (let i=1;i<=3;i++){
  const id = `ax${i}`;
  topo.units.push({ id, kind:'aerobic', name:`好氧池 D${i}`, role:'硝化 · 有机物氧化', volume:5000, ports:[{id:'in',kind:'in',stream:'mixed_liquor'},{id:'out',kind:'out',stream:'mixed_liquor'},{id:'air',kind:'in',stream:'air'}] } as any);
  topo.train.splice(idx+i,0,id);
  topo.connections = topo.connections.filter(c=>!(c.from.unit===prev && c.to.unit==='clarifier'));
  topo.connections.push({ id:`c-${prev}-${id}`, from:{unit:prev,port:'out'}, to:{unit:id,port:'in'}, stream:'mixed_liquor' });
  topo.connections.push({ id:`c-blower-${id}`, from:{unit:'blower',port:'air'}, to:{unit:id,port:'air'}, stream:'air' });
  prev = id;
}
topo.connections.push({ id:`c-${prev}-clarifier`, from:{unit:prev,port:'out'}, to:{unit:'clarifier',port:'in'}, stream:'mixed_liquor' });

const ws = new WebSocket('ws://127.0.0.1:5199/ws');
ws.on('open', ()=> ws.send(JSON.stringify({type:'topology', action:'apply', topology: topo})));
ws.on('message', d=>{ const m=JSON.parse(d.toString()); if(m.type==='notice'||m.type==='topology') console.log(m.type, m.text ?? m.data?.units?.length ?? '', m.readiness?.ready ?? ''); if(m.type==='notice'){ setTimeout(()=>{ws.close();process.exit(0);},1500);} });
setTimeout(()=>process.exit(0), 8000);
