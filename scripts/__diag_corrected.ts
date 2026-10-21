import { ASM1_COMPONENTS, ASM1_PARAMS as p, ASM1_PROCESSES, buildRates, buildStoichiometry, emptyAsm1State, type Asm1State } from '../src/sim/asm1';
import { BSM1_INFLUENT } from '../src/sim/asm1Cstr';

const Q = 18446 / 24;
const V = Q * 240;

function run(corrected: boolean, days = 200) {
  const stoich: any = buildStoichiometry();
  if (corrected) {
    stoich.aerobic_growth_autotrophs = {
      X_B_A: 1,
      S_NH: -(p.i_XB + 1 / p.Y_A),
      S_NO: 1 / p.Y_A,
      S_O: -(p.O57 ?? 4.57 - p.Y_A) / p.Y_A,
      S_ALK: -(p.i_XB / 14 + 1 / (7 * p.Y_A)),
    };
  }
  const rates = buildRates();
  let s: Asm1State = { ...BSM1_INFLUENT, X_B_A: 150 };
  const dt = 1 / 60;
  const steps = days * 24 * 60;
  for (let i = 0; i < steps; i++) {
    const r = emptyAsm1State();
    for (const proc of ASM1_PROCESSES) {
      const rho = rates[proc](s) * p.PER_DAY_TO_PER_HOUR;
      if (!Number.isFinite(rho) || rho <= 0) continue;
      for (const [c, coef] of Object.entries(stoich[proc])) r[c as keyof Asm1State] += (coef as number) * rho;
    }
    const next = emptyAsm1State();
    for (const c of ASM1_COMPONENTS) next[c] = Math.max(0, s[c] + dt * ((Q / V) * (BSM1_INFLUENT[c] - s[c]) + r[c]));
    next.S_O = 2.0;
    s = next;
  }
  return s;
}

for (const corrected of [false, true]) {
  const s = run(corrected, 200);
  console.log(corrected ? 'CORRECTED' : 'CURRENT  ', {
    XBH: s.X_B_H.toFixed(0), XBA: s.X_B_A.toFixed(0), SNH: s.S_NH.toFixed(2), SNO: s.S_NO.toFixed(2),
    SALK: s.S_ALK.toFixed(2), SO: s.S_O.toFixed(2), SS: s.S_S.toFixed(2), XS: s.X_S.toFixed(0),
  });
}
