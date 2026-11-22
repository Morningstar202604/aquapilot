/**
 * 曝气池氧传递与鼓风控制。
 *
 * 这一层把「DO 设定值」和「实际供氧」分开：
 *   - DO 是氧传递与微生物耗氧平衡的结果，不是控制器的直接赋值；
 *   - 控制器只改变 KLa 指令，KLa 再受鼓风机剩余能力、执行器速率限制；
 *   - 风机功率按实际传递到水中的氧量计算，不按需氧量倒推。
 *
 * 单位约定：
 *   KLa        h⁻¹
 *   S_O        g O₂/m³（与 ASM1 的负 COD 表示不同，这里只处理物理氧）
 *   OUR        g O₂/m³/h
 *   风量       m³/h
 *   功率       kW
 */

import { KINETICS } from './kinetics';

export const AERATION = {
  /** 设计最大氧传递系数（h⁻¹）。典型市政曝气池 5–15，留一定裕量。 */
  klaMax: 18,
  /** 控制器最小 KLa，避免除零；停曝气由 capacity=0 处理。 */
  klaMin: 0.2,
  /** DO PI 比例增益，(h⁻¹)/(mg/L)。 */
  kp: 6,
  /** DO PI 积分增益，(h⁻¹)/(mg/L)/h。 */
  ki: 1.2,
  /** 积分项限幅，防止风机长期饱和后积分发散。 */
  integralLimit: 12,
  /** KLa 指令速率限制，h⁻¹/h；模拟阀门/风机执行器不能瞬变。 */
  klaRateLimitPerHour: 30,
  /** 20 ℃ 清水饱和溶解氧，mg/L。 */
  doSat20: KINETICS.doSat20,
  /** 温度每升高 1 ℃，饱和溶解氧下降，mg/L/℃。 */
  doSatSlopePerC: 0.11,
  /** 标准供氧效率，kg O₂/kWh。 */
  saeKgO2PerKwh: KINETICS.saeKgO2PerKwh,
  /** 鼓风机与管路综合效率。 */
  blowerEfficiency: 0.7,
  /** 风机最小/最大功率，kW。 */
  minBlowerKw: 5,
  maxBlowerKw: 900,
  /** 空气密度，kg/m³（20 ℃，1 atm）。 */
  airDensityKgM3: 1.293,
  /** 空气中氧质量分数。 */
  airO2MassFraction: 0.232,
  /** 微孔曝气氧转移效率（到水中）。 */
  oxygenTransferEfficiency: 0.28,
} as const;

/** 当前水温下的饱和溶解氧（mg/L）。 */
export function saturationDo(temperatureC: number): number {
  return Math.max(4, AERATION.doSat20 - AERATION.doSatSlopePerC * (temperatureC - 20));
}

export interface AerationStepInput {
  /** 池容，m³。 */
  volume: number;
  /** 水温，℃。 */
  temperatureC: number;
  /** 当前 DO，mg/L。 */
  doLevel: number;
  /** 当前实际耗氧速率，g O₂/m³/h。 */
  o2Demand: number;
  /** DO 设定值，mg/L。 */
  doSetpoint: number;
  /** 鼓风机剩余能力，0–1。 */
  capacity: number;
  /** 上一步 KLa，h⁻¹。 */
  previousKla: number;
  /** 上一步积分项。 */
  previousIntegral: number;
  /** 步长，h。 */
  dtH: number;
}

export interface AerationStepResult {
  /** 新 DO，mg/L。 */
  doLevel: number;
  /** 实际执行的 KLa，h⁻¹。 */
  kla: number;
  /** 新的积分项。 */
  integral: number;
  /** 本池实际氧传递速率，kg O₂/h。 */
  o2TransferredKgH: number;
  /** 本池所需风量，m³/h。 */
  airflowM3h: number;
  /** 本池分摊的风机功率，kW。 */
  blowerKw: number;
}

/**
 * 一步曝气求解。
 *
 * 氧平衡用解析解而不是显式欧拉：
 *   dS_O/dt = KLa · (S_O,sat − S_O) − OUR
 * 在 KLa 很大或步长较大时，显式欧拉会振荡甚至发散；解析解无条件稳定。
 */
export function stepAeration(input: AerationStepInput): AerationStepResult {
  const { volume, temperatureC, doLevel, o2Demand, doSetpoint, capacity, previousKla, previousIntegral, dtH } = input;

  const dsat = saturationDo(temperatureC);
  const safeVolume = Math.max(1, volume);
  const safeDt = Math.max(1e-6, dtH);
  const available = Math.max(0, Math.min(1, capacity));
  const maxKla = AERATION.klaMax * available;

  if (available <= 0.02) {
    const doNext = Math.max(0.02, doLevel - Math.max(0, o2Demand) * safeDt);
    return {
      doLevel: Math.min(dsat, doNext),
      kla: 0,
      integral: 0,
      o2TransferredKgH: 0,
      airflowM3h: 0,
      blowerKw: 0,
    };
  }

  const error = doSetpoint - doLevel;
  const integralCandidate = clamp(previousIntegral + error * safeDt, -AERATION.integralLimit, AERATION.integralLimit);

  /**
   * 前馈 + PI。
   *
   * 前馈项按「当前需氧量 / 当前传质推动力」给出维持设定值所需 KLa，
   * 避免比例积分从零慢慢爬升造成启动期 DO 塌陷；PI 只负责补偿
   * 温度、饱和溶解氧、实际需氧量与模型之间的偏差。
   */
  const feedForward = Math.max(0, o2Demand) / Math.max(0.5, dsat - doSetpoint);
  const command = feedForward + AERATION.kp * error + AERATION.ki * integralCandidate;
  const boundedCommand = clamp(command, 0, maxKla);

  // 执行器速率限制：风机/阀门不能一步从 0 跳到最大。
  const maxDelta = AERATION.klaRateLimitPerHour * safeDt;
  const previous = clamp(previousKla, 0, AERATION.klaMax);
  const kla =
    previous <= AERATION.klaMin
      ? clamp(boundedCommand, 0, maxKla)
      : clamp(boundedCommand, Math.max(0, previous - maxDelta), Math.min(maxKla, previous + maxDelta));

  const equilibriumDo = dsat - Math.max(0, o2Demand) / Math.max(kla, 1e-6);
  const doNext =
    kla <= 0.01
      ? Math.max(0.02, doLevel - Math.max(0, o2Demand) * safeDt)
      : clamp(equilibriumDo + (doLevel - equilibriumDo) * Math.exp(-kla * safeDt), 0.02, dsat);

  const o2TransferredKgH = (kla * Math.max(0, dsat - doLevel) * safeVolume) / 1000;
  const airflowM3h =
    o2TransferredKgH / (AERATION.airDensityKgM3 * AERATION.airO2MassFraction * AERATION.oxygenTransferEfficiency);
  const blowerKw = clamp(
    o2TransferredKgH / AERATION.saeKgO2PerKwh / AERATION.blowerEfficiency,
    AERATION.minBlowerKw,
    AERATION.maxBlowerKw,
  );

  return {
    doLevel: doNext,
    kla,
    integral: integralCandidate,
    o2TransferredKgH,
    airflowM3h,
    blowerKw: Number.isFinite(blowerKw) ? blowerKw : 0,
  };
}

/** 把多池风量/功率合并为全厂鼓风机负荷。 */
export function totalBlowerPower(o2TransferredKgH: number, capacity: number): number {
  if (capacity <= 0.02) return 0;
  return clamp(
    o2TransferredKgH / AERATION.saeKgO2PerKwh / AERATION.blowerEfficiency,
    AERATION.minBlowerKw,
    AERATION.maxBlowerKw,
  );
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
