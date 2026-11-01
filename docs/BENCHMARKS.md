# Benchmarks and measured numbers

Every number in this file is reproducible from the repository. Commands are
listed next to the tables; nothing here is a projection.

## 1. BSM1 Table 6 — open-loop steady state

```bash
npx vitest run tests/bsm1-benchmark.test.ts
```

Configuration: five tanks 1000 / 1000 / 1333 / 1333 / 1333 m³, Qintr = 55 338 m³/d,
QR = 18 446 m³/d, QW = 385 m³/d, KLa 240 / 240 / 84 d⁻¹, DO saturation 8 g/m³,
settler 1 500 m² × 4 m with feed 2.2 m above the bottom, Henze-1987 parameter set.

| Metric | Engine | Official | Deviation | Gate |
|---|---:|---:|---:|---|
| S_S (g COD/m³) | 0.872 | 0.889 | −2.0 % | ±10 % |
| S_NO (g N/m³) | 11.135 | 10.415 | +6.9 % | ±10 % |
| S_NH (g N/m³) | 1.545 | 1.733 | −10.8 % | ±25 % |
| S_ALK (mol/m³) | 4.061 | 4.13 | −1.7 % | ±10 % |
| S_O (g O₂/m³) | 0.526 | 0.491 | +7.2 % | ±20 % |
| X_B,A (g COD/m³) | 150.8 | 152–154 (closed-loop) | same order | informational |
| TSS (g/m³) | 11.58 | 12.5 | −7.4 % | known settler limit |

The current source run converged after 24 simulated days. Values are regenerated
from `runBsm1OpenLoopSteady()` and the conventional ASM1 conversion, not copied
from an earlier run. The tolerances are behavioral gates; they do not claim exact
reproduction of every Table 6 number.

## 2. AI vs fixed strategy — same influent

```bash
npx tsx scripts/prove-benchmark.ts
BENCH_DAYS=7 npx tsx scripts/prove-benchmark.ts   # longer run
```

Two simulated days, seed 20261019, 96 decision cycles of 30 simulated minutes.
The script calls the decision function with `robust: false`; this is deliberately
separate from the production 15-minute cadence and robust candidate re-check.

Fixed strategy: DO 2.0 mg/L, internal recycle 2.0×Q, RAS 0.8×Q, WAS 2.2 %,
PAC 40 mg/L, step feed 0.3×Q, no AI. Both plants use the same 30-day warm-up.

A recent Node 24 run from the current source produced the following controlled
simulation result. It is not a field A/B test, and the result depends on the seed,
initial state, influent, warm-up, decision interval, and fixed strategy.

| Metric | AI | Fixed | Delta |
|---|---:|---:|---:|
| Compliance rate (minutes) | 44.7 % | 43.9 % | +0.8 pp |
| Specific energy kWh/m³ | 0.147 | 0.163 | −0.016 |
| Cost ¥/m³ | 0.1397 | 0.1987 | −29.7 % |
| Mean effluent score | 42.2 | 40.1 | +2.0 |

The residual non-compliance on the manual side is almost entirely BOD₅, which is
derived from effluent soluble COD; the AI keeps a wider COD margin and a lower
PAC dose without losing the TP backstop.

**What this is not.** It is not a field A/B test. It is an in-simulator controlled
comparison where only the control policy differs. The manual policy is a
defensible design-point operating strategy, not a strawman, but a different
manual strategy would produce a different gap.

## 3. Physics responds to topology

```bash
npx tsx scripts/prove-network-solving.ts
npx tsx scripts/prove-topology-matters.ts
```

> `prove-network-solving.ts` uses seed 42. `prove-topology-matters.ts` uses the
> default seed and reports its own baseline. Values below are from the current source;
> compare arrows only within the same script.

| Change | Result |
|---|---|
| Standard A²/O | 5 reactors, NH₄ 0.50 mg/L, TN 10.98 (seed 42) |
| +1 anoxic tank | 6 reactors, NH₄ 0.52, TN 10.30 |
| +2 aerobic tanks | 7 reactors, NH₄ 0.15, TN 10.88 |
| Only one aerobic tank | 3 reactors, NH₄ 16.28, TN 21.48 (exceeds limits) |
| Aerobic volume ×2 | NH₄ 0.51 → 0.16 (COD 39.2 → 28.8) |
| Aerobic volume ÷2 | NH₄ 0.51 → 8.15 (COD 39.2 → 54.2, TP 0.010 → 0.540) |
| Clarifier area ×2 | blanket 0.38 → 0.25 m (4000 → 8000 m²) |

## 4. Engine and decision cost

```bash
npx tsx scripts/bench.ts
```

| Item | Measured |
|---|---|
| 1-minute step (production engine) | 0.0217 ms |
| 4-hour forecast | 6.09 ms |
| Decision, production engine, nominal | 200.2 ms |
| Decision, production engine, robust (3 shortlisted + hold × 3 samples) | 243.8 ms |
| 30-day warm-up | 664 ms |
| Heap after benchmarks | 14.9 MB heap used / 78.1 MB RSS |

Timings vary ±30 % between runs on a shared machine; the order of magnitude is
what matters here (all figures come from `scripts/bench.ts` on Node 24).

The decision budget is 30 s (15 simulated minutes at 1× speed); the current
nominal/robust measurements are about 200/244 ms, leaving two orders of magnitude
of headroom. Robustness is therefore affordable at every decision cycle.

## 5. Test and coverage

```bash
npm test
npx vitest run --coverage
```

| Item | Value |
|---|---|
| Test files | 89 |
| Tests | 1094 |
| Line coverage | 94.08 % |
| Branch coverage | 81.48 % |
| Function coverage | 95.66 % |

Coverage is measured with `vitest.config.ts` over the model, AI, simulation, and
server sources plus the shared label helper. It is a domain-coverage gate, not a
claim that every React component is instrumented. Thresholds are 90 / 81 / 95 for
lines / branches / functions; V8 counts can vary across Node versions.
