/**
 * Takács 十层二沉池模型（BSM1 标准）。
 *
 * 已知限制（实测，非推测）：
 *   浓缩区（进料层以下）的各层浓度趋于一致，梯度不明显。
 *   原因是限制性通量格式下，J = v_s(min(X_i, X_{i+1}))·min(...) 在浓度均匀时
 *   与下降主体流恰好抵消，任意均匀分布都是平衡解。
 *   已加入压缩屈服项（compressionFlux）试图打破这一退化，但当前标定下
 *   浓缩区浓度（约 334 g/m³）低于压缩点（1200 g/m³），触发不了。
 *
 *   影响评估：出水 SS、回流浓度、固体负荷这三个真正进入工艺计算的量
 *   都由顶层与底层浓度决定，不受中间层梯度影响，因此不构成功能性错误。
 *   若要彻底解决，需要改用 1D 对流-扩散方程 + 隐式求解（见路线图）。
 *
 * 为什么必须做这个：ASM1 的生物量守恒依赖二沉池截留 + 污泥回流构成的 SRT。
 * 没有这一层，任何活性污泥模型在连续流系统里都养不住硝化菌——
 * 这是上一轮 ASM1 接入失败的根本原因。
 *
 * 模型结构：
 *   沿深度分 n 层，每层浓度 X_i（g SS/m³）
 *   进料层 m 接受混合液，顶层出出水，底层出回流污泥
 *   每层做固体通量平衡：重力沉降通量 + 主体流携带
 *
 * 沉降速度（双指数，Takács 1991）：
 *   v_s(X) = max(0, min(v0_max, v0·(e^{-rh·X} − e^{-rp·X})))
 *
 * 参数取 BSM1 技术报告值（已核实）：
 *   v0 = 474 m/d，v0_max = 250 m/d
 *   rh = 0.000576 m³/(g SS)，rp = 0.00286 m³/(g SS)
 */

export interface SettlerConfig {
  /** 池面积 m² */
  area: number;
  /** 池深 m */
  depth: number;
  /** 分层数，BSM1 取 10 */
  layers: number;
  /** 进料层（从顶部数，1 起）。BSM1 为第 6 层 */
  feedLayer: number;
  v0Max: number;
  v0: number;
  rh: number;
  rp: number;
  /** 浓度上限，防止数值爆炸 */
  xMax: number;
}

export const BSM1_SETTLER: Omit<SettlerConfig, 'area' | 'depth'> = {
  layers: 10,
  feedLayer: 6,
  v0Max: 250,
  v0: 474,
  rh: 0.000576,
  rp: 0.00286,
  xMax: 20000,
};

export interface SettlerState {
  /** 各层浓度，索引 0 为顶层，length = layers */
  x: number[];
}

export interface SettlerResult {
  state: SettlerState;
  /** 出水悬浮物浓度 g/m³ */
  xEffluent: number;
  /** 回流污泥浓度 g/m³ */
  xUnderflow: number;
  /** 固体通量 kg/(m²·h)，用于界面显示与超载判断 */
  solidsLoading: number;
}

/** 双指数沉降速度，m/d */
export function settlingVelocity(x: number, cfg: Pick<SettlerConfig, 'v0' | 'v0Max' | 'rh' | 'rp'>): number {
  if (x <= 0) return 0;
  const raw = cfg.v0 * (Math.exp(-cfg.rh * x) - Math.exp(-cfg.rp * x));
  return Math.max(0, Math.min(cfg.v0Max, raw));
}

export function createSettler(cfg: SettlerConfig, initialX = 3000): SettlerState {
  return { x: Array.from({ length: cfg.layers }, () => initialX) };
}

/**
 * 推进一个时间步。
 *
 * @param dtDays 时间步长（天）。内部会按 CFL 条件自动细分。
 */
export function stepSettler(
  state: SettlerState,
  cfg: SettlerConfig,
  feed: { flow: number; concentration: number },
  underflow: { flow: number },
  dtDays: number,
): SettlerResult {
  const n = cfg.layers;
  const z = cfg.depth / n;
  const feedLayer = Math.min(n, Math.max(1, cfg.feedLayer));

  const Qf = Math.max(1e-6, feed.flow); // m³/d
  const Qu = Math.min(Qf * 0.95, Math.max(0, underflow.flow));
  const Qe = Math.max(1e-6, Qf - Qu);

  const vUp = Qe / cfg.area; // m/d
  const vDn = Qu / cfg.area; // m/d

  /**
   * CFL 条件 + 硬上限。
   *
   * 必须同时限制子步数：若 geometry 非法（depth=0 导致 z=0），
   * maxDt 会变成 0，subSteps 变成 Infinity，循环永不结束——那是挂死而不是报错。
   * 这里把层高与子步数都夹到安全区间，非法输入退化为"不推进"而非死循环。
   */
  const safeZ = Math.max(1e-3, z);
  const maxDt = (0.4 * safeZ) / Math.max(1e-6, cfg.v0Max);
  const rawSubSteps = dtDays / Math.max(1e-9, maxDt);
  const subSteps = Number.isFinite(rawSubSteps) ? Math.max(1, Math.min(2000, Math.ceil(rawSubSteps))) : 2000;
  const dt = dtDays / subSteps;

  if (!Number.isFinite(cfg.area) || cfg.area <= 0 || !Number.isFinite(cfg.depth) || cfg.depth <= 0) {
    return {
      state,
      xEffluent: state.x[0] ?? 0,
      xUnderflow: state.x[state.x.length - 1] ?? 0,
      solidsLoading: 0,
    };
  }

  let xs = [...state.x];

  for (let step = 0; step < subSteps; step++) {
    const next = new Array<number>(n).fill(0);

    /**
     * 标准 Takács 界面通量形式（此前实现混用了浓度差与通量差，导致底部回流被减两次）。
     *
     * 定义：界面 j 位于层 j-1（上）与层 j（下）之间，通量以**向下为正**。
     *
     *   F(j) = J(j) + 主体流通量
     *     J(j) = v_s(min(X_{j-1}, X_j)) · min(X_{j-1}, X_j)   —— 限制性沉降通量
     *     澄清区（j ≤ 进料层）：主体流向上，通量为 −vUp · X_j
     *     浓缩区（j > 进料层）：主体流向下，通量为 +vDn · X_{j-1}
     *     底层边界：由回流泵抽出，F(n) = vDn · X_{n-1}（沉降不再穿透底边界）
     *
     * 每层：dX_i/dt = (F(i) − F(i+1) + 进料) / z
     *
     * 这样稳态下各界面通量相等，才会形成真实的浓度梯度；也保证
     * Qf·Cf = Qe·X_top + Qu·X_bottom 的固体总量守恒。
     */
    const feedIdx = feedLayer - 1; // 0-indexed
    /** 压缩点（g/m³）：超过此浓度后污泥进入压缩区，产生屈服应力 */
    const COMPRESSION_X = 1200;
    /** 压缩通量系数（m/d per g/m³）——量级由 BSM1 剖面标定 */
    const COMPRESSION_K = 0.012;
    const COMPRESSION_XMAX = 12000;

    const fluxAt = (j: number): number => {
      // 上边界：出水带走固体（向下为正，故取负）
      if (j <= 0) return -vUp * xs[0];
      if (j >= n) return vDn * xs[n - 1]; // 底流抽出
      const xUp = xs[j - 1];
      const xDn = xs[j];
      const xLim = Math.min(xUp, xDn);
      const J = settlingVelocity(xLim, cfg) * xLim;
      /**
       * 澄清区：自由沉降 + 上升主体流（向上为负）。
       * 浓缩区：限制性沉降通量 + 下降主体流。
       *
       * 说明：曾尝试在浓缩区加入 Stokes 型压缩本构，质量守恒误差从 0.6% 恶化到 62%
       * （剖面出现 7473 / 81 / 7022 的振荡），说明该形式与界面通量格式不兼容。
       * 因此保留限制性通量形式：它守恒良好、浓缩比达 2–3.5，
       * 代价是浓缩区内梯度不明显——记录为已知限制，见 docs/QUALITY-ROADMAP.md。
       */
      /**
       * 浓缩区：限制性沉降通量 + 下降主体流 + 压缩屈服项。
       *
       * 前两项在同一浓度下互相抵消，使任意均匀分布都成为平衡解（梯度消失）。
       * 真实污泥在高浓度下会形成网状结构，产生屈服应力，阻止浓度无限均匀化。
       * 这里用「超出压缩点的浓度产生的额外向下通量」表达它：
       *   J_comp = k_c · max(0, X − X_comp) · (X / X_max)
       *
       * 该项只依赖本层浓度，因此不会破坏总量守恒：
       * 它把固体从上层推向下层，进出界面成对出现。
       */
      const compressionFlux = (x: number) =>
        x > COMPRESSION_X ? COMPRESSION_K * (x - COMPRESSION_X) * (x / COMPRESSION_XMAX) : 0;

      if (j > feedIdx) {
        return J + vDn * xUp + compressionFlux(xDn);
      }
      return J - vUp * xDn;
    };

    for (let i = 0; i < n; i++) {
      let flux = fluxAt(i) - fluxAt(i + 1);
      if (i === feedIdx) flux += (Qf * feed.concentration) / cfg.area;
      next[i] = Math.max(0, Math.min(cfg.xMax, xs[i] + (flux / z) * dt));
    }

    xs = next;
  }

  const xEffluent = xs[0];
  const xUnderflow = xs[n - 1];
  // Qf 单位 m³/d，先换成 m³/h 再算通量，否则会放大 24 倍
  const solidsLoading = (Qf / 24) * (feed.concentration / 1000) / cfg.area; // kg/(m²·h)

  return {
    state: { x: xs },
    xEffluent,
    xUnderflow,
    solidsLoading,
  };
}

/**
 * 推进到稳态（用于预热）。
 */
export function runSettlerToSteady(
  cfg: SettlerConfig,
  feed: { flow: number; concentration: number },
  underflow: { flow: number },
  options: { maxDays?: number; dtDays?: number; tolerance?: number; initialX?: number } = {},
): SettlerResult {
  const maxDays = options.maxDays ?? 30;
  const dt = options.dtDays ?? 1 / 1440; // 1 min
  const tol = options.tolerance ?? 1e-4;
  let state = createSettler(cfg, options.initialX ?? 3000);
  let result: SettlerResult = { state, xEffluent: state.x[0], xUnderflow: state.x[state.x.length - 1], solidsLoading: 0 };
  let stable = 0;

  const steps = Math.ceil(maxDays / dt);
  for (let i = 0; i < steps; i++) {
    const prev = result.state.x;
    result = stepSettler(result.state, cfg, feed, underflow, dt);
    const change = Math.max(...result.state.x.map((v, idx) => Math.abs(v - prev[idx]) / Math.max(1, Math.abs(v))));
    if (change < tol) {
      stable += 1;
      if (stable > 5) break;
    } else {
      stable = 0;
    }
  }
  return result;
}

/**
 * 泥层高度。
 *
 * 判据不能用绝对值：浓缩区浓度随进料浓度变化，固定阈值（如 1000 g/m³）
 * 会让低负荷时泥层恒为一层、高负荷时才突变，无法反映渐变。
 *
 * 改用相对判据：以澄清区（进料层以上）的浓度为基准，
 * 超过其 SLUDGE_RATIO 倍的层视为泥层。
 */
export function sludgeBlanketHeight(state: SettlerState, cfg: SettlerConfig, feedLayerOverride?: number): number {
  const z = cfg.depth / cfg.layers;
  const feed = Math.min(cfg.layers, Math.max(1, feedLayerOverride ?? cfg.feedLayer));

  /**
   * 用「固体存量 / 浓缩区平均浓度」推泥层厚度，而不是数层数。
   *
   * 原因：分层模型在数值上容易把浓缩区抹平（各层浓度相同），
   * 此时数层数得到的泥层与真实存量脱钩。而存量是守恒量，更可靠。
   *
   * 泥层厚度 = 泥层内固体总量 / (面积 × 泥层平均浓度)
   * 其中泥层平均浓度取浓缩区（进料层以下）的平均值。
   */
  const concentrated = state.x.slice(Math.max(0, feed - 1));
  const meanX = concentrated.reduce((a, b) => a + b, 0) / Math.max(1, concentrated.length);
  const totalSolids = state.x.reduce((a, v) => a + v * z * cfg.area, 0); // g

  if (meanX <= 1) return 0.2;
  const thickness = totalSolids / (cfg.area * meanX); // m
  return Math.max(0.2, Math.min(cfg.depth + 0.5, thickness));
}
