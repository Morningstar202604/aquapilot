import { BSM1_SETTLER, runSettlerToSteady } from '../src/sim/takacs';
const cfg = { ...BSM1_SETTLER, area: 2400, depth: 4.5 };
for (const [Qf, Xf] of [[5098, 2109], [5098, 11500], [2832, 11500], [2832, 2109]] as const) {
  const r = runSettlerToSteady(cfg, { flow: Qf, concentration: Xf }, { flow: Qf * 0.8 }, { maxDays: 60, dtDays: 1/1440 });
  console.log(`Qf ${Qf} Xf ${Xf}: xEff ${r.xEffluent.toFixed(1)} xRas ${r.xUnderflow.toFixed(0)} SLR ${r.solidsLoading.toFixed(1)}`);
}
