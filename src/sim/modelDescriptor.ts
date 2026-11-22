/**
 * 模型描述符的类型。
 *
 * 单独成文件是为了打断 modelRegistry ↔ asm2d 的类型循环：
 * asm2d 需要一个 ModelDescriptor 类型，modelRegistry 需要 asm2dDescriptor 值。
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
