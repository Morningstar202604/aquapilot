import { PLANT, LIMITS } from '../src/sim/config';
import { PLANT_TOPOLOGY, totalTrainVolume } from '../src/model/topology';
import { createNetworkState, spinUpNetwork } from '../src/sim/networkEngine';
import { BSM1_TABLE6_EFFLUENT } from '../src/sim/bsm1';

/**
 * 差距探查：把当前厂（拓扑引擎）与 BSM1 基准摆在同一张表上。
 *
 * 旧版本跑固定五池参考引擎，且用的是过期的手工数值；现在读生产引擎 +
 * BSM1 官方 Table 6 常量，避免文档里的数字再次与代码脱节。
 */

const BSM1 = {
  tanks: [1000, 1000, 1333, 1333, 1333],
  settlerArea: 1500,
  settlerDepth: 4.0,
  flow: 18446 / 24,
  qInt: 55338 / 24,
  qR: 18446 / 24,
  qW: 385 / 24,
};

const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 2026 }), PLANT_TOPOLOGY, 40);
const volume = totalTrainVolume(PLANT_TOPOLOGY);
const clarifierUnit = PLANT_TOPOLOGY.units.find((u) => u.kind === 'clarifier')!;
const clarifier = { area: clarifierUnit.area ?? PLANT.clarifier.area, depth: clarifierUnit.depth ?? PLANT.clarifier.depth };

console.log('=== 当前厂（生产引擎，40 d 培养）===');
console.log(`Q ${s.influent.flow.toFixed(0)} m³/h  MLSS ${((s.biomassKg * 1000) / s.volume.bio).toFixed(0)}  SRT ${s.srtDays.toFixed(1)} d`);
console.log(
  `出水 COD ${s.effluent.cod.toFixed(1)}  NH4 ${s.effluent.nh.toFixed(2)}  TN ${s.effluent.tn.toFixed(2)}  SS ${s.effluent.ss.toFixed(1)}  TP ${s.effluent.tp.toFixed(3)}`,
);
console.log(`总池容 ${volume} m³  二沉池 ${clarifier.area} m² × ${clarifier.depth} m`);

console.log('\n=== BSM1 基准（官方 Table 6）===');
console.log(
  `S_S ${BSM1_TABLE6_EFFLUENT.S_S}  S_NH ${BSM1_TABLE6_EFFLUENT.S_NH}  S_NO ${BSM1_TABLE6_EFFLUENT.S_NO}  S_ALK ${BSM1_TABLE6_EFFLUENT.S_ALK}  S_O ${BSM1_TABLE6_EFFLUENT.S_O}`,
);
console.log(`总池容 ${BSM1.tanks.reduce((a, b) => a + b, 0)} m³  二沉池 ${BSM1.settlerArea} m² × ${BSM1.settlerDepth} m`);

const currentSLR = PLANT.designFlowM3h / clarifier.area;
const bsm1SLR = BSM1.flow / BSM1.settlerArea;
console.log(`\n水力表面负荷：当前 ${currentSLR.toFixed(2)} m³/m²·h vs BSM1 ${bsm1SLR.toFixed(2)} → 比值 ${(currentSLR / bsm1SLR).toFixed(2)}`);

const currentHRT = volume / PLANT.designFlowM3h;
const bsm1HRT = BSM1.tanks.reduce((a, b) => a + b, 0) / BSM1.flow;
console.log(`HRT：当前 ${currentHRT.toFixed(2)} h vs BSM1 ${bsm1HRT.toFixed(2)} h → 比值 ${(currentHRT / bsm1HRT).toFixed(2)}`);

console.log('\n=== 关键差异（模型口径，不是实现缺陷）===');
console.log(`1. 出水限值：一级A COD ${LIMITS.cod} / NH4 ${LIMITS.nh} / TN ${LIMITS.tn} / TP ${LIMITS.tp} / SS ${LIMITS.ss}`);
console.log('2. 生产引擎是「简化动力学 + Takács 二沉池」：单生物量状态，无法区分异养/自养');
console.log('3. BSM1 Table 6 对照跑在 ASM1 独立模块上（tests/bsm1-benchmark.test.ts），不跑生产引擎');
console.log('4. ASM1 无磷：TP 由化学除磷兜底；两套口径不能直接比 TP');
console.log('5. 碱度单位：ASM1 用 mol HCO3/m³，生产引擎用 mg/L as CaCO3（换算系数 50）');
