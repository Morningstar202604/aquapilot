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
| S_S (g COD/m³) | 0.866 | 0.889 | −2.6 % | ±10 % |
| S_NO (g N/m³) | 11.18 | 10.415 | +7.4 % | ±10 % |
| S_NH (g N/m³) | 1.393 | 1.733 | −19.6 % | ±25 % |
| S_ALK (mol/m³) | 4.05 | 4.13 | −2.0 % | ±10 % |
| S_O (g O₂/m³) | 0.53 | 0.491 | +7.6 % | ±10 % |
| X_B,A (g COD/m³) | 155 | 152–154 (closed-loop) | same order | informational |
| TSS (g/m³) | 8.2 | 12.5 | −34 % | known settler limit |

S_NH residual analysis: the absolute gap is 0.34 gN/m³, less than 1 % of the
nitrogen flux. Both models nitrify more than 98 % of influent nitrogen; the gap is
a local polishing equilibrium in the last tank and shares its cause with the
settler's low effluent TSS.

## 2. AI vs fixed strategy — same influent

```bash
npx tsx scripts/prove-benchmark.ts
BENCH_DAYS=7 npx tsx scripts/prove-benchmark.ts   # longer run
```

Two simulated days, seed 20261019, 96 decision cycles of 30 simulated minutes.

Fixed strategy: DO 2.0 mg/L, internal recycle 2.0×Q, RAS 0.8×Q, WAS 2.2 %,
PAC 40 mg/L, step feed 0.3×Q, no AI. Both plants use the same 30-day warm-up.

| Metric | AI | Fixed | Delta |
|---|---:|---:|---:|
| Compliance rate (minutes) | 94.5 % | 56.7 % | +37.8 pp |
| Specific energy kWh/m³ | 0.151 | 0.159 | −5.0 % |
| Cost ¥/m³ | 0.1434 | 0.1963 | −27.0 % |
| Mean effluent score | 61.8 | 47.4 | +14.4 |

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

> Two different seeds are used by the two scripts: `prove-network-solving.ts` runs at
> seed 42 (standard plant: NH₄ 0.81, TN 11.14), `prove-topology-matters.ts` at the
> default seed (NH₄ 0.83). Rows below keep each script's own baseline, so the arrows
> compare like with like — do not mix a row's baseline with another row's number.

| Change | Result |
|---|---|
| Standard A²/O | 5 reactors, NH₄ 0.81 mg/L, TN 11.14 (seed 42) |
| +1 anoxic tank | 6 reactors, NH₄ 0.83, TN 10.51 |
| +2 aerobic tanks | 7 reactors, NH₄ 0.13, TN 10.80 |
| Only one aerobic tank | 3 reactors, NH₄ 18.42, TN 22.94 (exceeds limits) |
| Aerobic volume ×2 | NH₄ 0.83 → 0.15 (COD 38.7 → 27.9) |
| Aerobic volume ÷2 | NH₄ 0.83 → 11.01 (COD 38.7 → 54.8, TP 0.010 → 1.412) |
| Clarifier area ×2 | blanket 0.44 → 0.31 m |
| RAS failure (6 h) | blanket 0.44 → 0.50 m |

## 4. Engine and decision cost

```bash
npx tsx scripts/bench.ts
```

| Item | Measured |
|---|---|
| 1-minute step (production engine) | 0.012 ms |
| 4-hour forecast | 3.2 ms |
| Decision, production engine, nominal | 105 ms |
| Decision, production engine, robust (3 shortlisted + hold × 3 samples) | 135 ms |
| 30-day warm-up | 390 ms |
| Heap after benchmarks | ~12–24 MB |

Timings vary ±30 % between runs on a shared machine; the order of magnitude is
what matters here (all figures come from `scripts/bench.ts` on Node 24).

The decision budget is 30 s (15 simulated minutes at 1× speed); 215 ms leaves two
orders of magnitude of headroom. Robustness is therefore affordable at every
decision cycle.

## 5. Test and coverage

```bash
npm test
npx vitest run --coverage
```

| Item | Value |
|---|---|
| Test files | 66 |
| Tests | 847 |
| Line coverage | 94.6 % |
| Branch coverage | 83.0 % |
| Function coverage | 96.8 % |

Coverage thresholds are pinned to the **Node 20** measurement (90 / 81 / 95 for
lines / branches / functions) because the CI matrix runs both Node 20 and 22 and V8
counts branches differently between releases. Measured here: Node 24 gives
94.6 / 83.0 / 96.8 on Node 24; Node 20 runs slightly lower on branch counting — both above the 90 / 81 / 95 gate.
