# HTTP API

Every endpoint below is **read-only** and answers `GET` (and `HEAD`).
Write operations go through the WebSocket protocol, see [Protocol](#websocket-protocol).

This describes the current local working tree, including uncommitted changes; it
is not a statement of what has been published.

Base URL: `http://127.0.0.1:5173` by default (`PORT` overrides it).

## Authentication

Access control is **off by default**. Setting any of the three role tokens enables
it for every `/api/*` route except `/api/health` (including `?deep=1`) and
`/api/auth-required`. Static assets remain public so the browser can load the
application and show its token prompt. Non-loopback binding requires at least
one configured token.

### Roles

Three token slots map to three roles. All are optional; leaving them empty keeps
authentication off (every client is `admin`, which is the right default for local
development).

| Env var | Role | Can do |
| --- | --- | --- |
| `AQUAPILOT_VIEWER_TOKEN` | `viewer` | Read every GET endpoint, watch the live stream, run analysis |
| `AQUAPILOT_OPERATOR_TOKEN` | `operator` | Everything above, plus `control`, `scenario`, `sim`, `speed`, `applyRecommendation`, `refreshDecision`, `preset` |
| `AQUAPILOT_TOKEN` | `admin` | Everything, plus `topology`, `llmConfig`, `agentConfig` |

A single-token deployment keeps working unchanged: `AQUAPILOT_TOKEN` alone means
"this token is admin". A `viewer` token that tries to change a setpoint gets a
`notice` explaining the required role; nothing is applied.

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

### `GET /api/topology/history`

The newest 20 applied flowsheet versions (revision, timestamp, label, name, unit and
connection counts). Full topologies stay on the server; roll back through the
WebSocket with `{ type: 'topology', action: 'revert', revision }`.

### `GET /api/metrics` · `GET /api/metrics?format=json`

Prometheus text exposition (default) or a JSON view with the same counters and
the SLO table. See [SLO](SLO.md) for the metric names and alerting thresholds.

### `GET /api/history/decisions`

Last 100 persisted AI decisions: timestamp, action, severity, summary, tweaks,
predicted score and separation. `{ "enabled": false }` when persistence is off.

### `GET /api/history/snapshots?from=<min>&to=<min>`

Sampled effluent history for replay, scoped to the latest run unless `runId` is
given. Also lists all runs. `from`/`to` are simulated minutes; a single request
covers at most 7 simulated days (10080 min) and returns at most 20 000 rows —
larger windows are rejected with 400 so one request cannot pull the whole table
into memory. `to` defaults to `from + 10080`.

### `GET /api/history/alarms?limit=<n>&runId=<id>`

Persisted alarms (newest first, `limit` truncated to an integer and clamped to
1–500, default 100), optionally
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
quoted fields where needed). Served with `Content-Disposition: attachment`. Same
window rules as `GET /api/history/snapshots`: at most 7 simulated days and
20 000 rows per request.

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

Connect to `/ws`. When any role token is set, browsers cannot send an
`Authorization` header on the handshake, so the UI sends a UTF-8, unpadded
base64url-encoded token as the `token.b64.<encoded-token>` subprotocol. The
legacy `token.<token>` subprotocol is also accepted, but only for tokens whose
characters are valid in a WebSocket subprotocol.

A legacy `/ws?token=...` query parameter is accepted only on the WebSocket path. Do not put tokens in HTTP API URLs: URLs can be copied into access logs, browser history, or proxy traces.

Frames are JSON objects with a `type`. Client → server:

| `type`                | Purpose                                                                         |
| --------------------- | ------------------------------------------------------------------------------- |
| `hello`               | Ask for a full snapshot, sim state, current decision and topology               |
| `chat`                | Ask a question about the current state (`text`, ≤ 2000 chars; one request per 1.5 s, max 2 in flight) |
| `control`             | Apply a control patch (rate-limited to one per 500 ms)                          |
| `aiEnabled`           | Switch between automatic and advisory mode                                      |
| `applyRecommendation` | Accept the current AI recommendation                                            |
| `scenario`            | Inject or clear a scenario                                                      |
| `sim`                 | `pause` / `resume` / `reset`                                                    |
| `speed`               | Simulation speed, 0.25–8 (fractional minutes are carried between frames, so 0.25× really runs at a quarter of 1×) |
| `topology`            | `get` / `apply` / `history` / `revert` a flowsheet (mutations limited to one per 5 s) |
| `preset`              | Apply a shipped template by id (rebuilds and warms up the plant; shares the 5 s topology limit) |
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

### Fields added in 0.4.0

| Field | Meaning |
|---|---|
| `clarifier.profile` / `clarifier.feedLayer` | Ten-layer Takács settler profile (g SS/m³) and the feed layer index |
| `tanks[].mlssSource` | `plant-average` (simplified model, one global biomass) or `reactor` (ASM1 per-zone value); the inspector labels the former 「全厂均值」 |
| `snapshotPatch.scenario` | Active scenario including `null` when it ends — without it the control panel kept showing 「进行中」 after the window closed |
| `snapshotPatch.controls` / `totals` / `fmRatio` / `alarms` | The patch must carry these or the UI freezes at the values from the last full snapshot |
| `snapshotPatch.forecastBand` / `benchmark` | Same reason: without them the forecast fan and the AI-vs-fixed comparison stay frozen at connection time |

Static assets are served with `ETag`, conditional `304`, `Accept-Encoding: gzip`
for text payloads (≈901 kB → 290 kB for the client bundle), `Cache-Control:
no-cache` for `index.html` and `immutable` one-year caching for the hashed
`/assets/*` files.

`refreshDecision` is rate-limited to one call per 2 s per socket: one decision
cycle is a ~200 ms synchronous forecast burst, so unbounded clicking stalls ticks.

Topology frames gained `action: 'history' | 'revert'`; `revert` re-applies an old
document as a **new** revision (see `GET /api/topology/history`).

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
`apiKeyMasked` (`sk-••••1234`). An empty `apiKey` on save, discover or test
reuses the stored key only when the target has the same origin (scheme, host and
port) as the saved URL. A different origin requires a key to be supplied again;
changing only the path does not change the origin. Discovery and connection
tests can run without a key when no key is stored; saving a configuration
requires a key.

`baseUrl` is trust-boundary input. It must be `http(s)`, must not embed
credentials, and must not point at cloud metadata hosts
(`169.254.169.254`, `metadata.google.internal`, `100.100.100.200`), IPv4
link-local addresses, IPv6 link-local or unique-local addresses, or the local-use
NAT64 prefix `64:ff9b:1::/48`. The latter is rejected even when it embeds a
public IPv4 address. Localhost and IPv4 private ranges are allowed because
self-hosted Ollama/vLLM live there. DNS answers are checked before connecting;
redirects are not followed. Custom NAT64 prefixes cannot be identified by this
address-based guard and require network-level restrictions.

Outbound requests ask for `identity` encoding by default. Forced `gzip`,
`x-gzip`, `deflate` and `br` response bodies are decoded; unsupported or stacked
encodings on responses with a body are rejected. Model response bodies are limited
to 1,000,000 bytes both before and after decompression.

Protocol endpoints used:

| Protocol    | Discovery                         | Chat                                                      |
| ----------- | --------------------------------- | --------------------------------------------------------- |
| `openai`    | `GET {base}/models`               | `POST {base}/chat/completions`                            |
| `anthropic` | `GET {base}/v1/models?limit=1000` | `POST {base}/v1/messages`                                 |
| `google`    | `GET {base}/v1beta/models` with `x-goog-api-key` | `POST {base}/v1beta/models/{model}:generateContent` with `x-goog-api-key` |

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
