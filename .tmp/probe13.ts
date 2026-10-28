import { PLANT_TOPOLOGY } from '../src/model/topology';
import { layoutTopology } from '../src/model/layout';
const clone=()=>JSON.parse(JSON.stringify(PLANT_TOPOLOGY));
// reorder stepfeed before anaerobic
let t:any=clone();
const idx=t.connections.findIndex((c:any)=>c.id==='c-primary-anoxic-stepfeed');
const [sf]=t.connections.splice(idx,1);
const ai=t.connections.findIndex((c:any)=>c.id==='c-primary-anaerobic');
t.connections.splice(ai,0,sf);
const l=layoutTopology(t);
console.log('order',l.nodes.map((n:any)=>n.unit.id).join(' > '));
console.log('x',l.nodes.map((n:any)=>`${n.unit.id}:${n.x}`).join(' '));
