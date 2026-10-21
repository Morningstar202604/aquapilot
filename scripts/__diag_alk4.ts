import { ASM1_PARAMS as p, ASM1_PROCESSES, buildRates, buildStoichiometry, emptyAsm1State, reactionRates, type Asm1State } from '../src/sim/asm1';
import { BSM1_INFLUENT } from '../src/sim/asm1Cstr';
const Q = 18446/24, V = Q*240;
let s: Asm1State = { ...BSM1_INFLUENT, X_B_A: 150 };
const dt = 1/60;
for (let d=0; d<3; d++) {
  const r = reactionRates(s);
  console.log(`day ${d}: SALK ${s.S_ALK.toFixed(2)} r.SALK ${r.S_ALK.toFixed(4)} mol/m3/h (${(r.S_ALK*24).toFixed(2)} /d) SND ${s.S_ND.toFixed(2)} XBH ${s.X_B_H.toFixed(0)} XBA ${s.X_B_A.toFixed(0)} SNH ${s.S_NH.toFixed(1)} SNO ${s.S_NO.toFixed(1)}`);
  for (let i=0;i<1440;i++) {
    const rr = reactionRates(s);
    const next = emptyAsm1State();
    for (const c of Object.keys(s) as (keyof Asm1State)[]) next[c] = Math.max(0, s[c] + dt*((Q/V)*(BSM1_INFLUENT[c]-s[c]) + rr[c]));
    next.S_O = 2.0; s = next;
  }
}
