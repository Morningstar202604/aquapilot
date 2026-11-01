# AquaPilot

Topology-driven wastewater process simulation with an AI operator.

[中文说明](README.zh-CN.md)

[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520.19-339933)](package.json) [![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

![AquaPilot overview](docs/screenshots/01-overview.jpg)

## What it is

AquaPilot is a runnable operations-side simulation prototype. A process flowsheet is stored as a graph, compiled into a network of reactors, solved in topology order, and rendered in a control-room UI. The AI operator forecasts, ranks control moves, applies hard guardrails, and explains the result so a human can inspect or override it.

It is **not** a design-grade simulator, a real-plant control system, a compliance guarantee, or a field digital twin. Results are for simulation, testing, and engineering discussion only.

## Verified capabilities

- **Topology-driven solving:** unit count, volumes, ports, streams, recycles, and routes come from the editable topology; changing the graph changes the solved network.
- **Running water train:** ASM1 plus a ten-layer Takács secondary clarifier, with a BSM1 Table 6 comparison test.
- **AI operation:** four-hour forecasts, candidate control moves, compliance/cost/stability scoring, hard bounds, manual override, and critical-alarm handling.
- **Robust analysis:** fixed-perturbation stress bands, parameter sensitivity, a compliance-versus-cost Pareto frontier, and a plant-wide COD balance audit.
- **Shadow comparison:** AI and a fixed strategy run with the same seed, influent, and initial state; the comparison is controlled simulation evidence, not a field A/B test.
- **Operations workflow:** scenarios, alarms with attribution, plant health, replay/export, backups, CSV influent replay, and data-quality rejection for invalid uploads.
- **Experimental calibration and estimation:** bounded calibration against a synthetic BSM1 target and a default-off six-state EKF using simulated measurements. This is not field calibration or sensor-based soft measurement.
- **Model registry:** ASM1 is the active runtime model. ASM2d and ADM1 are implemented and tested as standalone units, but are not connected to the main water train and are not a complete BSM2 flow.
- **Model providers:** OpenAI-compatible, Anthropic Messages, and Google Gemini transports can be configured through the UI; the LLM layer is optional and falls back to deterministic rules.
- **Access levels:** `viewer`, `operator`, and `admin` are mapped from shared environment tokens. This is not user-account management or full multi-user RBAC.

## Implementation status

| Capability | Status | Boundary |
| --- | --- | --- |
| ASM1 + Takács water train | Running runtime | The main train uses ASM1; BSM1 comparison remains within documented tolerances. |
| ASM2d and ADM1 | Implemented, standalone | Unit tests and registry metadata exist; no BSM2 end-to-end integration. |
| Parameter calibration | Experimental | Synthetic BSM1 observations; results do not automatically change runtime parameters. |
| State estimation | Experimental, off by default | Simulated state plus deterministic noise; no field sensor stream. |
| CSV influent replay | Implemented | Validated by size/format/data-quality checks before application. |
| MQTT / OPC UA | Not implemented | The adapter contract reports an explicit unavailable status; no protocol client is shipped. |
| Persistent history | Environment-dependent | Node 22+ can use built-in `node:sqlite`; Node 20 may fall back to in-memory history. Check `/api/health?deep=1`. |
| Access control | Implemented, shared-token model | Three access levels, not named users or a complete RBAC system. |

## Quick start

Requirements: Node.js 20.19 or newer. Node 22+ is recommended when replay/history persistence is needed.

```bash
npm ci
npm run build
npm start                 # http://127.0.0.1:5173
```

Development mode:

```bash
npm run dev               # Vite client + development server
```

Verification commands:

```bash
npm run typecheck
npm run lint
npm run test
npm run verify            # typecheck + lint + test + build
npm run ci                # local quality gate, audit, smoke, backup, and hygiene checks
npm run e2e               # Playwright browser smoke; uses managed Chromium or AQUAPILOT_BROWSER_PATH
```

Docker:

```bash
docker build -t aquapilot:local .
docker run --rm -p 5173:5173 -v aquapilot-data:/app/data aquapilot:local
```

## Configuration

The UI can save LLM settings. Environment variables are available for deployment and local automation; use placeholders, never commit real values.

```text
AQUAPILOT_TOKEN=...            # optional admin token for API and WebSocket access
AQUAPILOT_OPERATOR_TOKEN=...   # optional operator token
AQUAPILOT_VIEWER_TOKEN=...     # optional read-only token
AQUAPILOT_LLM_BASE_URL=...
AQUAPILOT_LLM_MODEL=...
AQUAPILOT_LLM_API_KEY=...
```

When authentication is enabled, read operations require `viewer`, control/scenario operations require `operator`, and topology/model/agent configuration requires `admin`. Use TLS and a reverse proxy before exposing the server beyond localhost. LLM configuration is stored with restricted file permissions and keys are masked before being sent to the browser.

## Reproducible evidence

The single source for current measured numbers is [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md). It records the command, Node version, seed, strategy, and known model limits for each result.

The latest local gate baseline is 89 test files and 1094 passing tests. The reported coverage is **domain coverage** for the configured model/AI/server sources, not coverage of every React component; the current line, branch, and function figures are maintained in `docs/BENCHMARKS.md`.

## Limitations and safety

- Do not use simulation output as a design calculation, regulatory submission, operating instruction, or automatic control authorization.
- The running water train is ASM1 + Takács. ASM2d and ADM1 are standalone implementations and have not been validated as a complete BSM2 flowsheet.
- Calibration is synthetic-data validation. EKF is disabled by default and does not consume field sensors.
- P10/P50/P90 bands and exceedance ratios are fixed perturbation stress tests, not statistical confidence intervals or field risk probabilities.
- MQTT and OPC UA are not implemented. CSV replay is the available external-data path.
- Runtime state is shared by connected clients. Access levels are shared-token mappings, not named accounts.
- Node 20 can run without SQLite persistence; verify persistence state in the health endpoint and replay panel.
- BSM1 S_NH and the clarifier concentration profile still have documented deviations. See the benchmark table before interpreting numbers.

## Documentation

- [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md) — reproducible model, strategy, performance, and coverage measurements
- [`docs/API.md`](docs/API.md) — HTTP and WebSocket contracts
- [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — operations, backup, recovery, and troubleshooting
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — Docker, persistence, proxy, and deployment boundaries
- [`docs/QUALITY-ROADMAP.md`](docs/QUALITY-ROADMAP.md) — historical roadmap and remaining model work
- [`docs/COMPETITIVE-SOURCE-ANALYSIS.md`](docs/COMPETITIVE-SOURCE-ANALYSIS.md) — model scope and source evidence
- [`scripts/README.md`](scripts/README.md) — verification and development scripts
- [`README.zh-CN.md`](README.zh-CN.md) — Chinese documentation

## License

MIT
