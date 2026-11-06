# Working on AquaPilot

Guidance for humans and AI assistants changing this repository. It records the
rules that are not obvious from the code, and the traps that have already cost
someone a day.

## What this project is

A topology-driven wastewater treatment simulator: React console in the browser,
one Node process serving HTTP + WebSocket + MCP, ASM1/Takács core, SQLite
history. `docs/QUALITY-ROADMAP.md` records where the model is deliberately
simplified; `docs/COMPARISON.md` records what it deliberately is not.

## Before you change anything

1. Read `docs/UI-ARCHITECTURE.md` (frontend) or `docs/API.md` (protocol). Both
   describe the current tree, not a planned state.
2. Run `npm run ci` first. A red baseline means your change is not the cause, and
   you need to know that before debugging.
3. Find the existing test for the area you are touching. If there is none, that is
   itself information: say so in the change description rather than implying
   coverage that does not exist.

## The rules that actually matter here

**Never claim a number you did not measure.** Every figure in the README and
`docs/BENCHMARKS.md` is reproducible from a command listed next to it. If you
change a model constant, re-run the benchmark and update the number, or delete the
claim. An outdated but plausible number is worse than no number.

**Separate "the model is faithful" from "the plant is compliant."** The default
plant reproduces BSM1, which settles at TSS ≈ 11.7 mg/L. That is faithful to the
benchmark and above GB 18918 Class 1A's 10 mg/L. Never "fix" the model to make a
compliance number look better, and never report the Class 1A failure without also
naming the envelope. `src/sim/standards.ts` exists for exactly this reason.

**Scores are computed, never self-reported.** The AI operator does not grade
itself. `src/sim/scorecard.ts` computes from simulation output; the reference
benchmark found LLM self-assessment inflating its own score by up to 20 points.

**Guardrails are not advisory.** `src/server/aiGuard.ts` marks a move as blocked
when it is clamped back to where it was; the log must say "blocked", not
"executed". If you add a control path, route it through the same guard.

**Empty is not zero.** A missing sensor series, a disabled persistence layer and a
zero-valued metric are three different states, and the UI must not collapse them.
When there is no data, say so; do not render `0.000`.

**Every long-running or expensive path needs a stated cost.** Analysis (~300 ms),
calibration (up to 156 s) and the 30-day scorecard (~0.8 s) each have a documented
budget and a reason to be on-demand rather than continuous. Do not put them in the
tick loop.

## Verification contract

```bash
npm run ci      # 11 steps: deps, version, typecheck, lint+format, tests+coverage,
                # build, smoke, secrets, backup round-trip, audit, hygiene
npm run e2e     # real browser: KPIs, panels, canvas, topbar widths, console errors
npm run exe     # Node SEA single-file binary
```

A green `npm run ci` is the merge bar. Coverage thresholds are 90 lines / 81
branches / 95 functions over the model, AI and server sources — they are a
regression alarm, not a target to chase by lowering.

When you fix a bug, first write the test that fails because of it. The repository
has several tests whose comments start with "this exists because of a real
defect" — that is the intended style: the test documents the failure mode, not
just the expected output.

## Version discipline

`package.json`, `src/shared/version.ts`, `CITATION.cff` and the top CHANGELOG
section must agree; `npm run check:version` enforces it (and
`node scripts/check-version.mjs --fix-cff` aligns them). `src/shared/version.ts`
exists because a runtime `npm_package_version` lookup silently fell back to a
hardcoded version under Docker and the SEA exe.

Release steps: bump the four declarations, move `Unreleased` content into the new
section, tag `vX.Y.Z`, push, then let `.github/workflows/release.yml` publish.

## Style

- Comments explain **why**, and specifically what went wrong before. A comment
  that restates the code is noise.
- Chinese comments and UI copy are the product's default language; public
  interfaces (MCP tool descriptions, README, API docs) are English.
- No new runtime dependency without a recorded reason in
  `docs/DEPENDENCY-EVALUATION.md`.

## Traps already hit

| Symptom | Cause | Where it is documented |
|---|---|---|
| Trend curves froze after 720 points | cursor counted points instead of using timestamps | `src/server/trendCursor.ts` header |
| Ghost forecast band after reset | ECharts `setOption` merges by index | `src/client/components/Trends.tsx` |
| MCP reported version 0.6.0 | `npm_package_version` missing outside npm | `src/shared/version.ts` |
| Mass balance off by 37.8 % | oxidation was not counted as a COD sink | `src/sim/analysis.ts` |
| Topbar slid out of viewport | focusing a menu item scrolled an `overflow: hidden` bar | `src/client/styles.css` |
| CI green locally, red remotely | missing CJK fonts changed text metrics | `.github/workflows/ci.yml` |

## Where to look first

- Simulation: `src/sim/networkEngine.ts` (the state machine), `src/sim/plantModel.ts`
  (prediction interface), `src/sim/asm1.ts` + `src/sim/takacs.ts` (the physics).
- Server: `src/server/index.ts` (wiring only), `snapshotView.ts` (projection),
  `mcp.ts` (agent surface), `auth.ts` (roles).
- Client: `src/client/hooks/useSimulation.ts` (all state), `App.tsx` (layout and
  tabs), `PlantCanvas.tsx` (the flowsheet), `ProcessEditor.tsx` (editing).
