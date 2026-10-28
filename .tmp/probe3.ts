import { sanitizeTopologyInput } from '../src/model/topologyInput';
import { PLANT_TOPOLOGY, validateTopology } from '../src/model/topology';
import { compileNetwork } from '../src/sim/network';
import { checkRunReadiness } from '../src/sim/topologyEngine';
import { assertSafeBaseUrl } from '../src/ai/providers';
import { maskApiKey } from '../src/shared/llm';
import { normalizeAgentConfig, permissionAllows } from '../src/shared/agentConfig';

const clone=()=>JSON.parse(JSON.stringify(PLANT_TOPOLOGY));
// huge volume
let t:any=clone(); t.units.find((u:any)=>u.id==='anaerobic').volume=1e308; t.units.find((u:any)=>u.id==='anoxic').volume=1e308;
let sv=sanitizeTopologyInput(t);
console.log('huge volume sanitize', sv.ok);
if(sv.ok){console.log('bio', compileNetwork(sv.topology).bioVolume, 'ready', checkRunReadiness(sv.topology).derived);}
// duplicate train at end
t=clone(); t.train.push('aerobic3');
sv=sanitizeTopologyInput(t); console.log('dup end sanitize',sv.ok);
if(sv.ok){const c=compileNetwork(sv.topology); console.log('dup end reactors',c.reactors.map((r:any)=>r.id),'bio',c.bioVolume,'problems',c.problems);}
// huge train
t=clone(); t.train=Array(100000).fill('aerobic1'); sv=sanitizeTopologyInput(t); console.log('huge train sanitize',sv.ok,'len',sv.ok?(sv.topology.train.length):0);
// ssrf
for(const u of ['http://metadata.google.internal./computeMetadata','http://[::ffff:169.254.169.254]/','http://[::ffff:a9fe:a9fe]/','http://169.254.169.254.nip.io/','http://127.0.0.1.nip.io/','http://0x7f000001/','http://2130706433/']){
  try{const url=assertSafeBaseUrl(u); console.log('SSRF ACCEPT',u,'=>',url.href);}catch(e:any){console.log('blocked',u,e.message);}
}
console.log('mask9',maskApiKey('123456789'));
const cfg:any=normalizeAgentConfig({constraints:{allowedControls:[]}}).config;
console.log('empty allowed =>',cfg.constraints.allowedControls.length, cfg.constraints.allowedControls.slice(0,3));
console.log('grant-open standard', permissionAllows('standard','grant-open'));
