import { layoutTopology, PlacedNode } from '../src/model/layout';
import { PLANT_TOPOLOGY, ProcessTopology, UnitSpec } from '../src/model/topology';

function parsePath(d: string) {
  const pts: [number,number][] = [];
  const toks = d.match(/[MHVL]/g) || [];
  let i=0; const nums = d.match(/-?\d+(\.\d+)?/g)!.map(Number); let n=0; let cur:[number,number]=[0,0];
  for (const t of toks) {
    if (t==='M'){cur=[nums[n++],nums[n++]];pts.push(cur);}
    else if(t==='H'){cur=[nums[n++],cur[1]];pts.push(cur);}
    else if(t==='V'){cur=[cur[0],nums[n++]];pts.push(cur);}
    else if(t==='L'){cur=[nums[n++],nums[n++]];pts.push(cur);}
  }
  return pts;
}
function segIntersect(a:[number,number],b:[number,number],c:[number,number],d:[number,number]){
  const s=(p:[number,number],q:[number,number],r:[number,number])=>Math.sign((q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]));
  return s(a,b,c)*s(a,b,d)<0 && s(c,d,a)*s(c,d,b)<0;
}
function check(t: ProcessTopology,label:string){
  const l=layoutTopology(t,{compact:false,laneGap:150});
  const crossNodes:string[]=[]; const crossEdges:string[]=[];
  for(const e of l.edges){ if(!e.path) continue; const pts=parsePath(e.path);
    for(let k=0;k<pts.length-1;k++){const a=pts[k],b=pts[k+1];
      for(const n of l.nodes){ if(n.unit.id===e.connection.from.unit||n.unit.id===e.connection.to.unit) continue;
        // skip horizontal segment inside node y-range crossing node x-range
        const x1=Math.min(a[0],b[0]),x2=Math.max(a[0],b[0]),y1=Math.min(a[1],b[1]),y2=Math.max(a[1],b[1]);
        if(x1 < n.x+n.w && x2 > n.x && y1 < n.y+n.h && y2 > n.y){ crossNodes.push(`${e.connection.id} × ${n.unit.id} @${Math.round(x1)},${Math.round(y1)}`);}
      }
    }
  }
  for(let i=0;i<l.edges.length;i++)for(let j=i+1;j<l.edges.length;j++){
    const A=l.edges[i],B=l.edges[j]; if(!A.path||!B.path) continue;
    const pa=parsePath(A.path),pb=parsePath(B.path);
    for(let k=0;k<pa.length-1;k++)for(let m=0;m<pb.length-1;m++) if(segIntersect(pa[k],pa[k+1],pb[m],pb[m+1])) crossEdges.push(`${A.connection.id} × ${B.connection.id}`);
  }
  console.log(`\n== ${label} ==`);
  console.log('edge-through-node:', [...new Set(crossNodes)].length? [...new Set(crossNodes)]:'none');
  console.log('edge-edge crossings:', [...new Set(crossEdges)].length? [...new Set(crossEdges)]:'none');
}
check(PLANT_TOPOLOGY,'base');

// storage inline variant: inlet->storage->screening...
const inline: ProcessTopology = JSON.parse(JSON.stringify(PLANT_TOPOLOGY));
inline.connections = inline.connections.filter((c:any)=>c.id!=='c-inlet-screen'&&c.id!=='c-primary-storm-route'&&c.id!=='c-storm-anaerobic');
inline.connections.unshift({id:'c-inlet-storm',from:{unit:'inlet',port:'out'},to:{unit:'stormstore',port:'in'},stream:'influent'});
inline.connections.unshift({id:'c-storm-screen',from:{unit:'stormstore',port:'out'},to:{unit:'screening',port:'in'},stream:'influent'});
check(inline,'storage inline');

// 4 parallel trains of 3 aerobic each + 3 clarifiers? use parallel branch
const par: ProcessTopology = JSON.parse(JSON.stringify(PLANT_TOPOLOGY));
par.units.push({id:'aerobicB1',kind:'aerobic',name:'好氧 B1',role:'硝化',volume:5000,ports:[{id:'in',kind:'in',stream:'mixed_liquor'},{id:'out',kind:'out',stream:'mixed_liquor'},{id:'air',kind:'in',stream:'air'}]} as UnitSpec);
par.train.push('aerobicB1');
par.connections.push({id:'c-anoxic-b1',from:{unit:'anoxic',port:'out'},to:{unit:'aerobicB1',port:'in'},stream:'mixed_liquor'});
par.connections.push({id:'c-b1-clar',from:{unit:'aerobicB1',port:'out'},to:{unit:'clarifier',port:'in'},stream:'mixed_liquor'});
check(par,'parallel branch anoxic->aerobicB1->clarifier');

// many storage
const many: ProcessTopology = JSON.parse(JSON.stringify(PLANT_TOPOLOGY));
for(let i=0;i<5;i++){ many.units.push({id:`store${i}`,kind:'storage',name:`调蓄${i}`,role:'削峰',volume:16000,ports:[{id:'in',kind:'in',stream:'influent'},{id:'out',kind:'out',stream:'influent'}]} as UnitSpec);
  many.connections.push({id:`c-p-s${i}`,from:{unit:'primary',port:'out'},to:{unit:`store${i}`,port:'in'},stream:'influent'});
  many.connections.push({id:`c-s${i}-a`,from:{unit:`store${i}`,port:'out'},to:{unit:'anaerobic',port:'in'},stream:'influent'});
}
check(many,'5 storage pools');
