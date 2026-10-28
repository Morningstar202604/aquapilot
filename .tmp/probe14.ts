import { PLANT_TOPOLOGY } from '../src/model/topology';
import { layoutTopology } from '../src/model/layout';
const clone=()=>JSON.parse(JSON.stringify(PLANT_TOPOLOGY));
// manual positions: two nodes overlap after drag
const t:any=clone();
t.positions={ inlet:{x:100,y:100}, screening:{x:100,y:100} };
const l=layoutTopology(t);
console.log('overlap manual',l.nodes.filter((n:any)=>['inlet','screening'].includes(n.unit.id)).map((n:any)=>({id:n.unit.id,x:n.x,y:n.y,w:n.w})));
// width when manual node at MAX_COORD
const t2:any=clone(); t2.positions={inlet:{x:20000,y:100}};
const l2=layoutTopology(t2); const n=l2.nodes.find((x:any)=>x.unit.id==='inlet');
console.log('maxcoord width',l2.width,'inlet',n?.x,n?.w,'expected right',n!.x+n!.w);
