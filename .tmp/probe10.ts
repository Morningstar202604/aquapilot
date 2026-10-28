import { PLANT_TOPOLOGY } from '../src/model/topology';
import { sanitizeTopologyInput } from '../src/model/topologyInput';
import { createRuntime, stepRuntime } from '../src/server/topologyRuntime';

const clone=()=>JSON.parse(JSON.stringify(PLANT_TOPOLOGY));
let t:any=clone();
t.units.push({id:'aerobicX',kind:'aerobic',name:'X',role:'',volume:1000,ports:[{id:'in',kind:'in',stream:'mixed_liquor'},{id:'out',kind:'out',stream:'mixed_liquor'}]});
t.units.push({id:'aerobicY',kind:'aerobic',name:'Y',role:'',volume:1000,ports:[{id:'in',kind:'in',stream:'mixed_liquor'},{id:'out',kind:'out',stream:'mixed_liquor'}]});
t.units.push({id:'splitX',kind:'splitter',name:'splitX',role:'',ports:[{id:'in',kind:'in',stream:'mixed_liquor'},{id:'out',kind:'out',stream:'mixed_liquor'}]});
t.connections.push({id:'sx-in',from:{unit:'aerobic3',port:'out'},to:{unit:'splitX',port:'in'},stream:'mixed_liquor'});
t.connections.push({id:'sx-out',from:{unit:'splitX',port:'out'},to:{unit:'aerobicX',port:'in'},stream:'mixed_liquor'});
t.connections.push({id:'xy',from:{unit:'aerobicX',port:'out'},to:{unit:'aerobicY',port:'in'},stream:'mixed_liquor'});
t.connections.push({id:'y-out',from:{unit:'aerobicY',port:'out'},to:{unit:'aerobic2',port:'in'},stream:'mixed_liquor'});
t.train=['aerobicX','anaerobic','anoxic','aerobic1','aerobic2','aerobic3'];
const sv=sanitizeTopologyInput(t);
if(sv.ok){
 try{const rt=createRuntime(sv.topology); console.log('createRuntime OK'); stepRuntime(rt,1); console.log('step OK');}catch(e:any){console.log('CRASH at create/step:',e.message);}
}
