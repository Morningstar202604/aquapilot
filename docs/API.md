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

| Status | When |
|---|---|
| 400 | Malformed URL encoding on a static path |
| 401 | Auth required and token missing/invalid |
| 403 | Static path escapes `dist/client` |
| 404 | Unknown `/api/*` route, or a missing static asset with an extension |
| 405 | Any non-`GET`/`HEAD` request to an `/api/*` route; `Allow: GET, HEAD` |

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
  "ok": true, "paused": false, "tickErrors": 0, "lastTickMs": 3.1,
  "persistence": "enabled", "simulationMinutes": 1234
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

### `GET /api/history/stats`

Row counts for decisions, alarms and snapshots.

## WebSocket protocol

Connect to `/ws`. When `AQUAPILOT_TOKEN` is set, browsers cannot send an
`Authorization` header on the handshake, so the token travels as a subprotocol:

```js
new WebSocket('ws://127.0.0.1:5173/ws', [`token.${token}`]);
```

Frames are JSON objects with a `type`. Client → server:

| `type` | Purpose |
|---|---|
| `hello` | Ask for a full snapshot, sim state, current decision and topology |
| `chat` | Ask a question about the current state (`text`, ≤ 2000 chars) |
| `control` | Apply a control patch (rate-limited to one per 500 ms) |
| `aiEnabled` | Switch between automatic and advisory mode |
| `applyRecommendation` | Accept the current AI recommendation |
| `scenario` | Inject or clear a scenario |
| `sim` | `pause` / `resume` / `reset` |
| `speed` | Simulation speed, 0.25–8 |
| `topology` | `get` or `apply` a flowsheet (apply is limited to one per 5 s) |
| `refreshDecision` | Recompute the recommendation immediately |

Server → client: `snapshot`, `snapshotPatch` (incremental), `decision`, `chat`,
`notice`, `simState`, `topology`.

Frames larger than 512 KB are rejected. Every field is validated and range
checked server-side; unknown keys in a control patch are dropped, not trusted.
