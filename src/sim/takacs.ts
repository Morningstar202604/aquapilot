/**
 * Takács 十层二沉池模型（BSM1 标准）。
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

  // CFL：v0_max·dt/z < 0.4
  const maxDt = (0.4 * z) / Math.max(1e-6, cfg.v0Max);
  const subSteps = Math.max(1, Math.ceil(dtDays / maxDt));
  const dt = dtDays / subSteps;

  let xs = [...state.x];

  for (let step = 0; step < subSteps; step++) {
    const J = xs.map((v) => settlingVelocity(v, cfg) * v); // g/(m²·d)
    const next = new Array<number>(n).fill(0);

    /**
     * 每层的固体守恒：d(V·X)/dt = Σ(界面通量)
     *
     * 界面通量 = 沉降通量(向下) + 主体流通量
     * 沉降通量用「限制性通量」：J = v_s(min(X_上, X_下)) · min(X_上, X_下)，
     * 这样相邻层浓度相同时不会凭空产生通量差，也不会阻碍浓差扩散。
     */
    for (let i = 0; i < n; i++) {
      const layer = i + 1;
      const xHere = xs[i];

      // 界面上方（i）与下方（i+1）的沉降通量，向下为正
      const settleFlux = (iface: number): number => {
        if (iface <= 0 || iface >= n) return 0;
        const xUpper = xs[iface - 1];
        const xLower = xs[iface];
        const xLim = Math.min(xUpper, xLower);
        return settlingVelocity(xLim, cfg) * xLim;
      };

      const Jabove = settleFlux(i);
      const Jbelow = settleFlux(i + 1);

      // 主体流：澄清区向上、浓缩区向下
      let bulk = 0;
      if (layer < feedLayer) {
        bulk = vUp * (xs[i + 1] - xHere);
      } else if (layer > feedLayer) {
        bulk = vDn * (xs[i - 1] - xHere);
      } else {
        bulk = (Qf * feed.concentration) / cfg.area - vUp * xHere - vDn * xHere;
      }

      let flux = bulk + Jabove - Jbelow;

      // 底层：回流泵抽走固体（按底层浓度）
      if (layer === n) flux -= vDn * xHere;

      next[i] = Math.max(0, Math.min(cfg.xMax, xHere + (flux / z) * dt));
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
