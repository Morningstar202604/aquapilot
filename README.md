# AquaPilot

**English** · [中文](README.zh-CN.md)

> An AI-operated wastewater treatment plant simulator. The plant is a graph, the graph is the model, and an AI operator runs it.

AquaPilot is a working prototype of a new interaction model for process simulation: instead of an engineer reading curves and turning knobs, an AI operator watches the plant, forecasts, decides, and acts — while the human asks questions and sets boundaries.

![tests](https://img.shields.io/badge/tests-211%20passing-brightgreen)
![typescript](https://img.shields.io/badge/TypeScript-strict%20%2B%20noUnused-blue)
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
npm run typecheck  # TypeScript strict + noUnusedLocals/Parameters
npm run test       # 211 tests
npm run build      # client bundle + server bundle
npm run verify     # all three in order
npm run ci         # full gate: deps, types, tests, build, smoke, secret scan

# Optional access control (off by default, for LAN or shared deployments)
AQUAPILOT_TOKEN=your-secret npm start
# then send Authorization: Bearer your-secret, or ?token= for WebSocket
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
tests/           211 tests: physics, conservation, guardrails, topology, cross-engine,
                 input validation and crash-boundary regressions
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

Verified **on this machine** by `npm run ci` (7/7 steps green):
- Dependency install, TypeScript strict (0 errors, including unused-code checks)
- 211 tests, all passing
- Client + server build, production bundle
- Smoke test: three endpoints respond under a real server
- Secret scan and artifact scan

CI configuration is provided for all three hosts (`.github/workflows/ci.yml`,
`.workflow/aquapilot-ci.yml` for Gitee Go, `.gitcode/pipeline.yml`).
**These are configuration files. Whether they execute depends on enabling CI in
each platform's web console, which cannot be provisioned from the repository.**
The claim above is about the local gate, not about a hosted badge.

Hardening added after an independent engineering audit (which reproduced nine
remotely-triggerable crashes in an earlier revision): runtime validation on every
client message, path-traversal rejection, WebSocket origin allowlist and payload
cap, heartbeat, crash boundaries around the tick loop and message handler,
and a bounded integrator in the settler.

Known gaps (tracked in `docs/QUALITY-ROADMAP.md`):
- The ten-layer settler does not build a strong concentration gradient in the thickening zone, so underflow concentration is lower than reality
- ASM1 effluent TN runs slightly above the discharge limit in the default configuration
- No automated comparison against the official BSM1 Table 6 values (those numbers were not available when this was built)
- ASM1 has no phosphorus; TP relies on chemical precipitation
- Single-user, in-memory state; no persistence or history replay
- Access control is opt-in: set AQUAPILOT_TOKEN to require a bearer token on HTTP
  and WebSocket. It is a single shared secret, not per-user accounts, and is not
  a substitute for TLS and a reverse proxy in production

## Documentation

- [UI architecture](docs/UI-ARCHITECTURE.md) — how a flowsheet becomes a running model
- [Quality roadmap](docs/QUALITY-ROADMAP.md) — measured gaps, priorities, and the record of what failed and why
- [中文说明](README.zh-CN.md)

## Licence

MIT
