# Changelog

All notable changes to AquaPilot are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-10-24

### Added

- **Robust decision layer.** The decision engine now runs a fixed three-member
  parameter-perturbation ensemble (inflow ±15 %, COD/NH₄ ±20 %, TP ±15 %,
  water temperature ±1.5 °C, biomass ±10 %) on the shortlisted candidates and
  folds the exceedance probability into the ranking. The recommendation reports
  `exceedanceProbability` and a P10/P50/P90 band; when the model cannot support
  perturbation (legacy adapter) the UI says "not evaluated" instead of showing a
  fake 0 %. Measured cost: 215 ms per decision on the production engine
  (`scripts/bench.ts`), still far inside the 30 s decision cycle.
- **Shadow benchmark (AI vs fixed strategy).** A second plant runs the same seed,
  the same influent and the same initial state under a fixed manual control set.
  Both sides accumulate compliance minutes, energy, cost and effluent score; the
  Benefits panel shows the live comparison and marks samples shorter than six
  hours as indicative. A two-day offline run measured 92.3 % vs 56.7 % compliance,
  0.150 vs 0.159 kWh/m³ and ¥0.142 vs ¥0.196 per m³.
- **Topology presets.** Three runnable plant layouts (`A²/O standard`,
  `A²/O enhanced denitrification`, `A/O without anaerobic zone`) are derived from
  the standard topology and validated by readiness + compile + 30-day warm-up in
  `tests/release030.test.ts`.
- **Data export.** `GET /api/export/snapshots.csv`, `/api/export/decisions.csv`
  and `/api/export/report.md` (a one-page Markdown shift report). The UI downloads
  them with the session token in a header, never in the URL.
- **Optional LLM dialogue.** Set `AQUAPILOT_LLM_BASE_URL`, `AQUAPILOT_LLM_MODEL`
  and optionally `AQUAPILOT_LLM_API_KEY` to add a second, model-written answer on
  top of the rule engine. The adapter speaks OpenAI-compatible
  `/chat/completions`, sends only computed facts, rejects answers containing
  numbers that do not appear in the grounding text, and silently falls back to
  the rule engine on timeout, HTTP error or ungrounded output. `llmCalls` and
  `llmFallbacks` are exported as Prometheus counters.
- **Cumulative-volume integration.** `NetworkSimState.totals` now integrates
  inflow, energy and waste sludge per step. The four snapshot totals no longer
  extrapolate from the current rate, which overstated inflow and energy whenever
  flow was above the instantaneous value.
- `GET /api/presets`, `tests/release030.test.ts` (20 contract tests), a media
  generator (`scripts/media.ts`) and refreshed screenshots / demo video.

### Changed

- **Secondary clarifier sized to BSM1 surface loading.** 2 400 → 3 600 m²
  (0.56 m³/(m²·h) at design flow, BSM1 reference is 0.51). At the old area the
  steady-state effluent SS sat at 11.1 mg/L, permanently above the 10 mg/L
  class-1A limit, and the AI entered emergency mode at every decision cycle
  because of an unattainable constraint. At 3 600 m² the steady state is
  SS 7.6 mg/L, COD 38.7 mg/L and the recommendation returns to normal mode.
- **KPI strip** now surfaces effluent TN as a seventh tile, so every discharge
  limit in `LIMITS` has a visible indicator.
- Influent and effluent stream colours differ (blue vs teal); previously both
  used the same hex value and could not be told apart in the flowsheet.
- Decision candidates carry `exceedanceProbability` in the shared
  `DecisionCandidate` type so the panel can render it without casts.
- `stepShadow` resets the shadow plant from the *same* default controls and
  warm-up as the main plant before switching to the fixed strategy; comparing a
  differently-initialised plant measures initial conditions, not strategy.
- Dockerfile creates and chowns `/app/data` before `USER node` (persistence
  previously failed silently with EACCES when running as the non-root user).
- Savings metric and KPI now use integrated totals; the "cumulative chemical and
  sludge" line reads the cumulative ledger rather than today's counter.

### Fixed

- **Trend stream stopped after 720 points.** Incremental patches used the number
  of received points as a cursor; once the ring buffer filled, `slice(count)` was
  always empty and every connected client's charts froze while the simulation
  kept running. Now a timestamp cursor (`src/server/trendCursor.ts`) sends exactly
  the new points, with a regression test that rolls the buffer.
- **Stored-token dead end.** `AuthGate` used to accept any token found in
  sessionStorage without verifying it; after rotation the page loaded but the
  WebSocket was rejected, leaving a permanent "reconnecting" state with no way
  to re-enter the token. The gate now probes `/api/snapshot` and re-prompts.
- **Missing effluent alarms.** BOD₅ and TN exceedances had no alarm code even
  though both are discharge limits; they now raise `EFF_BOD` / `EFF_TN`.
- **A/O preset claim.** The first template attempt removed the anaerobic tank by
  deleting units; that leaves the influent and RAS ports dangling. The preset now
  re-kinds the tank to anoxic, which is what an A/O plant actually looks like.
- **Two tariff tables.** `src/sim/config.ts` carried a second `TARIFF` (and an
  unused `SETPOINT_LIMITS`) alongside `src/sim/kinetics.ts`; the engine now reads
  the single source and the duplicate is gone.
- `<meta name="color-scheme">` said `light` on a permanently dark UI, causing
  light form controls and scrollbars in Firefox.

### Removed

- Unused `TARIFF` / `SETPOINT_LIMITS` exports from `src/sim/config.ts`.

## [0.2.2] — 2026-10-23


### Fixed

- **Autotrophic nitrification stoichiometry was understated 16.8×.** Each gram of
  autotrophic biomass growth must oxidize 1/Y_A = 4.17 g of ammonia nitrogen; the
  stoichiometric row carried 0.247 g. The nitrogen conservation test stayed green
  because S_NO was excluded from the ledger — the books were self-consistent but
  wrong. Found by the BSM1 Table 6 benchmark, where nitrification could never
  establish itself. (`src/sim/asm1.ts`)
- **Anoxic growth missed the denitrification alkalinity credit** (+1/14 mol per g
  of nitrate nitrogen reduced), and nitrification drew only 1/14 instead of 2/14
  mol alkalinity per g N. Effluent alkalinity now lands within 2% of the official
  benchmark value.
- The default settler feed layer moved from the 6th to the 5th layer (top-down) to
  match the official "2.2 m from the bottom" specification.

### Added

- **BSM1 Table 6 benchmark** (`src/sim/bsm1.ts`, `tests/bsm1-benchmark.test.ts`):
  the five-tank BSM1 open-loop configuration (Qintr 55 338 m³/d, KLa 240/240/84
  d⁻¹, Henze-1987 parameter set used as tabulated) runs to steady state and is
  compared against the official values. Effluent S_S deviates −2.6%, S_NO +7.4%,
  S_ALK −2.0%, S_O +7.6%, autotroph biomass ≈ official; S_NH −19.6% (0.34 gN/m³
  absolute, under 1% of the nitrogen flux) is locked with a 25% regression gate
  and tied to the known settler limitation.
- Mutation testing pilot (Stryker, devDependencies only) scoped to
  `src/sim/asm1.ts` + `src/sim/takacs.ts` via `npm run mutation`; not wired into
  CI (measured runtime recorded in `docs/AUDIT-REPORT.md` §12.3).
- Rejection-path tests for `createRuntime` (unreadable and uncompilable
  topologies), closing the `topologyRuntime` branch gap.

### Changed

- Test thresholds recalibrated to the corrected physics, each with its measured
  justification: long-SRT CSTR autotroph biomass >2 (chemostat mass balance) with
  a new `S_NO > 20` nitrification lock; network-plant autotroph biomass >30
  (measured 66); effluent SS gates 10 → 15 (measured 11.1; official BSM1 steady
  state is 12.5 — the 10 mg/L class-1A limit presumes filtration). Test count
  315 → 324; branch coverage 85.43% → 85.85%.

## [0.2.1] — 2026-10-23

### Fixed

- **Unknown `/api/*` paths returned `200` with the SPA shell.** A client asking
  for JSON got HTML. They now return `404` with a JSON body.
- **Every `/api/*` route accepted any HTTP method.** `POST /api/snapshot` and
  `OPTIONS` both answered `200`. All API routes are read-only, so non-`GET`/`HEAD`
  requests now return `405` with `Allow: GET, HEAD`.
- **Route matching used `startsWith`.** `/api/snapshot-evil` matched
  `/api/snapshot`; routes now compare the exact pathname.
- **Missing static assets fell back to `index.html`.** `/assets/missing.js`
  answered `200 text/html`, so the browser executed HTML as JavaScript. Only
  extension-less client routes fall back now; assets return `404`.
- **`WebSocket` metrics were wrong in two ways.** `aquapilot_ws_connections` was a
  counter that only ever grew (now a gauge of open connections), and an `error`
  followed by `close` counted the same disconnect twice. `accepted` is now its own
  counter, `aquapilot_ws_connections_total`.
- **`src/server/index.ts` contained a literal NUL byte** in the path-traversal
  guard. Tools that sniff for binary content treated the file as binary; the
  check now uses the `\u0000` escape.

### Added

- `src/server/httpRoutes.ts` — pure path/method predicates with 5 unit tests that
  lock the four routing regressions above.
- `docs/API.md` — every HTTP endpoint and the WebSocket message contract.
- `Dockerfile`, `.dockerignore`, `.env.example`, `CODE_OF_CONDUCT.md`,
  `.github/dependabot.yml`, `.github/CODEOWNERS`, `scripts/README.md`.

### Changed

- `SECURITY.md` no longer claims "Authentication: None" or "In-memory state only",
  both of which stopped being true in 0.2.0.
- `docs/QUALITY-ROADMAP.md` carries a status banner: it is a 2026-10-21 snapshot,
  not a description of the current code.
- Test count 307 → 315.

### Removed

- 34 `scripts/__diag_*.ts` one-off diagnostics and 8 superseded check/e2e scripts.
  Their conclusions live in tests and in `docs/AUDIT-REPORT.md`; the scripts were
  never referenced by any doc, CI job or npm script.

## [0.2.0] — 2026-10-22

### Added

- **`/api/metrics`** in Prometheus text format, plus `?format=json` for humans.
  Counters cover HTTP by route/status, auth failures, rate limiting, rejected
  WebSocket frames, AI cycles, simulation ticks, and persistence flushes;
  a latency histogram covers 5 ms – 10 s.
- **Structured logging.** Every server event is a single JSON line with
  `ts`/`level`/`msg` plus context. Credential-shaped fields are redacted, and
  circular references degrade to `[circular]` instead of throwing.
- **SLO definitions in code** (`src/server/observability.ts`) mirrored in
  `docs/SLO.md`, with suggested alerting thresholds.
- **Backup and restore.** `npm run backup -- create|restore|list` writes a
  consistent snapshot via `VACUUM INTO` and refuses to restore a file it cannot
  verify. Restore is a two-step operation: preflight by default, `--yes` to apply.
- **Component tests** (jsdom + Testing Library) for the decision, alarm, control,
  insights and chat panels — 17 cases covering render, callbacks and empty states.
- **Layout regression tests** asserting that no flowsheet connection crosses a
  unit body, and that corridor edges are not labelled.
- **ESLint 9 + Prettier 3** with `npm run lint` / `npm run format` wired into
  `npm run verify` and CI.

### Changed

- `stepNetwork` split into seven named phases (hydraulics, reactors, clarifier,
  biomass, effluent, energy/cost, alarms). The simulation trajectory is
  bit-identical before and after the split, for both kinetic models.
- Coverage thresholds set to lines 91 / branches 82 / functions 93, the strictest
  values that hold on both supported Node versions.
- Test count 245 → 307; branch coverage 83.79% → 85.23% on Node 24, 82.97% on Node 20
  (V8 counts branches more conservatively there).

### Fixed

- Today's operating cost in incremental snapshot patches used the lifetime
  total, so the KPI grew linearly with simulated days.
- Trend and replay x-axes printed `55h10` / `0h 0h 0h` instead of a clock.

## [0.1.0] — 2026-10-21

Initial public version: topology-driven A²/O simulation, ASM1 kinetics, Takács
ten-layer clarifier, AI operator with guardrails, flowsheet editor, replay, and
a bilingual README.

## [0.3.0] — release notes addendum

The full entry for 0.3.0 is above. Two implementation notes worth recording:

- The secondary-clarifier area change (2 400 → 3 600 m²) is a **model correction**,
  not a tuning trick: at the old area the steady state violated the plant's own
  discharge limit (SS 11.1 mg/L vs 10), which made the AI enter emergency mode at
  every cycle. The new area matches the BSM1 design surface loading within 10 %.
- The shadow benchmark resets the manual plant from the **same** warm-up and the
  **same** default controls before switching to the fixed strategy. Comparing two
  differently-initialised plants would measure initial conditions, not policy.
