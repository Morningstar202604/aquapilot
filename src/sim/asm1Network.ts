/**
 * ASM1 CSTR / network slice (M1 parity scaffold).
 *
 * This is deliberately a small, deterministic control volume: advection +
 * ASM1 reaction + optional RAS thickening. It is the TypeScript oracle for the
 * Rust `asm1_network` module and does not replace the plant engine. Keeping the
 * slice isolated makes cross-language parity auditable without pretending that
 * Takács, aeration control or ADM1 are already ported.
 */

import {
  ASM1_COMPONENTS,
  ASM1_PARAMS,
  reactionRates,
  type Asm1Component,
  type Asm1Params,
  type Asm1State,
} from './asm1';

export const ASM1_PARTICULATE: Asm1Component[] = ['X_I', 'X_S', 'X_B_H', 'X_B_A', 'X_P', 'X_ND'];

export const ASM1_COD_PER_VSS = 1.42;

export interface Asm1Reactor {
  id: string;
  volume: number;
  state: Asm1State;
}

export interface Asm1Edge {
  from: number | null;
  to: number;
  flow: number;
  recycle?: 'ras' | 'internal' | null;
}

export interface Asm1CstrOptions {
  volume: number;
  flow: number;
  dtHours: number;
  temperatureC?: number;
}

export interface Asm1NetworkOptions {
  dtHours: number;
  temperatureC?: number;
  /** Measured RAS solids, mg/L. Omit to use the minimum thickening ratio. */
  xRas?: number;
}

function clampState(s: Asm1State): Asm1State {
  const next = { ...s };
  for (const c of ASM1_COMPONENTS) {
    const v = next[c];
    next[c] = Number.isFinite(v) ? Math.max(0, v) : 0;
  }
  return next;
}

function particulate(s: Asm1State): number {
  return ASM1_PARTICULATE.reduce((sum, c) => sum + Math.max(0, s[c]), 0);
}

/** One completely mixed tank with a constant-volume feed and outflow. */
export function stepAsm1Cstr(
  state: Asm1State,
  influent: Asm1State,
  params: Asm1Params = ASM1_PARAMS,
  opts: Asm1CstrOptions,
): Asm1State {
  const dt = Math.max(0, opts.dtHours);
  const dilution = Math.min(1, (Math.max(0, opts.flow) * dt) / Math.max(1e-9, opts.volume));
  const reaction = reactionRates(state, params, opts.temperatureC ?? params.T_REF);
  const next = { ...state } as Asm1State;
  for (const c of ASM1_COMPONENTS) {
    next[c] = state[c] + (influent[c] - state[c]) * dilution + reaction[c] * dt;
  }
  return clampState(next);
}

/**
 * Ordered multi-reactor network. The fixture is a linear A²/O train; the
 * `from: null` edge is the external feed and `recycle: 'ras'` is the only
 * stream that is thickened. There is intentionally no settler state in this
 * slice: `xRas` is an input, not an output.
 */
export function stepAsm1Network(
  reactors: Asm1Reactor[],
  edges: Asm1Edge[],
  influent: Asm1State,
  params: Asm1Params = ASM1_PARAMS,
  opts: Asm1NetworkOptions,
): void {
  const dt = Math.max(0, opts.dtHours);
  const subH = Math.min(1 / 120, dt);
  const nSub = Math.max(1, Math.ceil(dt / Math.max(1e-9, subH)));
  const subDt = dt / nSub;
  const last = reactors[reactors.length - 1];
  const lastState = last ? { ...last.state } : null;
  const rasRatio = lastState
    ? Math.max(2.15, Math.min(6, ((opts.xRas ?? 0) * ASM1_COD_PER_VSS) / Math.max(1, particulate(lastState))))
    : 2.15;

  for (let idx = 0; idx < reactors.length; idx++) {
    const reactor = reactors[idx];
    let qIn = 0;
    let asmIn: Asm1State | null = null;
    for (const edge of edges) {
      if (edge.to !== idx || edge.flow <= 0) continue;
      let src: Asm1State;
      if (edge.recycle === 'ras' && lastState) {
        src = { ...lastState };
        for (const c of ASM1_PARTICULATE) src[c] *= rasRatio;
        src.S_O = 0;
        src.S_NO = 0;
      } else if (edge.recycle === 'internal' && lastState) {
        src = { ...lastState };
      } else if (edge.from === null) {
        src = influent;
      } else {
        src = reactors[edge.from].state;
      }
      if (asmIn === null) {
        asmIn = { ...src };
      } else {
        for (const c of ASM1_COMPONENTS) {
          asmIn[c] = (asmIn[c] * qIn + src[c] * edge.flow) / (qIn + edge.flow);
        }
      }
      qIn += edge.flow;
    }
    if (asmIn === null || qIn <= 0) continue;

    const qOverV = qIn / Math.max(1e-9, reactor.volume);
    for (let sub = 0; sub < nSub; sub++) {
      const reaction = reactionRates(reactor.state, params, opts.temperatureC ?? params.T_REF);
      const next = { ...reactor.state } as Asm1State;
      for (const c of ASM1_COMPONENTS) {
        next[c] = reactor.state[c] + qOverV * subDt * (asmIn[c] - reactor.state[c]) + reaction[c] * subDt;
      }
      reactor.state = clampState(next);
    }
  }
}
