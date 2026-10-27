# HTTP API

Every endpoint below is **read-only** and answers `GET` (and `HEAD`).
Write operations go through the WebSocket protocol, see [Protocol](#websocket-protocol).

Base URL: `http://127.0.0.1:5173` by default (`PORT` overrides it).

## Authentication

Access control is **off by default**. Set `AQUAPILOT_TOKEN` to require a bearer
token on every `/api/*` route except `/api/health` and `/api/auth-required`
(those two must stay public, otherwise the browser cannot tell whether to show
the token prompt).

```
Authorization: Bearer <token>
```

A wrong or missing token returns `401` with `{ "error": ..., "authRequired": true }`.
Tokens are compared in constant time over SHA-256 digests.

## Errors

| Status | When                                                                  |
| ------ | --------------------------------------------------------------------- |
| 400    | Malformed URL encoding on a static path                               |
| 401    | Auth required and token missing/invalid                               |
| 403    | Static path escapes `dist/client`                                     |
| 404    | Unknown `/api/*` route, or a missing static asset with an extension   |
| 405    | Any non-`GET`/`HEAD` request to an `/api/*` route; `Allow: GET, HEAD` |

`HEAD` is answered like `GET` without a body.

Unknown `/api/*` paths return JSON, never the SPA shell — a client that asked for
JSON must not receive HTML.

## Endpoints

### `GET /api/health`

Liveness. Returns `200` as long as the process can answer.

```json
{ "ok": true, "authRequired": false, "uptimeSeconds": 42 }
```

### `GET /api/health?deep=1`

Readiness. Adds simulation and persistence state; returns `503` when the tick
loop is paused **because it threw**.

```json
{
  "ok": true,
  "paused": false,
  "tickErrors": 0,
  "lastTickMs": 3.1,
  "persistence": "enabled",
  "simulationMinutes": 1234
}
```

### `GET /api/auth-required`

`{ "required": true | false }`. Public by design.

### `GET /api/snapshot`

Full plant snapshot: effluent, per-reactor state, clarifier, controls, energy,
cost, score, margins, alarms, trends (max 720 points), forecast and the current
AI recommendation. This is the largest response; the UI normally receives
incremental `snapshotPatch` messages over the WebSocket instead.

### `GET /api/limits`

Discharge limits, control bounds and plant constants.

### `GET /api/topology`

Current flowsheet plus its revision, run-readiness and validation issues, and the
reactors the solver derived from it.

### `GET /api/metrics` · `GET /api/metrics?format=json`

Prometheus text exposition (default) or a JSON view with the same counters and
the SLO table. See [SLO](SLO.md) for the metric names and alerting thresholds.

### `GET /api/history/decisions`

Last 100 persisted AI decisions: timestamp, action, severity, summary, tweaks,
predicted score and separation. `{ "enabled": false }` when persistence is off.

### `GET /api/history/snapshots?from=<min>&to=<min>`

Sampled effluent history for replay, scoped to the latest run unless `runId` is
given. Also lists all runs.

### `GET /api/history/alarms?limit=<n>&runId=<id>`

Persisted alarms (newest first, `limit` clamped to 1–500, default 100), optionally
scoped to one run. The server records an alarm row the first time each code
becomes active, so the shutdown timeline can be reconstructed after the fact.

### `GET /api/history/stats`

Row counts for decisions, alarms and snapshots.

### `GET /api/presets`

The shipped process templates and which one is active (`activeId` is `null` after a
custom topology has been applied).

```json
{
  "presets": [{ "id": "a2o-standard", "name": "A²/O 标准厂", "description": "…" }],
  "activeId": "a2o-standard"
}
```

### `GET /api/export/snapshots.csv?from=<min>&to=<min>`

Sampled effluent history for the latest run as RFC 4180 CSV (CRLF line endings,
quoted fields where needed). Served with `Content-Disposition: attachment`.

### `GET /api/export/decisions.csv`

The last 1000 persisted decisions as CSV, including the summary and the tweak JSON.

### `GET /api/export/report.md`

A one-page Markdown shift report built from the current snapshot: effluent table,
operating state, current recommendation (including the ensemble exceedance
probability when evaluated) and the AI-vs-fixed benchmark. It states that the data
is simulated, not measured.

All export endpoints are read-only and sit behind the same auth gate as every other
`/api/*` route. The UI downloads them with `fetch` plus an `Authorization` header —
the token is never placed in a URL.

## WebSocket protocol

Connect to `/ws`. When `AQUAPILOT_TOKEN` is set, browsers cannot send an
`Authorization` header on the handshake, so the token travels as a subprotocol:

```js
new WebSocket('ws://127.0.0.1:5173/ws', [`token.${token}`]);
```

Frames are JSON objects with a `type`. Client → server:

| `type`                | Purpose                                                                         |
| --------------------- | ------------------------------------------------------------------------------- |
| `hello`               | Ask for a full snapshot, sim state, current decision and topology               |
| `chat`                | Ask a question about the current state (`text`, ≤ 2000 chars)                   |
| `control`             | Apply a control patch (rate-limited to one per 500 ms)                          |
| `aiEnabled`           | Switch between automatic and advisory mode                                      |
| `applyRecommendation` | Accept the current AI recommendation                                            |
| `scenario`            | Inject or clear a scenario                                                      |
| `sim`                 | `pause` / `resume` / `reset`                                                    |
| `speed`               | Simulation speed, 0.25–8                                                        |
| `topology`            | `get` or `apply` a flowsheet (apply is limited to one per 5 s)                  |
| `preset`              | Apply a shipped template by id (rebuilds and warms up the plant)                |
| `refreshDecision`     | Recompute the recommendation immediately                                        |
| `llmConfig`           | Custom model onboarding: `get`, `discover`, `test`, `save`, `clear` (see below) |

Server → client: `snapshot`, `snapshotPatch` (incremental), `decision`, `chat`,
`notice`, `simState`, `topology`.

Frames larger than 512 KB are rejected. Every field is validated and range
checked server-side; unknown keys in a control patch are dropped, not trusted.

### `snapshot` / `snapshotPatch` fields added in 0.3.0

| Field                                               | Meaning                                                                                        |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `forecastBand`                                      | P10/P50/P90 bands for the current recommendation, or `null` when the model cannot be perturbed |
| `benchmark`                                         | AI vs fixed-strategy shadow totals (compliance minutes, energy, cost, score)                   |
| `totals.energyCost` / `chemicalCost` / `sludgeCost` | Cumulative cost split; the previous code only exposed today's counters                         |
| `recommendation.ensemble`                           | Ensemble attached to the chosen candidate                                                      |
| `recommendation.robustEvaluated`                    | False when only a single-point forecast was possible                                           |

`benchmark.mature` turns true after six simulated hours; before that the UI labels
the comparison as indicative.

### Custom model configuration (`llmConfig`)

The dialog writes through the same WebSocket; there is no HTTP write endpoint.
Every request carries a `requestId` so the client can discard stale responses.
`discover` and `test` are rate-limited to one call per 800 ms per socket.

| Frame                                                                                         | Fields                                                                  | Response                                                               |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `{type:"llmConfig", action:"get"}`                                                            | —                                                                       | `{action:"config", config: LlmPublicConfig \| null}`                   |
| `{type:"llmConfig", action:"discover", requestId, protocol, baseUrl, apiKey?}`                | `protocol`: `openai` / `anthropic` / `google`                           | `{action:"discovered", requestId, models: DiscoveredModel[]}`          |
| `{type:"llmConfig", action:"test", requestId, protocol, baseUrl, apiKey?, model, maxOutput?}` | —                                                                       | `{action:"tested", requestId, result:{ok, latencyMs, reply?, error?}}` |
| `{type:"llmConfig", action:"save", requestId, draft}`                                         | draft: protocol, baseUrl, apiKey, model, capabilities, autoCapabilities | `{action:"saved", requestId, ok, config?, error?}`                     |
| `{type:"llmConfig", action:"clear", requestId}`                                               | —                                                                       | `{action:"saved", requestId, ok:true}`                                 |

Failure of any action returns `{action:"error", requestId?, error}` with a
readable Chinese cause (bad key, wrong path, rate limit, timeout, SSRF refusal).

`LlmPublicConfig` never contains the plaintext key: it exposes `hasKey` and
`apiKeyMasked` (`sk-••••1234`). An empty `apiKey` on save keeps the stored one.

`baseUrl` is trust-boundary input. It must be `http(s)`, must not embed
credentials, and must not point at cloud metadata hosts
(`169.254.169.254`, `metadata.google.internal`, `100.100.100.200`) or any
`169.254.0.0/16` address. Localhost and private ranges are allowed because
self-hosted Ollama/vLLM live there.

Protocol endpoints used:

| Protocol    | Discovery                         | Chat                                                      |
| ----------- | --------------------------------- | --------------------------------------------------------- |
| `openai`    | `GET {base}/models`               | `POST {base}/chat/completions`                            |
| `anthropic` | `GET {base}/v1/models?limit=1000` | `POST {base}/v1/messages`                                 |
| `google`    | `GET {base}/v1beta/models?key=…`  | `POST {base}/v1beta/models/{model}:generateContent?key=…` |

### Agent configuration (`agentConfig`)

Writes go through the WebSocket, the same channel as every other mutation.
`agentConfig` accepts `get`, `save`, `patch`, `reset`, `importSkill` and
`previewPrompt`; each carries a `requestId` and answers with
`{action:"state"|"saved"|"error"}`.

The server-side store is the single gatekeeper for all three write paths (UI,
chat commands, CLI/file):

| Permission | Can write                                                                     | Cannot                                                      |
| ---------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `readonly` | nothing                                                                       | everything                                                  |
| `standard` | persona, prompts, skills, hooks (notice/log/skill), constraints (step ≤ 30 %) | webhook hooks, step > 30 %                                  |
| `open`     | everything outside the core protection list                                   | effluent limits, safety guardrails, auth, secrets, kinetics |

Core fields (`limits`, `safety`, `auth`, `secrets`, `kinetics`, `guardrails`,
`core`) are stripped during normalization at any permission level and reported
back as warnings. The plaintext-free config lives in `data/agent-config.json`
(mode 0600) and is hot-reloaded whenever its mtime changes, so editing the file
or running the CLI takes effect without a restart.

Chat commands are parsed before the rule engine; anything starting with 设置 /
添加 / 删除 / 列出 / 查看 / 约束 / 权限 / 开启 / 关闭 / 恢复 / 命令 is treated as
configuration and answered with an `editor`-kind answer instead of a plant
status answer.

### Hooks

Hooks are declarative, never shell: `notice` broadcasts a message, `log` writes a
structured log line, `skill` registers a skill hit for the next answer, and
`webhook` POSTs JSON to a URL (open permission only, SSRF guard applies, 5 s
timeout). Each `(hookId, eventKey)` pair fires at most once per `cooldownMin`.

### Watchdog

The server evaluates nine deterministic checks every 10 seconds and broadcasts a
`watchdog` frame when the verdict changes: simulation tick errors, clock
progress, tick latency, model fallback rate, persistence, Agent config warnings,
hook failures, config file presence, and client connections. Each check carries
`severity`, `detail` and an actionable `action` string.

### Chat answers

A `chat` frame from the client always produces a rule-engine answer first. When
`AQUAPILOT_LLM_BASE_URL` and `AQUAPILOT_LLM_MODEL` are set, a second answer
(`source: "llm"`) follows if the model returns text whose numbers all appear in
the grounding facts. Errors, timeouts and ungrounded answers are silent: the user
keeps the rule-engine answer and `aquapilot_llm_fallbacks_total` increments.
