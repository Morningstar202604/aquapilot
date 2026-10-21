import { layoutTopology } from '../src/model/layout';
import { PLANT_TOPOLOGY, ProcessTopology, UnitSpec } from '../src/model/topology';

function overlaps(t: ProcessTopology, label: string) {
  const l = layoutTopology(t, { compact: false, laneGap: 150 });
  const nodes = l.nodes;
  const boxes: string[] = [];
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i], b = nodes[j];
    if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) {
      boxes.push(`${a.unit.id}[${a.x},${a.y},${a.w}x${a.h}] ∩ ${b.unit.id}[${b.x},${b.y}]`);
    }
  }
  // labels inside node rects
  const labelHits: string[] = [];
  for (const e of l.edges) {
    if (!e.path) continue;
    for (const n of nodes) {
      if (e.labelX > n.x && e.labelX < n.x + n.w && e.labelY > n.y && e.labelY < n.y + n.h) {
        labelHits.push(`${e.connection.id} label inside ${n.unit.id}`);
      }
    }
  }
  const offTop = l.edges.filter(e => e.labelY < 0).map(e => `${e.connection.id}@y=${e.labelY}`);
  console.log(`\n== ${label} == size ${l.width}x${l.height} nodes ${nodes.length}`);
  console.log('overlaps:', boxes.length ? boxes : 'none');
  console.log('label-inside-node:', labelHits.length ? labelHits : 'none');
  console.log('label above canvas:', offTop.length ? offTop : 'none');
  console.log('edge sample:', l.edges.slice(0,3).map(e=>`${e.connection.id}: ${e.path}`));
}

overlaps(PLANT_TOPOLOGY, 'base');
const addAerobic: ProcessTopology = { ...PLANT_TOPOLOGY, units: [...PLANT_TOPOLOGY.units], train: [...PLANT_TOPOLOGY.train] };
for (let i=0;i<6;i++){
  const id = `aerobicX${i}`;
  addAerobic.units.push({ id, kind:'aerobic', name:`好氧池 ${i}`, role:'硝化', volume:5000, ports:[{id:'in',kind:'in',stream:'mixed_liquor'},{id:'out',kind:'out',stream:'mixed_liquor'},{id:'air',kind:'in',stream:'air'}] } as UnitSpec);
  addAerobic.train.push(id);
}
addAerobic.connections = [...PLANT_TOPOLOGY.connections];
let prev = 'aerobic3';
for (let i=0;i<6;i++){ const id=`aerobicX${i}`; addAerobic.connections.push({id:`c-${prev}-${id}`,from:{unit:prev,port:'out'},to:{unit:id,port:'in'},stream:'mixed_liquor'}); prev=id; }
overlaps(addAerobic, 'base + 6 aerobic in series (train appended, but disconnected in layout order)');

// empty
overlaps({ id:'x', name:'x', units:[], connections:[], train:[] } as ProcessTopology, 'empty topology');
