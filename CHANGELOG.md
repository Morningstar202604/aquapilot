# Changelog

All notable changes to AquaPilot are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0] — 2026-11-04

Closes out the v0.6.0 roadmap: the remaining reference-project lessons
land, and the AI now sees the plant the way an engineer draws it.

### Added

- **Per-kind tank sparklines**: aerobic reactors draw DO (teal), anoxic/
  anaerobic reactors draw NH4 (amber) — each tank shows the variable its
  operator actually watches. History buffer carries do/mlss/nh.
- **Flow-aware pipe pulses**: recycle, WAS, air and chemical line
  animation speed derives from the live setpoints (raise internal
  recycle and that line visibly speeds up), clamped 0.9-4 s.
- **Inspector upgrades (editor)**: per-unit validation issues render
  inline in the property panel; volume/area inputs warn on impossible
  values while typing; one-click duplicate unit (no connections copied).
- **Structured P&ID grounding for the AI**: the chat grounding now
  includes a compact three-line P&ID summary (train order, unit list
  with volumes, recycle links, <1200 chars). FALCON 2025 found
  structured graph representations beat natural-language plant
  descriptions for LLM context (docs/REFERENCE-LEARNING.md R3).

### Changed

- 1209 tests (+1 P&ID summary gate).

## [0.6.0] — 2026-11-04

Ecosystem release: the simulator becomes a tool the whole agent ecosystem
can call (MCP), leaves the browser (CLI), and leaves the terminal (a
standalone exe) — plus the two research documents that grounded those
choices.

### Added

- **MCP server** (`POST /mcp`, protocol 2025-06-18, conservative no-SSE):
  ten tools — plant_state, set_control, list_scenarios, start_scenario,
  clear_scenario, reset_sim, apply_recommendation, simulate_headless,
  get_report, get_metrics — with JSON-Schema inputs, readOnlyHint
  annotations, structuredContent, `isError`-style business errors and
  JSON-RPC -32602 for unknown tools. Tiered token auth (viewer reads,
  operator writes), Origin allow-list and a 60 req/min/IP limiter.
  LangGraph / OpenAI Agents SDK / CrewAI / Vercel AI SDK / Mastra connect
  with just the URL. 18 protocol tests; live-verified initialize, storm
  what-if and the 405/403 edges.
- **`aquapilot` CLI**: simulate (days/scenario/controls/CSV export with a
  GB-18918 compliance summary), report (Markdown), bench (BSM1 Table 6
  gates, same thresholds as the regression test), calibrate
  (identifiability + coordinate descent), serve (full stack). Ships as
  `bin` in package.json and a bundled `dist/cli.mjs`.
- **Standalone exe**: `npm run exe` → `dist/aquapilot.exe` (~84 MB, Node
  SEA + postject). No Node installation needed; `simulate` verified.
- **Research docs**: docs/AGENT-HARNESS.md (MCP/A2A/AG-UI landscape and
  what shipped) and docs/REFERENCE-LEARNING.md (14 peer open-source
  projects studied and where each lesson landed).

### Changed

- README: architecture diagram, three ways to run (npm / exe / CLI),
  refreshed counts (1208 tests).

## [0.5.2] — 2026-11-03

A full-code-review release: four parallel review passes read every source file
(~29k lines), and the findings ship here — client data-integrity, server
robustness, AI decision-chain correctness, and the switch to a light default
theme.

### Added

- **Light theme by default.** The UI shipped dark-only; it is now light
  (`color-scheme: light`, page background `#f2f6f5`) with the brand teal
  deepened to hold WCAG AA on white. Canvas, charts, stream colors, crash
  screens and overlays all follow. Verified with real-browser screenshots
  across nine views.
- **Feedback surfaces**: AI chat shows a typing indicator while an answer is
  in flight; 「重新推演」 disables its button until the next decision frame
  arrives; ReplayPanel reports network failures as network failures instead of
  claiming persistence is disabled.

### Fixed

- **Client**: a snapshot patch without a full `controls` object used to blank
  `snap.controls` and crash the control panels; LLM/agent-config responses are
  now filtered by the latest requestId so stale replies can't overwrite newer
  ones; discarded frames, non-JSON WS frames and socket errors leave console
  traces; `margins[0]` is guarded; ErrorBoundary now wraps every side panel
  (a panel crash no longer takes the whole app down).
- **Server**: reset / preset / topology apply no longer leak the manual-override
  window, alarm dedup set or forecast cache into the new run (a leftover
  override window muted the AI for an entire run); topology persistence failures
  are reported to the client instead of pretending success; an
  `unhandledRejection` handler keeps void-async crashes from killing the
  process; the SQLite flush self-recovers from a poisoned transaction;
  `httpErrors` no longer double-counts 500s; LLM strict-retry failures report
  the retry's real reason; estimator noise is independent per state dimension.
- **AI / model**: `candidateLabel` misread the magnitude digit, so every
  candidate was labelled 「（大幅）」 — alternative dedup silently dropped
  small-step moves and robust ensembles collided by label; cycle detection no
  longer trusts the client-controlled `recycle` flag (it was an escape hatch
  past the CYCLE check into a solver crash); a what-if with an all-NaN forecast
  reports divergence instead of "stays within limits"; `reasoning_effort` is no
  longer sent with `off` on OpenAI-compatible endpoints; a non-numeric
  `AQUAPILOT_LLM_TIMEOUT_MS` falls back to the default instead of failing every
  call as "timeout".

### Changed

- 1189 tests (+30), all green in CI; `solveReactors` complexity 66 → 21
  (v0.5.1) with bit-identical benchmark numbers.



## [0.5.1] — 2026-11-03

A quality-and-closure release: every quantified item still open in the audit's
red-line table gets either resolved, measured, or honestly backfilled, and the
first of the UI-architecture backlog items (port snap) ships.

### Fixed

- **`calibrateAsync` ignored the caller's target during fitting.** `evaluate()`
  hardcoded `bsm1SyntheticTarget()`, so identifiability screening ran against the
  target the caller passed while coordinate descent optimised a different one.
  Harmless today because the only call site passes the synthetic target — but the
  signature promised otherwise. `evaluate` now takes the target explicitly; both
  phases optimise the same objective, as the sync `calibrate()` already did.

### Added

- **Port snap + highlight during drag-to-connect** (`PlantCanvas`). While dragging
  from an outlet, the nearest inlet port within 16 sheet-px becomes the snap
  target: the port highlights (`data-snap='true'`), the rubber band sticks to its
  anchor, and release connects to it — `elementFromPoint` hit-testing is now only
  the fallback. Connecting to the source unit's own inlet is excluded, matching
  the click-path rule. UI-architecture backlog §8 item "拖近端口时自动吸附高亮"
  is therefore done.
- **Branch-coverage batch** (+16 tests): `calibrationService` guard/cancel/concurrency
  branches (`run`/`identify`/`calibrateAsync`), ADM1 edge branches (default params,
  non-finite clamping, zero-gas fraction, `emptyAdm1State`), snapshot forecast &
  recommendation paths. Total branch coverage 81.70 % → **82.68 %**; line 94.63 %,
  statements 92.89 %, functions 96.54 % (1175 tests).

### Changed

- **`solveReactors` refactor** (topology engine): inflow composition and ASM1
  inflow aggregation extracted into pure helpers (`aggregateInflow`,
  `aggregateAsm1Inflow`). ESLint cyclomatic complexity 66 → 21; the function
  shrinks by ~190 lines. BSM1 Table 6 comparison and all network tests are
  bit-identical — verified before and after.
- `docs/BENCHMARKS.md` gains a mutation-testing baseline section (28.07 %,
  measured 2026-10-23, deliberately not in CI).

### Docs

- `docs/AUDIT-REPORT.md` §九: the red-line table was left contradicting later
  sections of the same file. A dated backfill now records what happened to each
  row: topologyRuntime branch gap closed (100 %), `solveReactors` refactored,
  mutation score measured instead of "未测".
- `docs/UI-ARCHITECTURE.md`: the closing sentence still claimed topology-driven
  solving "排在路线图第一位" while the same file's header said it was done.
  Removed; the remaining UI backlog is now listed explicitly.

## [0.5.0] — 2026-11-02

This release turns the prototype into an auditable operations tool: the model can be
calibrated against measurements, the state can be estimated from noisy signals, the
plant can be edited as a flowsheet, and every AI action is now bounded by guards that
report honestly when they block a move.

### Added

- **Model registry with per-process conservation checking** (`src/sim/modelRegistry.ts`).
  ASM1, ASM2d and ADM1 are described as data (components / processes / stoichiometry /
  conservation weights), so adding a model no longer means copying a solver and a
  conservation test. The checker returns residuals per process rather than a boolean, and
  keeps an explicit `exempt` list for rows that physically must not close (nitrification COD
  comes from inorganic carbon; denitrification nitrogen leaves as N₂; ammonification moves
  nitrogen only). Deliberately faking those closed would hide real coefficient errors.
- **ASM2d** (`src/sim/asm2d.ts`): 19 components / 19 processes including biological and
  anoxic phosphorus removal. The conservation checker found and fixed nine real coefficient
  errors during construction (PAO growth consumed 1 g PHA instead of 1/Y_PAO; autotroph COD
  origin; hydrolysis nitrogen split; lysis nitrogen release). Behaviour is verified by
  direction: anaerobic storage raises S_PO4, subsequent aerobic operation lowers it relative
  to the anaerobic state; 240 steps stay non-negative and finite.
- **ADM1** (`src/sim/adm1.ts`): 27 components / 15 processes (disintegration, three
  hydrolysis steps, seven uptake/methanogenesis steps, decay, gas transfer). Explicit Euler
  with hydraulic mixing, pH and inhibition diagnostics; 2000 steps stay non-negative and
  finite. It is a standalone unit — not wired into the water train, because it has not been
  validated against the full BSM2 flowsheet.
- **Data-source adapters** (`src/sim/dataSources.ts`): one contract (`read` / `status` /
  `close`) with simulator and CSV replay implemented, and MQTT / OPC UA declaring themselves
  unavailable instead of returning fabricated values. A chain degrades simulator ← CSV ←
  live and records which source is actually driving the screen.
- `GET /api/models`: the registry plus data-source capabilities, with `active` / `inRuntime`
  separated so "implemented" is never mistaken for "enabled".

- **Parameter calibration** (`calibration/identify|start|cancel` over WebSocket, 「校准」 tab).
  Identifiability by central differences, then bounded coordinate descent over the
  physics-constrained parameter ranges. Measured: 10 of 11 ASM1 kinetic parameters are
  identifiable from effluent data (`mu_A` 22.2, `b_A` 10.6, `K_O_A` 6.2 are the most
  sensitive); a full run improves the objective by 71.1%.
- **State estimation** (diagonal EKF, `AQUAPILOT_ESTIMATOR=1`). Six-state estimator with
  observability reporting; converges from ±30–100% initial error to RMSE below sensor noise.
  Both peer projects that have this (PyADM1ODE) use UKF/ensembles — diagonal EKF is the
  right size for six states, and the reasoning is recorded in the module.
- **Real influent series** (`influent/load|apply|clear`). CSV with linear interpolation and
  wrapping, so a 24-hour profile can drive any duration. Parsing keeps raw values; clamping
  happens at sampling time so the quality report can still see bad inputs.
- **Influent data-quality checks** (range / spike / stuck-sensor / gap). Error-level issues
  block application rather than letting the engine silently clamp 99999 m³/h into 5200.
- **Unified unit conversions** (`src/sim/units.ts`). `1.42` was hardcoded in five places;
  a single change would have split the COD accounting silently.
- `docs/COMPETITIVE-SOURCE-ANALYSIS.md`: source-level comparison (file trees read, key
  source files decoded) against seven peer projects.

### Changed

- `src/server/index.ts` split from 2556 into 1731 lines across six single-purpose
  modules: `staticFiles`, `queryBounds`, `snapshotView`, `llmChat`,
  `agentConfigHandler`, `rateLimit`.
- WebSocket message validation moved from hand-written checks to a `valibot`
  schema. Three real gaps closed: `scenario.kind`, `sim.action` and
  `llmConfig.protocol` previously accepted any value.

### Fixed

- **Guard-blocked AI moves were logged as executed.** When the step limiter or the
  allowed-controls whitelist clamped every target back to the current value, the
  recommendation kept `action: emergency` and the original summary. The server then
  broadcast 「AI 已执行：预测到 出水超标风险，立即执行应急调节：」 — with an empty
  payload after the colon — every 65 seconds, while the controls never changed. An
  operator reading that log would conclude the risk had been handled. The guard
  pipeline now lives in `src/server/aiGuard.ts` and degrades the action to `hold`
  with a summary that names what blocked it. `severity` is deliberately preserved,
  so the risk stays visible in alarms and scoring.
- **Runtime state directories were shadowing tracked reference data.** The
  `.gitignore` rule `data/` (intended for the server's SQLite directory) also matched
  `src/sim/data/`, so the IWA BSM2 reference CSVs were never committed even though
  `docs/COMPETITIVE-SOURCE-ANALYSIS.md` said they were "on disk". Rules are now
  anchored to the repository root (`/data/`, `/dist/`, `/out/`, `/coverage/`).
- **The built-in BSM2 influent was invented, not measured.** `bsm2ConstantSeries()`
  returned COD 300 / NH 31.6 / SS 171 / T 15 °C and described them as "converted from
  ASM1 components". The official 22-column vector gives COD 592.53 / NH 23.86 /
  TSS 380.34 / T 14.858 °C, and the flow used BSM1's 18 446 m³/d rather than BSM2's
  20 648 m³/d (860.35 m³/h). The series is now parsed from the upstream file, with a
  test asserting the inlined constant is byte-identical to the CSV on disk.
- **Buttons were stretched to full panel height.** `.btn` carried `flex: 1`
  (`1 1 0%`), which is fine in a horizontal row but grows vertically inside a
  `flex-direction: column` side panel. The 「开始分析」 button measured 48 × 729 px
  with its label pinned to the top. `.btn` is now `flex: 0 0 auto`; horizontal groups
  that genuinely need equal widths declare it explicitly.
- **"No alarms" was presented as "all clear".** The alarms panel printed
  「全部受控指标在限值内」 whenever no alarm had fired, while the health score directly
  above read 69 / 需要关注 — alarms only fire on limit breaches, whereas health is a
  continuous score that also drops on thin margins. The empty state now says what it
  actually means and names the health score when it is not good.
- **Two different numbers were both called "daily cost".** The top bar shows
  day-to-date cost (`costToday`, reset at midnight); the insights panel showed
  `cumulative cost ÷ elapsed hours × 24`. Side by side they read as a contradiction
  (809 元 vs 9.2 千元). The extrapolated figure is now 「折算日成本」 and the panel
  states the difference.
- **AI-vs-baseline deltas were rounded away.** Per-m³ energy was shown to three
  decimals, so a real difference between the two chains (0.1638 vs 0.1610 kWh/m³)
  rendered as `0.170 / 0.170 / +0.0` — indistinguishable from "the shadow run never
  started". Precision raised to four decimals with the relative change alongside.
- **The mass-balance audit labelled a delta as a stock.** 「系统内库存」 displayed
  `−0.4 t` when biomass decreased over the period, which reads as negative inventory.
  The row is now 「系统内库存变化」 with an explicit sign.
- **The onboarding tour pointed at tabs that do not exist.** It named 趋势分析,
  工艺编辑, 模型设置 and Agent 设置 (none are side tabs) and omitted 告警, 效益, 校准,
  进水 and 自检 (all are). Steps were rewritten against the real 10-tab layout,
  exported as `ONBOARDING_STEPS`, and a test cross-checks every tab name against
  `App.tsx` so the two lists cannot drift again.
- **Local browser smoke no longer depends on a managed Playwright download.** `npm run e2e` uses an existing Edge/Chromium executable when `AQUAPILOT_BROWSER_PATH` is set (or when a standard system path is found), while CI still installs and uses the managed Chromium binary by default. Browser resources are closed during cleanup.
- **Public fetches now pin DNS validation to the selected address.** Skill imports and webhook targets reject private DNS answers, IPv4-mapped private addresses, redirects, and oversized response bodies before the result is stored or returned.
- **HTTP query tokens are no longer accepted outside `/ws`.** API clients must use the `Authorization` header; WebSocket clients should use the subprotocol.
- **Connections ended nowhere.** 8 of 23 flowsheet edges stopped at a node's
  horizontal/vertical centre or at the top edge instead of the port dot the user
  sees (cross-layer sludge, aeration, chemical and storm-bypass lines). In the
  editor they read as broken wires, and the reported flow pointed at the wrong
  place. Cross-layer routes now climb in the gutter between units and terminate
  on the declared port anchor; a test asserts all 23 edges start and end on their
  anchors within 0.75 px (`tests/auditPolish.test.ts`).
- **Compact-mode titles overlapped their neighbours.** 「污泥浓缩池」 at 24 px
  ran into 「脱水机房」 in the all-in-view mode. Titles are now fitted to the
  node width (24 → 16 px, then ellipsis), the icon is dropped in compact mode to
  free 14 px, and the MLSS sub-line got a compact size so it stays readable at
  60 % zoom instead of shrinking to 7 px.
- **Top bar clipped its own controls.** At 1440/1600 px the row is 1553 px wide:
  the brand was pushed off-screen to −101 px and the right-most link pill was
  cut. The e2e guard only measured value heights, so it stayed green. The bar now
  drops the duplicated 处理规模 / 执行标准 fields below 1600 px and tightens gaps
  below 1400 px; `scripts/e2e-ci.ts` measures real geometry at six widths.
- **Side tab label wrapped.** 「控制与工况」 broke into two lines in the 372 px
  rail, misaligning all tabs. Tabs are now nowrap at 10.5 px, asserted by e2e.
- **The AI nudged the plant every cycle.** Closed-loop runs showed 1–2 point
  "adjustments" every 15 minutes with the internal recycle oscillating between
  0.8 and 1.6×Q. A `AI_HOLD_DEADBAND = 18` score deadband now holds when the best
  candidate is not materially better; critical risks always pass. 24 h closed-loop
  measurement: 24 actions / 72 holds versus 34 / 14 before, with TN staying inside
  limits (10.7–14.2 mg/L).
- **Forecast fan and AI-vs-fixed panel froze at connection time.** Both fields
  only existed in full snapshots, so the trend fan and the shadow comparison never
  advanced. They now travel in every `snapshotPatch` and are merged client-side.
- **Toasts never disappeared.** The notice stack appended forever, covering the
  chart corner with stale 「AI 已执行」 rows. Notices are now capped at three and
  expire after 12 s (`src/client/hooks/notices.ts`).
- **The 重新推演 button could stall the tick loop.** Each click runs a ~200 ms
  synchronous forecast burst with no throttle. It is now rate-limited to one call
  per 2 s per socket with an explicit warning.
- **Static assets were re-downloaded on every visit.** The server sent neither
  `ETag` nor `Content-Encoding`: 901 kB of JS on each navigation. Text payloads now
  gzip to 290 kB, hashed `/assets/*` are cached for a year, `index.html` stays
  `no-cache`, and conditional requests return `304`.
- **Two routes were missing from the metrics label set.** `/api/topology/history`
  and `/api/history/alarms` were folded into `__unmatched__`, so their traffic was
  invisible in Prometheus.

### Fixed — model accuracy

- **Secondary clarifier was over-estimating settling efficiency by 31%.** The Takács
  velocity law was missing the non-settling fraction `f_ns`: the reference implementation
  computes `v0·(exp(−rh·(X − f_ns·X_feed)) − exp(−rp·(X − f_ns·X_feed)))`, we used
  `v0·(exp(−rh·X) − exp(−rp·X))`. BSM1 steady-state TSS went from 8.14 mg/L to
  12.33 mg/L against the IWA reference of 11.73 — the deviation dropped from −31% to +5.1%.
  The limiting-flux threshold `X_t` was added at the same time.
  **This was invisible because the BSM1 benchmark only checked soluble components**
  (`S_S`, `S_NO`, `S_NH`) and never TSS — the one quantity `f_ns` affects. A TSS
  assertion was added.
- Knock-on design corrections (physics, not tuning): clarifier area 3600 → 4000 m²
  (surface load 0.56 → 0.50 m³/(m²·h), matching BSM1's 0.51), aerobic volume
  5000 → 5750 m³ per tank (+15% HRT).
- Three test assertions were rewritten from absolute thresholds to relative criteria
  (blower failure: "≥2× worsening and >80% of limit" instead of "must exceed"; denitrification:
  "anoxic NO₃ < 60% of aerobic end" instead of "< 4"; clarifier scaling: relative to baseline).
  Absolute thresholds drift with plant sizing; the relative relations are the real evidence.

- **Run-time analysis surface** (`analysis/run` over WebSocket, new 「分析」 tab).
  Three capabilities no peer project in the domain offers in one place:
  parameter sensitivity by central differences (which knob actually moves the
  compliance margin), a Pareto frontier over compliance vs operating cost (the
  trade-off a single weighted score hides), and a plant-wide COD mass-balance
  audit (does the accumulated bookkeeping close). All three run on the same model
  the controller uses, so analysis and control cannot drift apart.
  The mass audit accounts for all four COD destinations — effluent, waste sludge,
  **aeration oxidation** and **in-system inventory**. Missing either of the last
  two produces a fake 30–90% "leak": oxidation is the single largest sink in an
  aerobic plant, and the biomass inventory is a large temporary store. ASM1 runs
  are labelled `approximate` (±20%) because its three sampling points use
  different bases; claiming strict closure there would be over-claiming.
- **Three-role access control**: `viewer` / `operator` / `admin` via
  `AQUAPILOT_VIEWER_TOKEN` / `AQUAPILOT_OPERATOR_TOKEN` / `AQUAPILOT_TOKEN`.
  A wall display can watch without being able to change setpoints. Single-token
  deployments keep working unchanged.
- `docs/COMPETITIVE-ANALYSIS.md`: verified comparison against seven peer projects
  (`bsm2-python`, QSDsan, PooPyLab, PyADM1ODE, Junction-2025, wwtw-digital-twin,
  wwtmodels/Activated-Sludge-Models), including an explicit list of what
  AquaPilot does *not* do.

### Performance

- Client bundle split by vendor + lazy-loaded chart/settings panels: first-load JS
  went from 906.56 kB (gzip 294.12) to 133.15 kB (gzip 40.90) for the entry chunk,
  with ECharts fetched only when the trends panel scrolls into view.
- Static asset gzip results are cached by (path, mtime) instead of recompressed on
  every request.
- Incremental snapshots are built once per frame and shared across clients
  (20 clients: 0.497 → 0.295 ms/frame, −40.7%). A per-frame memo keyed on control
  values was tried and **reverted**: building the key cost more than recomputing
  (derived metrics total 6.3 µs).

### Security

- **Stored LLM API keys could be exfiltrated.** `llmConfig` `discover`/`test`
  accepted an arbitrary `baseUrl` while resolving an empty `apiKey` to the saved
  secret. The current local working tree also binds key reuse on `save` to the saved
  origin (scheme, host and port); changing origin requires re-entering the key.
- **Outbound response and address handling.** The current local working tree asks
  for identity encoding, decodes forced gzip, x-gzip, deflate and br responses,
  rejects unsupported or stacked encodings on responses with a body, and enforces response size limits
  before and after decoding. The local-use NAT64 prefix `64:ff9b:1::/48` is
  rejected even for embedded public IPv4 addresses; custom NAT64 prefixes still
  require network-level restrictions.
- **Skill import was a readable SSRF.** `agentConfig/importSkill` fetched any URL
  server-side (private networks included) and stored the body in the skill, which
  `agentConfig/get` returned verbatim. Fetching now uses a strict public-only
  guard and refuses redirects. Webhook hooks use the same guard.
- **Single malformed request could kill the process.** Query strings were parsed
  against a client-controlled `Host` header (`new URL` throws on `Host: a b`), and
  non-integer `?limit=` reached SQLite as a `LIMIT ?` binding (`datatype
  mismatch`). Both raised outside any try/catch. Query parsing no longer touches
  `Host`, every HTTP handler is wrapped, and LIMIT values are truncated.
- **Permission model allowed self-escalation.** One `save` could switch
  `permission` to `open` and add a webhook hook in the same payload; open-only
  capabilities now take effect from the next save.
- **SSRF guard bypasses.** IPv4-mapped IPv6 (`[::ffff:169.254.169.254]`),
  trailing-dot hosts (`metadata.google.internal.`), AWS IMDS IPv6 and redirect
  follow-ups are now rejected; LLM response-body reads are covered by the same
  timeout as the request head.
- `qs` (transitive via Stryker) updated; `npm audit` reports zero findings.
- **0.25× and 0.5× speeds were fake.** `Math.round(SIM_MINUTES_PER_TICK * speed)`
  turned a 0.5-minute step into a full minute, so low speeds ran exactly like 1×.
  Fractional accumulated minutes are carried between frames.
- **A critical forecast could be reported as "stable".** `actionFor` checked the
  deadband before severity, so a predicted exceedance with no control delta was
  downgraded to `hold`. Critical now always wins, and non-finite model output
  produces an explicit "prediction invalid" state instead of NaN advice.
- **"Hold" was scored on guard-clamped controls**, so `chosens.controls` could
  differ from what the operator actually had set.
- **Topology validation gaps.** Non-recycle cycles passed validation and then
  crashed the solver with an empty-reference `TypeError`; connections were not
  required to run out→in, nor to match the source port's stream. Volumes above
  engineering scale (1e308) overflowed derived values to Infinity, duplicate
  train ids doubled plant volume, and the layout produced `-Infinity` coordinates
  when no main-line unit existed.
- **Incremental snapshots were barely validated.** `effluent: {}` passed the
  three-field check and crashed the page; `tanks` were merged by id so added or
  removed units never appeared; influent quality froze at connect time. Patches
  now get field-level validation and tank sets follow the patch.
- **WebSocket token subprotocol broke reconnects.** Base64 tokens contain
  `=`/`+`/`/`, which are illegal in `Sec-WebSocket-Protocol`; `new WebSocket`
  threw outside any handler and the reconnect chain died. Tokens now travel
  base64url-encoded under `token.b64.`.
- **Slider drags flooded the control channel.** A range input fires ~60 Hz; the
  server allows one control change per 500 ms, so nearly every event was rejected
  with a notice and the final value could be dropped. Sliders are throttled with a
  trailing commit.
- **Forecast bands lingered after reset.** `setOption({notMerge:false})` kept the
  previous P10/P90/P50 series when `forecastBand` became null.
- Login probe failure no longer fails open; agent settings keep unsaved edits when
  a save fails; history replay reports 401/403 instead of "no data yet"; the
  topology editor's `dirty` flag no longer stays true forever.
- Log redaction covers `apiKey`/`accessToken`/`privateKey`; the watchdog no longer
  broadcasts an absolute config path.

## [0.4.0] — 2026-10-27

Six unbounded `[Unreleased]` blocks accumulated between v0.3.0 and this release; they are
merged here unchanged (newest first) so "what shipped in which version" is answerable again.
Minor version, not patch: the release adds user-facing capabilities (flowsheet authoring,
version history, drag-to-connect, along-train profile, custom model onboarding, Agent
settings) alongside the correctness fixes.

### Added

- **Flowsheet version history with rollback.** Each apply and each preset switch appends
  to `data/topology-history.json` (newest 20, ~18 KB each; `AQUAPILOT_TOPOLOGY_HISTORY`
  relocates it). The boot topology is seeded as v1 (`标准厂基线` / `启动恢复`) so there is
  always something to roll back to. The editor's new 版本 tab lists revision, label,
  unit and connection counts and offers a one-click 回滚. A rollback re-applies the old
  document through the same readiness validation and 30-day warm-up and records it as a
  **new** revision — `revision` only ever grows, so client caches and audit chains stay
  unambiguous. Exposed as `GET /api/topology/history` and WS
  `{ type: 'topology', action: 'history' | 'revert' }`.
- **Along-the-train profile in the unit inspector.** Selecting any main-train unit
  renders the five-stage DO / NH₄ / NO₃ walk through the train with the current unit
  highlighted, so an operator can see *where* nitrification and denitrification happen
  instead of only the selected tank. Non-train units (blower, chemical) show nothing,
  and a snapshot without live reactor state does not render an empty table
  (`src/model/trainProfile.ts`, 6 unit tests + 3 inspector tests).
- **Drag-to-connect on the flowsheet.** Dragging from an outlet dot to an inlet dot
  creates a connection with a rubber-band preview; a <6 px gesture still counts as a
  click. Both entry points share one `addConnection`, so stream inference, duplicate
  rejection and the `recycle` flag cannot drift apart. The ports now expose
  `data-unit` / `data-port` (also used by assistive tech and end-to-end tests).

- **Batch delete in the flowsheet editor.** Delete/Backspace and a toolbar
  「删除选中」 button now remove every selected unit together with all connections,
  train entries, stored positions and waypoints — in one undoable step. The earlier
  implementation deliberately deleted only the last selected unit.
- **Hand-routed connection waypoints.** In edit mode every connection shows a
  midpoint handle; dragging it pins an orthogonal waypoint stored under the
  topology's new `routes` field, further handles can be added, and a × restores the
  automatic corridor route. Waypoints survive apply/reload and are drawn as H/V
  segments only.
- **Ten-layer clarifier profile in the unit inspector.** The Takács settler layer
  concentrations are now sent in the snapshot (`clarifier.profile` +
  `feedLayer`) and rendered as ten bars with the feed layer highlighted.
- **`GET /api/history/alarms`.** Persisted alarms, newest first, optionally scoped to
  a run. The server now records an alarm row the first time each code becomes
  active, so `/api/history/stats` no longer reports a permanently empty alarms table.
- **The flowsheet now survives a restart.** Applying a topology or switching a preset
  writes the document (units, links, hand-placed positions, connection waypoints) to
  `data/topology.json` (0600, atomic rename) and the next start restores it. A damaged
  or non-runnable file falls back to the standard plant with a logged reason instead
  of silently losing the layout.

#### the flowsheet is now actually edible, like a process simulator

- **Drag-and-drop authoring.** Palette items can be dragged onto the canvas (or
  clicked to add); the drop point snaps to a 14 px grid. Units already on the
  canvas can be dragged freely, and their coordinates persist in the topology's
  new `positions` field so undo/redo, save and reload all keep the layout. An
  「自动排列」 toolbar action clears manual coordinates and returns to the layered
  auto layout.
- **Visible ports and click-to-connect.** Every unit renders a dot for each port on
  its boundary (inlets on the left, outlets on the right, coloured by stream).
  Clicking an outlet then an inlet creates the connection using the _target_ port's
  stream type; duplicate links are rejected at the click rather than surfacing as a
  validation error afterwards.
- **Auto-splice for new biological tanks.** Dropping an anaerobic/anoxic/aerobic
  unit inserts it into the main train between the previous last train unit and its
  downstream node (rewriting that edge instead of adding a second one), so a new
  tank passes validation with 0 errors and the plant can be applied immediately.
- **Per-unit inspector.** Selecting any unit in the monitoring view opens a floating
  panel with its volume, live DO/MLSS/NH₄/NO₃, clarifier blanket, flowsheet degree,
  and only the controls that unit declares in `interventions` — aeration tanks show
  DO/dosing, the clarifier shows RAS/WAS — each writable through the same control
  channel as the side panel.
- **Collapsible side-panel groups.** 工艺模板 / 工艺控制变量 / 工况注入 (and the
  decision panel's candidate comparison) now collapse to one summary row that keeps
  the current DO / recirculation / PAC / active-scenario reading visible.

#### selection, alignment and unit-level polish

- **Multi-select with marquee.** Drag on empty canvas to box-select; Shift/Ctrl+click
  to add or remove. Selected units move together (one undo step), and the toolbar
  grows an align/distribute group (left/right/top/bottom, horizontal/vertical
  distribute) that works off the selection bounds.
- **Keyboard editing.** Arrow keys nudge the selected unit by one 14 px grid step
  (Shift = 5), Delete removes it together with its links, Esc clears the selection.
  An always-visible hint bar in the editor lists these bindings.
- **Port colours and labels.** Port dots now take their stream colour (influent
  blue, mixed liquor green, RAS amber, air pale blue…) and show a two-character
  stream label on hover or while connecting.
- **Unit icons.** Every unit kind has a monospace glyph in its title bar
  (≣ 格栅, ◉ 好氧, ◎ 二沉, ≋ 鼓风…), so the flowsheet reads without labels at a glance.
- **Unit inspector grows 设备参数.** The unit's `meta` (metre type, blower count,
  surface loading…) is available behind a disclosure, and the panel shows the kind
  icon plus volume/area/depth.
- **Collapsible trend strip.** The three trend charts collapse to one header row,
  handing the height back to the flowsheet (canvas 339 → 530 px at 1280×720);
  re-expanding restores all three charts without re-initialising them.
- **Settings moved into one menu.** 模型设置 and Agent 设置 collapse into a single
  top-bar 设置 dropdown that also shows the current model / persona / permission
  inline, and both configs are fetched on connect so the menu is never stale.

#### the AI operator is now configurable from UI, chat, CLI and file

- **Agent 设置 dialog (top bar, six tabs).** Persona (name/role/tone + answer length),
  prompt blocks (enable/edit/add/delete), skill library (4 built-ins + custom + URL
  import), declarative hooks, constraint engineering, and the permission matrix with
  a read-only core-protection list. A "preview composed prompt" button renders the
  exact system prompt that will be sent, including the draft — so what you see is
  what runs.
- **Chat commands.** `/命令` lists the syntax; `设置角色 首席值班长`,
  `添加技能 名称|触发词,触发词|正文`, `添加钩子 名称|事件|匹配|动作|目标`,
  `约束 允许控制 doSetpoint,pacDose`, `约束 人工确认 开`, `权限 完全放开`,
  `列出技能/钩子/提示词`, `恢复默认配置` all mutate the same store the UI uses.
  Commands are parsed before the rule engine, so a config command never returns a
  plant-status answer.
- **CLI + hot reload.** `scripts/agent-config.ts` (show / set-persona / add-skill /
  add-hook / add-prompt / set-constraint / permission / reset) writes
  `data/agent-config.json` atomically; the server watches its mtime and reloads
  without a restart. A direct file edit behaves the same way.
- **Constraints actually constrain.** `allowedControls` is enforced on manual
  control writes (the server rejects the patch with a readable reason) and on AI
  moves (out-of-scope keys are pinned to the current value); `maxStepPct` clamps
  every AI control move by the percentage of each control's _range_; and
  `requireHumanApproval` stops automatic execution while keeping the suggestion.
- **Declarative hooks.** alarm / decision / chat / config events trigger notice,
  log, skill or webhook actions with a per-key cooldown. Hooks never execute shell;
  webhooks require the `open` permission. For the current stricter public-only
  webhook guard, see the Unreleased security notes.
- **Permission matrix with a real core-protection boundary.** `readonly` blocks all
  writes, `standard` allows everything except webhook hooks and step > 30 %,
  `open` allows the rest. Effluent limits, safety guardrails, authentication,
  secrets and kinetics are outside the writable schema and stripped during
  normalization at every level, with a warning returned to the caller.
- **自检 (watchdog) panel.** The server evaluates nine deterministic checks every
  10 seconds (tick errors, clock progress, tick latency, model fallback rate,
  persistence, Agent config warnings, hook failures, config file presence, client
  connections) and broadcasts a report only when the verdict changes. Each finding
  carries an actionable next step.

#### custom model onboarding in the UI

- **模型设置 dialog (top bar).** Connecting a model is now
  a real UI flow: pick a protocol, paste a base URL (one-click presets for
  OpenAI, DeepSeek, 智谱 GLM, 通义千问, Kimi, UniSound MaaS and local Ollama),
  paste the key, and the dialog discovers the live model list from the endpoint.
  The list expands for selection with a filter field; clicking a model fills its
  id and locks in the matched capabilities.
- **Three native protocols, zero new dependencies.** `src/ai/providers.ts`
  speaks OpenAI-compatible (`/models`, `/chat/completions`), Anthropic Messages
  (`/v1/models`, `/v1/messages`) and Google Gemini
  (`/v1beta/models`, `:generateContent`). The existing `AQUAPILOT_LLM_*`
  environment variables still work as a headless fallback.
- **Automatic capability matching.** Context window, output limit and the tools /
  vision / reasoning / streaming flags come from endpoint metadata when present
  and from model-name inference otherwise. 自动 can be switched to 自定义 to
  override every value; the override is what gets saved.
- **连接测试 button.** Issues a real chat completion and reports latency plus the
  model's reply, or a readable cause (`鉴权失败（HTTP 401）…`, `端点不存在`,
  `触发限流`, `请求超时`). Reasoning models that burn a small budget on
  `reasoning_content` and return an empty `content` with `finish_reason: length`
  are retried once with a larger budget instead of being reported as failures.
- **Server-side configuration store.** `data/llm-config.json` (mode 0600) is
  hot-read on every chat turn; the browser only ever receives
  `hasKey` + `apiKeyMasked`. The current local working tree restricts empty-key
  reuse to the saved origin; see the Unreleased security notes.
  Requests travel over the existing WebSocket (`llmConfig` frames) with a
  `requestId` and an 800 ms per-socket rate limit.
- **SSRF guard on user-supplied base URLs.** Only `http(s)`, no embedded
  credentials, and cloud metadata hosts plus `169.254.0.0/16` are refused, while
  localhost and private ranges stay usable for self-hosted endpoints.

### Changed

- **Coverage thresholds re-pinned to the Node 20 measurement.** The previous gate
  (lines 91 / branches 82 / functions 93) came from an older suite; on the current one
  Node 20 measures 90.70 / 81.04 / 95.81, so the `node: [20, 22]` CI matrix would have
  failed on branches. Thresholds are now 90 / 81 / 95 — still above any real regression
  (a one-point drop fails) but valid on both runtimes.
- **One forcing module.** Diurnal flow, seasonal temperature, scenario envelope, toxic
  suppression, aeration capacity and recycle derating had up to five copies across the
  two engines. They now live in `src/sim/forcing.ts` and both the engine and the
  forecast clone call the same functions.
- **One alarm rule table.** `sim/networkEngine.raiseLimitAlarms`, the server's
  `currentAlarms` and the reference engine each had their own thresholds, severities
  and messages. All three now consume `src/sim/alarmRules.ts`; the metric strings and
  limits are identical everywhere.
- **One presentation table.** Stream colours/widths/dash/labels and unit icons/labels
  were duplicated in `PlantCanvas`, `ProcessEditor` and `UnitInspector`. They now come
  from `src/shared/streamMeta.ts`; a test fails if a component embeds a colour literal.
- **One clock formatter.** `D2 03:40` was hand-assembled in eight places (charts,
  replay, alarms, exports, report, top bar). All of them call `src/shared/time.ts`.
- **One tariff table.** The shadow benchmark hard-coded 0.68 ¥/kWh and 2.2 ¥/kg PAC;
  it now reads `TARIFF` from `kinetics.ts`, so a price change cannot silently skew the
  AI-vs-fixed comparison.
- **One plant geometry.** `PLANT.tanks` / `BIO_VOLUME` duplicated the topology's tank
  list for the reference engine; the reference geometry is now derived from
  `PLANT_TOPOLOGY`.

- **Overview canvas is denser and readable.** Node sizes, gaps and lane spacing
  were tightened (the corridor heights were retuned so no pipe crosses a unit —
  caught by the existing no-crossing test) and the auto-layout width dropped, taking
  the overview from 44 % to ~51 % at the same viewport. The authoring view now opens
  at 1:1 with scrolling instead of being squeezed to fit.

### Fixed

- **Three test entry points wrote into the developer's real `data/`.** Turning off
  `AQUAPILOT_PERSIST` only disables SQLite; the flowsheet document, its version history
  and the model/Agent configs are separate files. Measured pollution: `npm run e2e`
  clicked 「应用到仿真」 and grew `data/topology-history.json` to 66 KB with test plants,
  and `tests/topologyStore.test.ts` constructed `new TopologyStore(path)` without the
  second argument, so its default history path was the real `data/topology-history.json`.
  The E2E and media scripts now point every config path at `out/<script>-data/`, and the
  store test passes an explicit history path inside its temp dir.
- **What-if forecasts simulated the wrong severity.** The forecast clone hard-coded
  `magnitude: 1`, but the field's meaning differs per scenario: `blower_failure` uses
  it as *remaining* aeration capacity (1 = no fault) and `winter` as the target water
  temperature in °C. Consequences measured before the fix: "what if the blower fails"
  returned the baseline NH₄ bit-for-bit (0.67 vs 0.67) while the real fault drives it
  to 8.04 mg/L; winter forecast produced 8 °C instead of 12 °C. The clone now reads
  `SCENARIOS[type].defaultMagnitude`, and the scenario window is stretched to cover the
  whole forecast horizon (power outage defaults to 45 min against a 240 min forecast, so
  the last sample used to be back to normal operation).
- **`aerationCapacityOf` could amplify aeration instead of derating it.** The protocol
  allows `magnitude` 0–30 (reserved for storm/shock multipliers); feeding that into the
  blower formula produced a capacity of up to 30× (3000 % oxygen). Non-finite input
  produced `NaN` for the whole aeration factor. The value is now clamped to 0–1 and a
  non-finite magnitude falls back to the 0.5 default.
- **An injected scenario never disappeared from the UI.** `scenario` was only present in
  full snapshots, so after the window ended (and after `清除场景`) the control panel kept
  showing 「进行中 · 剩 N 分钟」 forever. The incremental patch now carries `scenario` and
  `snapshotMerge` applies it; verified in the browser: server `scenario=null` after the
  window → UI summary count returns to 0.
- **Per-tank MLSS was a disguised plant average.** The snapshot repeated one global
  `biomassKg / bioVolume` value on every reactor, so five tanks all read 2475 mg/L and
  looked like per-zone measurements. `server/tankStates.ts` now emits
  `mlssSource: 'plant-average' | 'reactor'`: in the simplified model the value is the
  plant average and the inspector labels it 「全厂均值」; in ASM1 mode each reactor's
  own particulate components (X_I+X_S+X_B_H+X_B_A+X_P)/1.42 are used, giving genuinely
  different concentrations per zone (2339/1943/1931/1924/1918 in the standard plant).
  Full snapshot and patch frames now derive tanks from the same function.
- **Port dots had no unit binding in the DOM.** End-to-end tests could only guess a
  dot's owner by render order and screen readers could not say which device a port
  belonged to; the port layer now carries `data-unit`, each dot `data-port`.
- **Slow closed-loop test exceeded the 20 s timeout under coverage instrumentation.**
  The test measures whether DO stays controlled over 48 cycles, not the ensemble; it now
  runs with `robust: false` (the ensemble adds three trajectories per candidate).

- **Per-tick derived work was recomputed 2–3×.** `buildPatch`/`buildSnapshot` called
  `currentAlarms` twice, `estimateMargin` three times and rebuilt health/attribution
  for every client. Each is now computed once per frame.
- **Prediction clones deep-copied the compiled network.** `structuredClone` cost
  0.146 ms per forecast; a shallow clone of the mutable fields costs 0.0006 ms and
  shares the read-only compiled result. Single step 0.0175 → 0.0118 ms, nominal
  decision 142.5 → 104.7 ms, robust decision 199.4 → 134.9 ms, 30-day warm-up
  495 → 390 ms.
- **Hot loop filtered and sorted the edge list every step.** `CompiledNetwork` now
  carries `incomingByReactor` / `outgoingByReactor` / `order`, built once at compile
  time.
- **Production gates ran on the retired engine.** `engine.test.ts`, `agent.test.ts`,
  `coverage-extra` and `network.test` asserted the fixed five-tank reference engine —
  a path the server no longer executes. They now run `networkEngine`, so the gates
  cover what ships.

- **`carbonDose` was a fake control.** It was only added to the chemical-cost ledger;
  0 and 60 mg/L produced bit-identical effluent (measured, four doses). External carbon
  is now injected as readily biodegradable COD into the anoxic reactor (the
  denitrification zone), which is where a real plant doses it: TN 11.44 → 9.37 mg/L
  and anoxic NO₃ 1.28 → 0.38 at 60 mg/L. `tests/carbonDose.test.ts` (4 cases) locks
  the monotonic response, the zone scope and that dosing is still billed.

- **Nitrification yield was 0.88 instead of 1.0.** Every gram of ammonia oxidised
  produced only 0.88 g of nitrate, so 12 % of nitrified nitrogen disappeared and the
  plant's nitrogen balance was systematically optimistic. Both engines now use
  `KINETICS.nitrateYieldPerNitrifiedN = 1.0`; denitrification was retuned in the same
  commit (`kDen` 4.6 → 8.0) because the corrected balance otherwise pushes TN over
  the limit (15.40 mg/L at the old kDen). Measured after the pair: TN 11.18 mg/L,
  nitrogen removal 65 % → 75 %. `tests/nitrogenBalance.test.ts` (8 cases) locks the
  stoichiometry, the removal range and the scenario responses.

- **Drag delta accumulated per frame.** Node dragging used the just-laid-out
  coordinates on every pointermove, so a two-grid drag moved three grids. The
  gesture now snapshots its origins and moves by `origin + total delta`.
- **Manual positions ignored utility and sludge units.** `applyManualPositions` ran
  before the blower/chemical/thickener nodes were placed, so dragging them had no
  effect. Positions are now applied in two passes.
- **Arrow keys teleported auto-laid-out units to the top-left.** Nudging used
  `positions[id] ?? {0,0}`; it now starts from the rendered position (`nudgeUnit`).
- **Incremental patches dropped controls, totals, F/M and alarms.** The client kept
  the values from the last full snapshot, so AI-executed setpoints, the cumulative
  water/energy/cost block and the alarm history stayed frozen. Merging moved into
  `snapshotMerge` (unit-tested) and the patch now carries those fields.
- **Trends froze after a reset or topology change.** Each client's incremental
  cursor stayed at the old simulation time while the buffer restarted at t=0. Full
  snapshots now re-sync the cursor to the buffer tail.
- **SMIL animation regression.** The flowing-dash overlay was still an SVG
  `<animate>` element, the mechanism previously measured at 92 % main-thread time;
  it now uses the `flow-pulse` CSS animation (0 `<animate>` elements in the DOM).
- **Topology apply trusted arbitrary JSON.** `topology.apply` frames were cast to
  `ProcessTopology` after a single `Array.isArray` check. `sanitizeTopologyInput`
  now validates units, ports, connections, train, positions and routes, caps counts
  and coordinate ranges, and rejects malformed frames before the engine sees them.
- **AI decision cadence drifted with playback speed.** Decisions fired on
  `tick % 30`, i.e. every 60 simulated minutes at 1× and every 240 at 4×, despite
  the UI promising a 15-minute cycle. Cadence is now based on simulated time
  (`aiCadence.ts`).

- **自检面板的告警项没有样式。** 数据里的严重度是 `warn`，而 `.issue` 的
  CSS 选择器写的是 `[data-sev='warning']`，两者对不上，警示项渲染成了默认的
  灰边——看起来像"正常项"，实际是模型降级/钩子失败。现在面板做 severity 映射
  （`warn → warning`），并由 `tests/watchdogPanel.test.tsx` 锁定。
- **画布缺渲染层测试。** 端口数量/配色、多选标记、单元图标、端口点击回调都没有
  断言，只有浏览器手工验证。新增 `tests/plantCanvas.test.tsx`（8 项）补上，
  并在测试里补了 jsdom 缺失的 `ResizeObserver` 桩。

- **Reasoning models produced no "model supplement".** u2-flash spends small token
  budgets entirely on `reasoning_content` (empty `content`, `finish_reason:
length`, 17–39 s). The chat path now uses a reasoning-aware budget/timeout,
  retries once with a larger budget, and exposes a new 推理强度 control
  (自动 / 压低思考 / 关闭思考) that maps to `enable_thinking` / `reasoning_effort` /
  `thinking` for OpenAI-compatible endpoints.
- **Grounded-number check rejected legitimate answers.** It only accepted numbers
  that appeared literally in the grounding text, so "去除率约 89.6%" (derived from
  337 and 35) was thrown away. The check now accepts exact derivations (difference,
  ratio, percentage change, and ratio × 100 when a ≤ b) while still rejecting
  fabricated magnitudes; a divide-by-zero path that let arbitrary numbers match
  through `Infinity` was also closed.
- **Insights showed "100 % saving" on a freshly reset plant.** Zero accumulated
  volume produced a 0 kWh/m³ reading; the panel now shows 数据不足 until it has a
  real sample and hides the percentage delta.

### Removed

- **Phantom intervention keys.** `aerationOn` and `pumpSpeed` were listed as unit
  interventions and shown in the editor palette, but neither exists in
  `ControlSettings` / `CONTROL_BOUNDS`; the inspector had to filter them by name at
  render time, i.e. the UI advertised controls that could not be written. Both keys
  are gone and `tests/interventions.test.ts` asserts every declared intervention is
  actually writable.
- `legacyModel` adapter, `unitsByKind`, `neighboringUnits`, `createShadowBenchmark`,
  `looksLikeCommand`, `commandNeedsOpenPermission`, `AGENT_CAPABILITIES`,
  `summarizeForLog`, `permissionLabel`, `capabilitiesFor`, `unitIcons.ts`,
  `state.edgeFlows`, `CompiledReactor.inlets` / `receives*`, `PLANT.tanks`,
  `BIO_VOLUME`, `AEROBIC_VOLUME`, `TankConfig`, `TankKind` — 855 deleted lines in total.
- The `plantModel ↔ networkEngine` import cycle (the leg adapter was the back-edge) and
  the `shared/protocol → server/benchmark` reverse dependency.

### Docs

- READMEs: test count and coverage are refreshed at release time (794 tests, 92.9 % lines /
  82.4 % branches on Node 24, 90.7 / 81.0 on Node 20), source tree updated
  (forcing/alarmRules/topologyEdit/topologyInput/trainProfile/tankStates/topologyStore added,
  reference engine removed from the runtime description).
- `docs/BENCHMARKS.md`, `docs/DEPLOYMENT.md`, `docs/UI-ARCHITECTURE.md` and
  `scripts/README.md` were re-measured against this build; every number now names the
  command that produced it.
- `.aqg/code-construction/debt-payoff-and-theory-audit.md` and
  `.aqg/code-construction/cross-round-audit.md` record the two audit rounds below.

### Audit trail (measured, not opinion)

| # | Finding | Evidence |
|---|---|---|
| T1 | Simplified nitrification runs ~420× the ASM1 rate constant, compensated by a biomass factor | `kNit=14/h` vs `ASM1 mu_A/24≈0.033/h`, `bf=xBiomass/DESIGN_MLSS` |
| T2 | **Fixed together with T3**: default control exceeded the 15 mg/L TN limit | 15.40 → 11.18 mg/L at seed 7 |
| T3 | **Fixed**: nitrate yield was 0.88, so 12 % of nitrified N vanished | `KINETICS.nitrateYieldPerNitrifiedN = 1.0` + `kDen` 4.6 → 8.0 |
| T4 | **Fixed**: every tank reported the plant-average MLSS | `server/tankStates.ts` now labels `mlssSource`; ASM1 mode gives per-reactor values |
| T5 | ASM1 and simple modes expose different TP definitions through one field | simple 0.010 vs asm1 2.509 mg/L |
| T6 | Takács thickening zone has ~4 distinct values | profile `8,13,22,53,254,258,259,260,259,5474` |
| T7 | Clarifier solids balance residual 1.5 % | 7020 vs 6917 kg/h steady state |
| T8 | **Fixed**: `carbonDose` changed cost only | now enters the anoxic zone; TN 11.44 → 9.37 at 60 mg/L |

## [0.3.0] — 2026-10-24

### Changed (branch and hosting cleanup)

- **Default branch is `main` on every remote.** The repository was created on
  `master`; all five hosted copies now use `main` as the default branch and the
  `master` refs have been deleted. CI triggers watch `main` only.
- **AtomGit is GitCode, not a sixth platform.** Both hostnames resolve to the same
  IPs, share the same API (`api.atomgit.com` and `api.gitcode.com` return the same
  repository id for `badhope/aquapilot`), and share credentials. The duplicate
  `atomgit` remote, `.gitcode/workflows/` and the unused `.gitlab-ci.yml` were
  removed; the delivery surface is five repositories on three services
  (GitHub ×3, Gitee, GitCode).

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
- **Alarm attribution and plant health.** Every active alarm now carries the
  affected process unit, the most likely cause (toxicity suppresses nitrification
  before low DO is blamed), an executable action and a trend-extrapolated
  consequence with the metric's limit. A five-part weighted health score
  (effluent margin 35 %, DO 15 %, SRT 15 %, clarifier 20 %, alarms 15 %) is
  exposed in the snapshot and shown in the top bar and alarm panel. Covered by
  `tests/alarmAttribution.test.ts` (15 cases) and three component cases.
- `GET /api/presets`, `tests/release030.test.ts` (20 contract tests), a media
  generator (`scripts/media.ts`) and refreshed screenshots / demo video.
- Test suite 347 → 381: alarm attribution (15), AuthGate token lifecycle (5),
  plus component coverage for the health block and attribution rows.

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
- `stepShadow` resets the shadow plant from the _same_ default controls and
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

### Implementation notes

- The secondary-clarifier area change (2 400 → 3 600 m²) is a **model correction**,
  not a tuning trick: at the old area the steady state violated the plant's own
  discharge limit (SS 11.1 mg/L vs 10), which made the AI enter emergency mode at
  every cycle. The new area matches the BSM1 design surface loading within 10 %.
- The shadow benchmark resets the manual plant from the **same** warm-up and the
  **same** default controls before switching to the fixed strategy. Comparing two
  differently-initialised plants would measure initial conditions, not policy.

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
