import { ASM1_COMPONENTS, ASM1_PARAMS, ASM1_PROCESSES, buildStoichiometry } from './asm1';
import { asm2dDescriptor as asm2dDescriptorImpl } from './asm2d';
import { ADM1_COMPONENTS, ADM1_PARAMS, ADM1_PROCESSES, emptyState as emptyAdm1State } from './adm1';

/**
 * 模型注册表：用**数据**描述一个生物动力学模型。
 *
 * 为什么需要（对标 QSDsan 的 `data/process_data/_asm1.tsv`）：
 * 我们此前把 ASM1 的组分、过程、化学计量全部写死在 `asm1.ts` 里。
 * 加 ASM2d 就要再写一个几百行的文件、再抄一遍守恒校验、再写一遍求解循环。
 * QSDsan 的做法是把模型定义成数据，代码只做解释器——加模型 = 加一个数据文件。
 *
 * 这里落一个轻量版：**结构数据化，系数仍是函数**。
 * 完全数据化（系数也进 TSV）需要表达式求值器，收益不抵复杂度；
 * 但把「组分清单 / 过程清单 / 化学计量生成器 / 速率生成器 / 守恒校验维度」
 * 收进一个描述符，已经足以让 ASM2d 与 ADM1 共用同一套求解与校验骨架。
 *
 * 守恒校验是这里的关键：新模型接入时必须能被自动检查「每个过程的 COD/N
 * 是否闭合」，否则系数抄错会静默给出错误结果（ASM1 历史上就踩过硝化通量
 * 被低估 16.8 倍、靠 BSM1 对照才发现）。
 */

export interface ModelDescriptor<Comp extends string, Proc extends string> {
  /** 模型标识 */
  id: string;
  /** 展示名 */
  name: string;
  /** 组分清单（顺序即状态向量顺序） */
  components: readonly Comp[];
  /** 过程清单 */
  processes: readonly Proc[];
  /** 化学计量矩阵：每个过程 → 各组分系数 */
  stoichiometry: Record<Proc, Partial<Record<Comp, number>>>;
  /**
   * 守恒校验的维度定义。
   *
   * `cod` 与 `n` 是把组分折算成「COD 当量」与「氮当量」的函数。
   * 每个过程的行向量在这两个度量下的内积必须为 0（闭合），
   * 否则说明系数抄错或漏了某个产物。
   */
  conservation: {
    cod?: Partial<Record<Comp, number>>;
    n?: Partial<Record<Comp, number>>;
    tolerance?: number;
    exempt?: Partial<Record<Proc, string>>;
  };
}

export interface ConservationRow<Proc extends string> {
  process: Proc;
  codResidual: number | null;
  nResidual: number | null;
  ok: boolean;
  note?: string;
}

/** 逐过程守恒校验，返回每个过程的残差而不是一个布尔值 */
export function checkModelConservation<Comp extends string, Proc extends string>(
  descriptor: ModelDescriptor<Comp, Proc>,
): ConservationRow<Proc>[] {
  const tol = descriptor.conservation.tolerance ?? 1e-6;
  return descriptor.processes.map((process) => {
    const row = descriptor.stoichiometry[process] ?? {};
    const weigh = (coeffs: Partial<Record<Comp, number>> | undefined): number | null => {
      if (!coeffs) return null;
      let sum = 0;
      for (const [comp, coeff] of Object.entries(row)) {
        const weight = coeffs[comp as Comp];
        if (weight !== undefined) sum += (coeff as number) * weight;
      }
      return sum;
    };
    const codResidual = weigh(descriptor.conservation.cod);
    const nResidual = weigh(descriptor.conservation.n);
    const exempt = descriptor.conservation.exempt?.[process];
    const ok =
      exempt !== undefined ||
      ((codResidual === null || Math.abs(codResidual) <= tol) && (nResidual === null || Math.abs(nResidual) <= tol));
    return {
      process,
      codResidual,
      nResidual,
      ok,
      note: exempt ?? (ok ? undefined : `COD 残差 ${codResidual ?? 0}，N 残差 ${nResidual ?? 0}`),
    };
  });
}

/** ASM1 描述符：直接复用现有 buildStoichiometry，确保没有第二份 ASM1 */
export function asm1Descriptor(): ModelDescriptor<(typeof ASM1_COMPONENTS)[number], (typeof ASM1_PROCESSES)[number]> {
  const stoich = buildStoichiometry(ASM1_PARAMS);
  const p = ASM1_PARAMS;
  return {
    id: 'asm1',
    name: 'ASM1（IWA 活性污泥模型 1 号）',
    components: ASM1_COMPONENTS,
    processes: ASM1_PROCESSES,
    stoichiometry: stoich,
    conservation: {
      cod: {
        S_I: 1,
        S_S: 1,
        X_I: 1,
        X_S: 1,
        X_B_H: 1,
        X_B_A: 1,
        X_P: 1,
        S_O: -1,
        S_NO: -p.COD_PER_NO3_N,
      },
      /**
       * 氮账：只统计**留在系统内**的氮。
       *
       * 反硝化把 NO3-N 还原成 N2 逸出气相，氮离开系统，
       * 因此 S_NO 不能无条件计入——否则缺氧行会亏 0.172 gN/gCOD
       * （实测值），被误判成系数错误。
       * 处理方式和 asm1.conservationResiduals 一致：把该过程列入豁免，
       * 由专用判据（只校验氨氮↔生物量转移）负责。
       */
      n: {
        S_NH: 1,
        S_ND: 1,
        X_ND: 1,
        X_B_H: p.i_XB,
        X_B_A: p.i_XB,
        X_P: p.i_XP,
      },
      exempt: {
        aerobic_growth_autotrophs:
          '自养硝化：生物量 COD 来自无机碳（CO₂），COD 账不适用；氮按 asm1.conservationResiduals 专用判据校验',
        anoxic_growth_heterotrophs:
          '缺氧反硝化：NO3-N 还原为 N2 逸出系统，氮不由系统内组分闭合，按 asm1.conservationResiduals 专用判据校验',
      },
    },
  };
}

/** ASM2d 描述符：实现留在 asm2d.ts，注册表只做聚合，避免两份定义漂移 */
export const asm2dDescriptor = asm2dDescriptorImpl;

/** ADM1 描述符：ADM1 是显式速率方程，矩阵在下一阶段完全数据化 */
export function adm1Descriptor() {
  return {
    id: 'adm1',
    name: 'ADM1（厌氧消化模型 1 号）',
    components: ADM1_COMPONENTS,
    processes: ADM1_PROCESSES,
    stoichiometry: {},
    conservation: {
      tolerance: 1e-6,
      exempt: Object.fromEntries(
        ADM1_PROCESSES.map((process) => [process, 'ADM1 显式反应方程；逐元素电荷守恒需完整离子组分表']),
      ) as Record<string, string>,
    },
    defaults: ADM1_PARAMS,
    emptyState: emptyAdm1State,
  } as const;
}

export const MODEL_DESCRIPTORS = {
  asm1: asm1Descriptor,
  asm2d: asm2dDescriptor,
  adm1: adm1Descriptor,
} as const;

export type RegisteredModelId = keyof typeof MODEL_DESCRIPTORS;

export function getModelDescriptor(id: RegisteredModelId) {
  return MODEL_DESCRIPTORS[id]();
}

export function listModelDescriptors() {
  return (Object.keys(MODEL_DESCRIPTORS) as RegisteredModelId[]).map((id) => getModelDescriptor(id));
}
