import { ASM1_PARAMS, emptyAsm1State, type Asm1State } from './asm1';

/**
 * 6 状态聚合量与 ASM1 13 组分之间的映射。
 *
 * 为什么需要这一层：界面、AI、告警都按聚合量（COD / NH / NO3 / TP / SS）工作，
 * 而 ASM1 内部是 13 个组分。映射保证"换模型不改界面"，同时也暴露了
 * 简化模型的固有局限——ASM1 没有磷，TP 只能靠化学除磷兜底。
 */

/** ASM1 生物量 COD 与 VSS 的换算系数（1.42 gCOD/gVSS） */
const COD_PER_VSS = 1.42;

/** 聚合量 → ASM1（用于从现有状态初始化 ASM1 反应器） */
/**
 * 聚合量 → ASM1。
 *
 * 关键约束：**总 COD 必须闭合**。ASM1 的总 COD = S_I + S_S + X_I + X_S + X_B_H + X_B_A + X_P。
 * 生物量本身就是 COD 的一部分，不能在其之外再加一遍 COD，否则回算会放大数倍。
 *
 * 因此拆分顺序是：先按比例分配溶解态与惰性颗粒态，剩余部分才是生物量 + 慢速基质。
 */
export function toAsm1(input: {
  cod: number;
  nh: number;
  no3: number;
  tp: number;
  doLevel: number;
  alkalinity: number;
  mlss: number;
}): Asm1State {
  const totalCod = Math.max(1, input.cod);

  // 溶解性惰性 8%、易降解 18%、颗粒惰性 20% —— 合计 46%，与典型市政污水接近
  const inertSoluble = totalCod * 0.08;
  const solubleReadily = totalCod * 0.18;
  const inertParticulate = totalCod * 0.2;

  // 剩余 54% 在「慢速可降解基质」与「生物量」之间分配。
  // 有 MLSS 时按 MLSS 估生物量（VSS≈0.75×SS，COD≈1.42×VSS），但不得超过剩余量。
  const remaining = totalCod * 0.54;
  const biomassFromMlss = input.mlss > 0 ? input.mlss * 0.75 * COD_PER_VSS : 0;

  // 有 MLSS 时**以生物量为准**：池内污泥量是物理存量，不由进水 COD 决定。
  // 此时总 COD 会高于传入的 COD，这是正确的——池内混合液的 COD 本来就包含生物量。
  //
  // 无 MLSS 表示这是「进水」：进水中不应凭空含有活性污泥。
  // 因此 54% 的剩余 COD 全部归为慢速可降解基质，生物量为 0。
  // （早期版本在此兜底给了 70% 生物量，导致进水含 106 mg/L 的 X_B_H，
  //   进而使「进水」自带硝化菌，掩盖了真实的水力流失过程。）
  const biomass = biomassFromMlss > 0 ? biomassFromMlss : 0;
  const slowlyBiodegradable = Math.max(0, remaining - Math.min(remaining, biomass));

  return emptyAsm1State({
    S_I: inertSoluble,
    S_S: solubleReadily,
    X_I: inertParticulate,
    X_S: slowlyBiodegradable,
    // 生物量按 80/20 分配给异养/自养，与典型市政污泥比例一致
    X_B_H: biomass * 0.8,
    X_B_A: biomass * 0.2,
    X_P: 0,
    S_O: input.doLevel,
    S_NO: input.no3,
    S_NH: input.nh,
    S_ND: input.nh * 0.1,
    X_ND: input.nh * 0.15,
    // 碱度单位：mg/L as CaCO3 → mol HCO3/m³（1 mol ≈ 50 g as CaCO3）
    S_ALK: input.alkalinity / 50,
  });
}

/** ASM1 → 聚合量（用于界面展示与告警判断） */
export function fromAsm1(s: Asm1State): {
  cod: number;
  nh: number;
  no3: number;
  tp: number;
  ss: number;
  doLevel: number;
  alkalinity: number;
} {
  const particulate = s.X_I + s.X_S + s.X_B_H + s.X_B_A + s.X_P;
  return {
    // 总 COD 含溶解性与颗粒性
    cod: s.S_I + s.S_S + particulate,
    nh: s.S_NH,
    no3: s.S_NO,
    // ASM1 无磷组分：污水中的磷由化学除磷单独处理，这里返回 0 并显式标注
    tp: 0,
    ss: particulate / COD_PER_VSS,
    doLevel: s.S_O,
    alkalinity: s.S_ALK * 50,
  };
}

/** 进水的聚合量 → ASM1（场景注入时用） */
export function influentToAsm1(influent: {
  cod: number;
  nh: number;
  tp: number;
  ss: number;
  alkalinity: number;
  temperature: number;
}): Asm1State {
  return toAsm1({
    cod: influent.cod,
    nh: influent.nh,
    no3: 0,
    tp: influent.tp,
    doLevel: 0,
    alkalinity: influent.alkalinity,
    mlss: 0,
  });
}

/**
 * ASM1 的已知建模边界（显式记录，避免被误当成缺陷）。
 */
export const ASM1_LIMITATIONS = {
  phosphorus: 'ASM1 不含磷组分；出水 TP 必须由化学除磷（PAC）单独建模',
  temperature: '当前使用 20 ℃ 参数集，未做 Arrhenius 温度修正',
  inhibition: '毒性抑制通过缩放 mu_H / mu_A 实现，未建模具体的抑制机理',
} as const;

export { ASM1_PARAMS };
