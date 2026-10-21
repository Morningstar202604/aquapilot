# AquaPilot

**English** · [中文](README.zh-CN.md)

> An AI-operated wastewater treatment plant simulator. The plant is a graph, the graph is the model, and an AI operator runs it.

AquaPilot is a working prototype of a new interaction model for process simulation: instead of an engineer reading curves and turning knobs, an AI operator watches the plant, forecasts, decides, and acts — while the human asks questions and sets boundaries.

![tests](https://img.shields.io/badge/tests-142%20passing-brightgreen)
![typescript](https://img.shields.io/badge/TypeScript-strict-blue)
![license](https://img.shields.io/badge/license-MIT-blue)

---

## Why

Industrial simulators (GPS-X, BioWin, Aspen HYSYS) are powerful but assume the operator is a process engineer who sets parameters, reads plots, and judges. AquaPilot inverts the division of labour:

| Traditional simulator | AquaPilot |
|---|---|
| Engineer configures the flowsheet | Engineer draws the plant, AI runs it |
| Engineer reads trends | AI explains every decision with numbers |
| Engineer tunes setpoints | AI proposes, guardrails constrain, human can override |
| Offline design study | Live, continuous operation with scenarios |

## What it does

- **Topology-driven solving.** Edit a flowsheet; the engine compiles it into reactors, orders them topologically, and solves it. Add a tank and the engine really solves one more tank — not a hard-coded five.
- **Real process models.** ASM1 (13 components / 8 processes) with exact stoichiometric conservation, plus a Takács ten-layer secondary clarifier.
- **AI operator.** Every 15 simulated minutes it forecasts 4 hours ahead, scores candidate control moves against compliance margin, cost and stability, then applies the best one inside hard guardrails.
- **Explainable by construction.** Each recommendation carries the predicted effluent, the candidate ranking, the per-tweak reason, and a confidence figure.
- **Scenario injection.** Storm, shock load, toxicity, blower failure, RAS failure, power outage, winter, chemical shortage.

## Quick start

```bash
npm ci
npm run build
npm start          # http://127.0.0.1:5173
```

Development with hot reload:

```bash
npm run dev        # client on :5174, server on :5173
```

Verify:

```bash
npm run typecheck  # TypeScript strict, no errors
npm run test       # 142 tests
npm run build      # client bundle + server bundle
npm run verify     # all three in order
```

## Architecture

```
src/
  model/         Flowsheet topology (single source of truth)
    topology.ts    units, ports, streams, validation, run-readiness
    layout.ts      automatic layout: main line, utilities, sludge line, recycles
  sim/           Simulation engines
    kinetics.ts    single source for kinetic constants and tariffs
    network.ts     topology -> compiled network, topological order, flow solving
    networkEngine.ts  production engine: N reactors driven by the topology
    engine.ts      reference engine: fixed five-tank, used for calibration/regression
    asm1.ts        ASM1: 13 components, 8 processes, stoichiometry derived from parameters
    asm1Cstr.ts    single-CSTR solver for ASM1 verification
    takacs.ts      Takács ten-layer secondary clarifier
    metrics.ts     shared pure helpers (scoring, margins, clamping)
    plantTypes.ts  shared value types
  ai/            Decision layer
    agent.ts       rolling-horizon forecasting, candidate scoring, guardrails, Q&A
  server/        WebSocket simulation loop, REST snapshot, static hosting
  client/        Control-room UI (React + ECharts + SVG flowsheet)
  shared/        Client/server protocol
tests/           142 tests: physics, conservation, guardrails, topology, cross-engine
```

### The three-layer contract

```
topology  →  layout  →  render
    ↘
     solve
```

The renderer holds no process knowledge. It draws whatever state the solver produced. This is what prevents the classic failure where the picture looks right but the numbers are wrong.

## What actually runs

Measured on this repository:

| Claim | Evidence |
|---|---|
| Adding a reactor really adds one | `npx tsx scripts/prove-network-solving.ts` → 5 → 6 → 7 → 3 reactors |
| Live topology edits rebuild the plant | `npx tsx scripts/e2e-topology-live.ts` → 5 reactors, NH₄ 0.10 → 6 reactors, NH₄ 0.03 → back to 5 |
| ASM1 stoichiometry is exact | `tests/asm1.test.ts` → N and alkalinity residuals ≤ 7e-18 |
| The settler is calibrated | `npx tsx scripts/check-takacs.ts` → effluent SS 6.5 g/m³, solids loading 3.07 kg/(m²·h) |
| Changing a plant parameter changes the physics | `npx tsx scripts/prove-topology-matters.ts` |

## Status and limits

This is a **simulation prototype**, not a system that can take over a real plant.

Verified:
- Topology-driven reactor count and ordering
- ASM1 conservation laws (exact), kinetics sanity (generation times in literature range)
- Takács effluent and underflow against BSM1-scale operating points
- 142 tests, TypeScript strict, CI green

Known gaps (tracked in `docs/QUALITY-ROADMAP.md`):
- The ten-layer settler does not build a strong concentration gradient in the thickening zone, so underflow concentration is lower than reality
- ASM1 effluent TN runs slightly above the discharge limit in the default configuration
- No automated comparison against the official BSM1 Table 6 values (those numbers were not available when this was built)
- ASM1 has no phosphorus; TP relies on chemical precipitation
- Single-user, in-memory state; no persistence or history replay

## Documentation

- [UI architecture](docs/UI-ARCHITECTURE.md) — how a flowsheet becomes a running model
- [Quality roadmap](docs/QUALITY-ROADMAP.md) — measured gaps, priorities, and the record of what failed and why
- [中文说明](README.zh-CN.md)

## Licence

MIT
