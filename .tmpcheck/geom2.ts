import { layoutTopology } from '../src/model/layout';
import { PLANT_TOPOLOGY } from '../src/model/topology';
function parsePath(d:string){const pts:[number,number][]=[];const toks=d.match(/[MHVL]/g)||[];const nums=d.match(/-?\d+(\.\d+)?/g)!.map(Number);let n=0,cur:[number,number]=[0,0];
for(const t of toks){if(t==='M'){cur=[nums[n++],nums[n++]];pts.push(cur);}else if(t==='H'){cur=[nums[n++],cur[1]];pts.push(cur);}else if(t==='V'){cur=[cur[0],nums[n++]];pts.push(cur);}else if(t==='L'){cur=[nums[n++],nums[n++]];pts.push(cur);}}return pts;}
const l=layoutTopology(PLANT_TOPOLOGY,{compact:false,laneGap:150});
console.log('NODES'); for(const n of l.nodes) console.log(n.unit.id.padEnd(14),`x=${n.x} y=${n.y} w=${n.w} h=${n.h} layer=${n.layer} lane=${n.lane}`);
console.log('\nEDGES'); for(const e of l.edges) console.log(e.connection.id.padEnd(28), e.path, ' label', e.labelX, e.labelY);
const eps=0.01;
function segHitsRect(a:[number,number],b:[number,number],r:{x:number;y:number;w:number;h:number}){
  const x1=Math.min(a[0],b[0]),x2=Math.max(a[0],b[0]),y1=Math.min(a[1],b[1]),y2=Math.max(a[1],b[1]);
  return x1 < r.x+r.w-eps && x2 > r.x+eps && y1 < r.y+r.h-eps && y2 > r.y+eps;
}
console.log('\nTRUE INTERSECTIONS'); const out:string[]=[];
for(const e of l.edges){const pts=parsePath(e.path);for(let k=0;k<pts.length-1;k++){for(const n of l.nodes){if(n.unit.id===e.connection.from.unit||n.unit.id===e.connection.to.unit)continue; if(segHitsRect(pts[k],pts[k+1],n)) out.push(`${e.connection.id} seg ${pts[k]}->${pts[k+1]} × ${n.unit.id} [${n.x},${n.y},${n.w},${n.h}]`);}}}
console.log(out.length?out:'none');
