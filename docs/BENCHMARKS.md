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
| Compliance rate (minutes) | 92.3 % | 56.7 % | +35.6 pp |
| Specific energy kWh/m³ | 0.150 | 0.159 | −5.6 % |
| Cost ¥/m³ | 0.1420 | 0.1963 | −27.7 % |
| Mean effluent score | 57.8 | 46.4 | +11.3 |

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

| Change | Result |
|---|---|
| Standard A²/O | 5 reactors, NH₄ 0.11 mg/L |
| +1 anoxic tank | 6 reactors, NH₄ 0.13, TN 9.74 → 9.15 |
| +2 aerobic tanks | 7 reactors, NH₄ 0.03 |
| Only one aerobic tank | 3 reactors, NH₄ 7.01 (exceeds limit) |
| Aerobic volume ×2 | NH₄ 0.074 → 0.034 |
| Aerobic volume ÷2 | NH₄ 0.074 → 1.149 |
| Clarifier area ×2 | blanket 1.15 → 0.66 m |
| RAS failure | blanket 0.99 → 1.79 m |

## 4. Engine and decision cost

```bash
npx tsx scripts/bench.ts
```

| Item | Measured |
|---|---|
| 1-minute step | 0.003 ms |
| 4-hour forecast | 1.4 ms |
| Decision, production engine, nominal | 153 ms |
| Decision, production engine, robust (3 shortlisted + hold × 3 samples) | 215 ms |
| 30-day warm-up | ~110 ms |
| Heap after benchmarks | ~12–24 MB |

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
| Test files | 23 |
| Tests | 344 |
| Line coverage | 95.7 % |
| Branch coverage | 84.3 % |
| Function coverage | 94.8 % |

Coverage thresholds are pinned to the strictest values that hold on both Node 20
and Node 22 (V8 counts branches differently between versions).
