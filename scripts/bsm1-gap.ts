import { createInitialState, spinUp } from '../src/sim/engine';
import { PLANT } from '../src/sim/config';

/**
 * 探查：把当前引擎按 BSM1 的几何与进水运行，看稳态出水离 BSM1 Table 6 有多远。
 * 这是路线图 §7 的最小切片预演，用来判断"骨架要不要重构"。
 */

// BSM1 权威配置（已核实）
const BSM1 = {
  tanks: [1000, 1000, 1333, 1333, 1333],
  settlerArea: 1500,
  settlerDepth: 4.0,
  settlerLayers: 10,
  flow: 18446 / 24, // m³/h
  qInt: 55338 / 24,
  qR: 18446 / 24,
  qW: 385 / 24,
  influent: {
    // 用 ASM1 组分折算成当前引擎的聚合指标
    cod: 30 + 69.5 + 51.2 + 202.32 + 28.17, // SI+SS+XI+XS+XBH
    nh: 31.56,
    tn: 31.56 + 6.95 + 10.59 + 0, // SNH+SND+XND+SNO
    ss: (202.32 + 51.2 + 28.17) / (4 / 3),
    tp: 0, // ASM1 不含磷
    temperature: 15,
    alkalinity: 7 * 50, // mol/m³ -> mg/L as CaCO3 近似
  },
};


const s = spinUp(createInitialState({ seed: 2026 }), 40);
console.log('=== 当前引擎：设计工况（现值） ===');
console.log(`Q ${s.influent.flow.toFixed(0)} m³/h  MLSS ${s.tanks[0].mlss}  SRT ${s.srtDays.toFixed(1)}d`);
console.log(
  `出水 COD ${s.effluent.cod.toFixed(1)}  NH4 ${s.effluent.nh.toFixed(2)}  NO3(推算) ${(s.effluent.tn - s.effluent.nh).toFixed(2)}  SS ${s.effluent.ss.toFixed(1)}  TP ${s.effluent.tp.toFixed(3)}`,
);

console.log('\n=== BSM1 几何映射后的同一引擎 ===');
console.log(`BSM1 进水折算：COD ${BSM1.influent.cod.toFixed(0)}  NH4 ${BSM1.influent.nh.toFixed(1)}  TN ${BSM1.influent.tn.toFixed(1)}  SS ${BSM1.influent.ss.toFixed(0)}  T ${BSM1.influent.temperature}℃`);
console.log(`BSM1 流量 ${BSM1.flow.toFixed(1)} m³/h  内回流 ${(BSM1.qInt / BSM1.flow).toFixed(2)}×Q  污泥回流 ${(BSM1.qR / BSM1.flow).toFixed(2)}×Q`);
console.log(`当前厂区总池容 ${PLANT.tanks.reduce((a, t) => a + t.volume, 0)} m³ vs BSM1 ${BSM1.tanks.reduce((a, b) => a + b, 0)} m³`);
console.log(`当前二沉池 ${PLANT.clarifier.area} m² × ${PLANT.clarifier.depth} m vs BSM1 ${BSM1.settlerArea} m² × ${BSM1.settlerDepth} m`);

// 用相同的水力负荷（m³/m²·h）做等效比较
const currentSLR = PLANT.designFlowM3h / PLANT.clarifier.area;
const bsm1SLR = BSM1.flow / BSM1.settlerArea;
console.log(`\n水力表面负荷：当前 ${currentSLR.toFixed(2)} m³/m²·h  vs BSM1 ${bsm1SLR.toFixed(2)} m³/m²·h  → 比值 ${(currentSLR / bsm1SLR).toFixed(2)}`);

// 关键判断：现有引擎的池容/HRT 与 BSM1 的差距
const currentHRT = (PLANT.tanks.reduce((a, t) => a + t.volume, 0)) / PLANT.designFlowM3h;
const bsm1HRT = BSM1.tanks.reduce((a, b) => a + b, 0) / BSM1.flow;
console.log(`HRT：当前 ${currentHRT.toFixed(2)} h  vs BSM1 ${bsm1HRT.toFixed(2)} h  → 比值 ${(currentHRT / bsm1HRT).toFixed(2)}`);

// 现有引擎在降低负荷（BSM1 平均流量仅为设计的 38%）下的表现
console.log('\n=== 关键差异检查 ===');
console.log('1. ASM1 无磷：BSM1 对照无法覆盖 TP，需保留化学除磷兜底（路线图 §6.2 已验证）');
console.log('2. 组分不可直接映射：BSM1 的 X_S(202) 与 X_I(51) 在当前引擎里都只是"SS"，无法区分可降解/惰性，导致 SRT 与产泥率无法对照');
console.log('3. 硝化菌与异养菌未分离：ASM1 有 X_B_H 与 X_B_A 两个独立生物量状态，当前引擎只有一个 biomassKg，无法表现"毒性只杀硝化菌"这类真实机理');
console.log('4. 碱度单位不一致：ASM1 用 mol HCO3/m³ (7.0)，当前引擎用 mg/L as CaCO3');
console.log('5. 温度基准不同：ASM1 参数为 20℃，BSM1 报告用 15℃ 参数集，需明确选哪一套并全程一致');
