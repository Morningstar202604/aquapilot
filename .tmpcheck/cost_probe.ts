import { PLANT_TOPOLOGY } from '../src/model/topology';
import { createRuntime } from '../src/server/topologyRuntime';
import { networkModel } from '../src/sim/networkEngine';
import { answer } from '../src/ai/agent';
const rt = createRuntime(PLANT_TOPOLOGY);
const model = networkModel(PLANT_TOPOLOGY, rt.net);
let t=performance.now(); for(let i=0;i<20;i++) model.predict(rt.net.controls,240,30); console.log('predict avg ms:', ((performance.now()-t)/20).toFixed(1));
t=performance.now(); for(let i=0;i<10;i++) answer('现在运行怎么样', model, null); console.log('answer avg ms:', ((performance.now()-t)/10).toFixed(1));
const snapJson = JSON.stringify(rt.net).length; console.log('net state json bytes:', snapJson);
