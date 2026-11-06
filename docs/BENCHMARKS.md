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
| Test files | 94 |
| Tests | 1286 |
| Statement coverage | 92.75 % |
| Branch coverage | 82.93 % |
| Function coverage | 95.87 % |
| Line coverage | 94.39 % |

Measured 2026-11-06 on Node 24.20.0, working tree at v0.8.0. Numbers move with the
tree; the table above is the reference point for the current release, and the
thresholds in `vitest.config.ts` are what CI actually enforces.

## 6a. Operational scorecard baseline

```bash
aquapilot scorecard                    # 30-day crisis timeline, Class 1A envelope
aquapilot scorecard --standard bsm1-reference
```

| Envelope | Total | Compliance | Energy | Stability | Crisis | Samples |
|---|---:|---:|---:|---:|---:|---:|
| GB 18918-2002 Class 1A | 43 | 0 | 89 | 97 | 31 | 1440 |
| IWA BSM1 reference | 42 | 12 | 89 | 97 | 0 | 1440 |

Measured 2026-11-06 with the standard 30-day script, seed 20261019, on the default
A²/O plant. The two runs are the same simulation judged against different
envelopes — which is the point of publishing both. Under Class 1A the plant fails
SS on 1023 of 1440 samples because it settles at TSS ≈ 11.7 mg/L, faithful to
BSM1 but above the 10 mg/L Class 1A limit; under the BSM1 envelope SS violations
drop to 75 (NH₄ and TN become the binding constraints instead — 261 and 218
samples — so the compliance dimension only rises from 0 to 12). Treating that as a model defect would be wrong, and treating it as
"compliant" under Class 1A would be worse. The card states which envelope it used.

Runtime: 0.8 s for 30 simulated days (43 200 steps) on a single core.

## 6. Mutation testing baseline

```bash
npm run mutation        # Stryker 10, scope: src/sim/asm1.ts + src/sim/takacs.ts
```

| Item | Value |
|---|---|
| Mutants | 399 |
| Mutation score | 28.07 % (asm1 51.15 %, takacs 0.55 %) |

Measured 2026-10-23 (see `docs/AUDIT-REPORT.md` §12.3 for the full breakdown and
why the score reads low). Not wired into CI — a full run costs ~23 min; it stays
as a manual quality tool. Raising it needs golden-trajectory snapshot tests, which
are tracked as future work rather than claimed here.

Coverage is measured with `vitest.config.ts` over the model, AI, simulation, and
server sources plus the shared label helper. It is a domain-coverage gate, not a
claim that every React component is instrumented. Thresholds are 90 / 81 / 95 for
lines / branches / functions; V8 counts can vary across Node versions.
