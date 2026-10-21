import { PLANT_TOPOLOGY, ProcessTopology, UnitSpec } from '../src/model/topology';
import { layoutTopology, PlacedNode, PlacedEdge } from '../src/model/layout';

function clone(t: ProcessTopology): ProcessTopology { return JSON.parse(JSON.stringify(t)); }

function addAerobic(t: ProcessTopology, n: number): ProcessTopology {
  const topo = clone(t);
  // insert 3 aerobic pools between aerobic3 and clarifier
  const insertAfter = 'aerobic3';
  const baseIdx = topo.train.indexOf(insertAfter);
  let prev = insertAfter;
  for (let i = 1; i <= n; i++) {
    const id = `aerobicX${i}`;
    const unit: UnitSpec = {
      id, kind: 'aerobic', name: `好氧池 X${i}`, role: '硝化 · 有机物氧化', volume: 5000,
      ports: [
        { id: 'in', kind: 'in', stream: 'mixed_liquor' },
        { id: 'out', kind: 'out', stream: 'mixed_liquor' },
        { id: 'air', kind: 'in', stream: 'air' },
      ],
    };
    topo.units.push(unit);
    topo.train.splice(baseIdx + i, 0, id);
    topo.connections = topo.connections.filter(c => !(c.from.unit === prev && c.to.unit === 'clarifier'));
    topo.connections.push({ id: `c-${prev}-${id}`, from: { unit: prev, port: 'out' }, to: { unit: id, port: 'in' }, stream: 'mixed_liquor' });
    // add air from blower
    topo.connections.push({ id: `c-blower-${id}`, from: { unit: 'blower', port: 'air' }, to: { unit: id, port: 'air' }, stream: 'air' });
    prev = id;
  }
  topo.connections.push({ id: `c-${prev}-clarifier`, from: { unit: prev, port: 'out' }, to: { unit: 'clarifier', port: 'in' }, stream: 'mixed_liquor' });
  return topo;
}

function rectsOverlap(a: {x:number,y:number,w:number,h:number}, b: {x:number,y:number,w:number,h:number}) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function segHitsRect(x1:number,y1:number,x2:number,y2:number, n: PlacedNode) {
  const minX = Math.min(x1,x2), maxX = Math.max(x1,x2), minY = Math.min(y1,y2), maxY = Math.max(y1,y2);
  return maxX > n.x && minX < n.x + n.w && maxY > n.y && minY < n.y + n.h;
}

function parse(path: string): {x1:number,y1:number,x2:number,y2:number}[] {
  const toks = path.split(/\s+/);
  const segs: any[] = [];
  let cx = 0, cy = 0;
  for (let i=0;i<toks.length;i++) {
    const t = toks[i];
    if (t === 'M') { cx = Number(toks[++i]); cy = Number(toks[++i]); }
    else if (t === 'H') { const x = Number(toks[++i]); segs.push({x1:cx,y1:cy,x2:x,y2:cy}); cx=x; }
    else if (t === 'V') { const y = Number(toks[++i]); segs.push({x1:cx,y1:cy,x2:cx,y2:y}); cy=y; }
  }
  return segs;
}

function audit(label: string, topo: ProcessTopology, opts: any) {
  const L = layoutTopology(topo, opts);
  const main = L.nodes.filter(n=>n.layer==='main');
  let nodeOverlaps: string[] = [];
  for (let i=0;i<L.nodes.length;i++) for (let j=i+1;j<L.nodes.length;j++) {
    if (rectsOverlap(L.nodes[i], L.nodes[j])) nodeOverlaps.push(`${L.nodes[i].unit.id}×${L.nodes[j].unit.id}`);
  }
  let edgeCross: string[] = [];
  for (const e of L.edges) {
    for (const s of parse(e.path)) {
      for (const n of L.nodes) {
        if (n.unit.id === e.connection.from.unit || n.unit.id === e.connection.to.unit) continue;
        if (segHitsRect(s.x1,s.y1,s.x2,s.y2,n)) edgeCross.push(`${e.connection.id} crosses ${n.unit.id}`);
      }
    }
  }
  let labelHitsNode: string[] = [];
  for (const e of L.edges) {
    for (const n of L.nodes) {
      if (e.connection.from.unit === n.unit.id || e.connection.to.unit === n.unit.id) continue;
      if (e.labelX > n.x && e.labelX < n.x+n.w && e.labelY > n.y && e.labelY < n.y+n.h) labelHitsNode.push(`${e.connection.id} label in ${n.unit.id}`);
    }
  }
  // edge labels overlapping each other (within 40x12 box)
  const labels = L.edges.filter(e=>e.path && e.connection.stream!=='air');
  let labelCollisions: string[] = [];
  for (let i=0;i<labels.length;i++) for (let j=i+1;j<labels.length;j++) {
    if (Math.abs(labels[i].labelX-labels[j].labelX) < 46 && Math.abs(labels[i].labelY-labels[j].labelY) < 12)
      labelCollisions.push(`${labels[i].connection.id} ~ ${labels[j].connection.id} @(${labels[i].labelX.toFixed(0)},${labels[i].labelY.toFixed(0)})`);
  }
  console.log(`\n=== ${label} ===`);
  console.log(`nodes=${L.nodes.length} edges=${L.edges.length} width=${L.width.toFixed(0)} height=${L.height.toFixed(0)} mainWidth=${main.reduce((m,n)=>Math.max(m,n.x+n.w),0).toFixed(0)}`);
  console.log('nodeOverlaps:', nodeOverlaps.length ? nodeOverlaps.join(', ') : 'none');
  console.log('edgeCrossNode:', edgeCross.length ? [...new Set(edgeCross)].join(' | ') : 'none');
  console.log('edgeLabelInNode:', labelHitsNode.length ? [...new Set(labelHitsNode)].join(' | ') : 'none');
  console.log('labelCollisions:', labelCollisions.length ? labelCollisions.join(' | ') : 'none');
  console.log('min x/y:', Math.min(...L.nodes.map(n=>n.x)), Math.min(...L.nodes.map(n=>n.y)));
  const minLabelY = Math.min(...L.edges.filter(e=>e.path).map(e=>e.labelY));
  const maxLabelY = Math.max(...L.edges.filter(e=>e.path).map(e=>e.labelY));
  console.log('label Y range:', minLabelY.toFixed(0), '..', maxLabelY.toFixed(0), ' canvas height', L.height.toFixed(0));
}

audit('standard monitor', PLANT_TOPOLOGY, { laneGap: 150 });
audit('standard compact', PLANT_TOPOLOGY, { compact: true });
const t3 = addAerobic(PLANT_TOPOLOGY, 3);
audit('+3 pools monitor', t3, { laneGap: 150 });
audit('+3 pools compact', t3, { compact: true });
