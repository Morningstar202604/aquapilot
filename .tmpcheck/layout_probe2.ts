import { PLANT_TOPOLOGY, ProcessTopology, UnitSpec } from '../src/model/topology';
import { layoutTopology, PlacedNode } from '../src/model/layout';

const clone = (t: ProcessTopology): ProcessTopology => JSON.parse(JSON.stringify(t));
const rectsOverlap = (a:any,b:any)=> a.x < b.x+b.w && b.x < a.x+a.w && a.y < b.y+b.h && b.y < a.y+a.h;
function segs(path:string){const toks=path.split(/\s+/);const out:any[]=[];let cx=0,cy=0;for(let i=0;i<toks.length;i++){const t=toks[i];if(t==='M'){cx=+toks[++i];cy=+toks[++i];}else if(t==='H'){const x=+toks[++i];out.push({x1:cx,y1:cy,x2:x,y2:cy});cx=x;}else if(t==='V'){const y=+toks[++i];out.push({x1:cx,y1:cy,x2:cx,y2:y});cy=y;}}return out;}
function audit(label:string, topo:ProcessTopology, opts:any={}) {
  const L = layoutTopology(topo, opts);
  const overlaps:string[]=[];
  for(let i=0;i<L.nodes.length;i++)for(let j=i+1;j<L.nodes.length;j++) if(rectsOverlap(L.nodes[i],L.nodes[j])) overlaps.push(`${L.nodes[i].unit.id}×${L.nodes[j].unit.id}`);
  const crosses:string[]=[];
  for(const e of L.edges){for(const s of segs(e.path)){for(const n of L.nodes){if(n.unit.id===e.connection.from.unit||n.unit.id===e.connection.to.unit)continue;const minX=Math.min(s.x1,s.x2),maxX=Math.max(s.x1,s.x2),minY=Math.min(s.y1,s.y2),maxY=Math.max(s.y1,s.y2);if(maxX>n.x&&minX<n.x+n.w&&maxY>n.y&&minY<n.y+n.h)crosses.push(`${e.connection.id}→${n.unit.id}`);}}}
  const backwards = L.edges.filter(e=>{const f=L.nodes.find(n=>n.unit.id===e.connection.from.unit);const t=L.nodes.find(n=>n.unit.id===e.connection.to.unit);return f&&t&&t.x < f.x;}).map(e=>`${e.connection.id}(${e.connection.from.unit}→${e.connection.to.unit})`);
  console.log(`\n=== ${label} ===`);
  console.log(`nodes=${L.nodes.length} edges=${L.edges.length} size=${L.width.toFixed(0)}x${L.height.toFixed(0)}`);
  console.log('node overlaps:', overlaps.length?overlaps.join(', '):'none');
  console.log('edges crossing nodes:', crosses.length?crosses.length+' ['+[...new Set(crosses)].slice(0,8).join(' | ')+']':'none');
  console.log('backward edges:', backwards.length?backwards.join(', '):'none');
  console.log('min labelY:', Math.min(...L.edges.filter(e=>e.path).map(e=>e.labelY)).toFixed(0));
  return L;
}

// 1. empty topology (user deletes every unit)
audit('empty topology', {id:'x',name:'x',units:[],connections:[],train:[]});
// 2. only inlet/outlet
audit('two units', {id:'x',name:'x',units:PLANT_TOPOLOGY.units.filter(u=>u.kind==='inlet'||u.kind==='outlet'),connections:[],train:[]});

// 3. parallel trains: primary.out -> aerobicA/B, both -> clarifier
const par = clone(PLANT_TOPOLOGY);
const mk=(id:string,name:string):UnitSpec=>({id,kind:'aerobic',name,role:'硝化',volume:5000,ports:[{id:'in',kind:'in',stream:'mixed_liquor'},{id:'out',kind:'out',stream:'mixed_liquor'},{id:'air',kind:'in',stream:'air'}]});
par.units = par.units.filter(u=>!['aerobic1','aerobic2','aerobic3'].includes(u.id));
par.connections = par.connections.filter(c=>!c.from.unit.startsWith('aerobic')&&!c.to.unit.startsWith('aerobic')&&c.id!=='c-anaerobic-anoxic');
par.train = ['anaerobic','anoxic','aerobicA','aerobicB'];
par.units.push(mk('aerobicA','好氧池 A'),mk('aerobicB','好氧池 B'));
par.connections.push(
 {id:'c-anoxic-a',from:{unit:'anoxic',port:'out'},to:{unit:'aerobicA',port:'in'},stream:'mixed_liquor'},
 {id:'c-anoxic-b',from:{unit:'anoxic',port:'out'},to:{unit:'aerobicB',port:'in'},stream:'mixed_liquor'},
 {id:'c-a-clar',from:{unit:'aerobicA',port:'out'},to:{unit:'clarifier',port:'in'},stream:'mixed_liquor'},
 {id:'c-b-clar',from:{unit:'aerobicB',port:'out'},to:{unit:'clarifier',port:'in'},stream:'mixed_liquor'},
 {id:'c-blower-a',from:{unit:'blower',port:'air'},to:{unit:'aerobicA',port:'air'},stream:'air'},
 {id:'c-blower-b',from:{unit:'blower',port:'air'},to:{unit:'aerobicB',port:'air'},stream:'air'},
);
audit('parallel trains (reachable via UI)', par, {compact:true});

// 4. ten extra aerobic pools
const big = clone(PLANT_TOPOLOGY);
let prev='aerobic3';
const base=big.train.indexOf('aerobic3');
for(let i=1;i<=10;i++){
  const id=`ax${i}`;
  big.units.push({id,kind:'aerobic',name:`好氧 ${i}`,role:'硝化',volume:5000,ports:[{id:'in',kind:'in',stream:'mixed_liquor'},{id:'out',kind:'out',stream:'mixed_liquor'},{id:'air',kind:'in',stream:'air'}]});
  big.train.splice(base+i,0,id);
  big.connections=big.connections.filter(c=>!(c.from.unit===prev&&c.to.unit==='clarifier'));
  big.connections.push({id:`e${i}`,from:{unit:prev,port:'out'},to:{unit:id,port:'in'},stream:'mixed_liquor'});
  big.connections.push({id:`a${i}`,from:{unit:'blower',port:'air'},to:{unit:id,port:'air'},stream:'air'});
  prev=id;
}
big.connections.push({id:'last-clar',from:{unit:prev,port:'out'},to:{unit:'clarifier',port:'in'},stream:'mixed_liquor'});
audit('+10 pools monitor', big, {laneGap:150});
audit('+10 pools compact', big, {compact:true});
