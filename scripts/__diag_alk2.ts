import { ASM1_COMPONENTS, ASM1_PARAMS as p, ASM1_PROCESSES, buildRates, buildStoichiometry, emptyAsm1State, type Asm1State } from '../src/sim/asm1';
import { BSM1_INFLUENT } from '../src/sim/asm1Cstr';

const Q = 18446 / 24, V = Q * 240;
const stoich = buildStoichiometry(); const rates = buildRates();
let s: Asm1State = { ...BSM1_INFLUENT, X_B_A: 150 };
const dt = 1/60;
for (let i = 0; i <= 200*24*60; i++) {
  if (i % (10*24*60) === 0) console.log(`day ${i/1440}: SALK ${s.S_ALK.toFixed(2)} SND ${s.S_ND.toFixed(2)} XND ${s.X_ND.toFixed(2)} SNH ${s.S_NH.toFixed(2)} SNO ${s.S_NO.toFixed(2)} XBH ${s.X_B_H.toFixed(0)} XBA ${s.X_B_A.toFixed(0)}`);
  const r = emptyAsm1State();
  for (const proc of ASM1_PROCESSES) {
    const rho = rates[proc](s) * p.PER_DAY_TO_PER_HOUR;
    if (!Number.isFinite(rho) || rho <= 0) continue;
    for (const [c, coef] of Object.entries(stoich[proc])) r[c as keyof Asm1State] += (coef as number) * rho;
  }
  const next = emptyAsm1State();
  for (const c of ASM1_COMPONENTS) next[c] = Math.max(0, s[c] + dt*((Q/V)*(BSM1_INFLUENT[c]-s[c]) + r[c]));
  next.S_O = 2.0; s = next;
}
