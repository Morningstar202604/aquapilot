import { BSM1_INFLUENT, runCstr, toConventional } from '../src/sim/asm1Cstr';

console.log('=== ASM1 单池 CSTR 稳态验证 ===\n');
console.log('进水（BSM1 Table 5 平均）：');
console.log(`  S_S ${BSM1_INFLUENT.S_S}  S_NH ${BSM1_INFLUENT.S_NH}  X_S ${BSM1_INFLUENT.X_S}  X_B_H ${BSM1_INFLUENT.X_B_H}`);

// 好氧池：HRT 6h，DO 2
const aerobic = runCstr(BSM1_INFLUENT, { volume: 4000, flow: 18446 / 24, aerated: true, doSetpoint: 2 }, { maxHours: 24 * 90 });
const convA = toConventional(aerobic.state);
console.log(`\n好氧单池（HRT ${(4000 / (18446 / 24)).toFixed(1)}h, DO 2）：`);
console.log(`  收敛: ${aerobic.converged}  用时 ${aerobic.steadyHours.toFixed(0)}h`);
console.log(`  出水 S_S ${aerobic.state.S_S.toFixed(2)}  S_NH ${aerobic.state.S_NH.toFixed(2)}  S_NO ${aerobic.state.S_NO.toFixed(2)}  X_B_H ${aerobic.state.X_B_H.toFixed(0)}  X_B_A ${aerobic.state.X_B_A.toFixed(0)}`);
console.log(`  折算：COD ${convA.cod.toFixed(0)}  SS ${convA.ss.toFixed(0)}  NH4 ${convA.nh.toFixed(2)}  TN ${convA.tn.toFixed(1)}`);
console.log(`  碱度 ${aerobic.state.S_ALK.toFixed(2)} mol/m³  DO ${aerobic.state.S_O.toFixed(2)}`);

// 缺氧池：HRT 4h，无曝气（看反硝化）
const anoxicIn = { ...BSM1_INFLUENT, S_NO: 10, S_O: 0.2 };
const anoxic = runCstr(anoxicIn, { volume: 2600, flow: 18446 / 24, aerated: false }, { maxHours: 24 * 60 });
console.log(`\n缺氧单池（HRT ${(2600 / (18446 / 24)).toFixed(1)}h, 无曝气, 进水 NO3 10）：`);
console.log(`  收敛: ${anoxic.converged}  用时 ${anoxic.steadyHours.toFixed(0)}h`);
console.log(`  出水 S_NO ${anoxic.state.S_NO.toFixed(2)}  S_S ${anoxic.state.S_S.toFixed(2)}  DO ${anoxic.state.S_O.toFixed(3)}`);
console.log(`  反硝化去除率: ${(((10 - anoxic.state.S_NO) / 10) * 100).toFixed(1)}%`);
