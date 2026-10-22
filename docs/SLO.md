# Service Level Objectives

This file is the human-readable counterpart of `SLO` in `src/server/observability.ts`.
The code is the source of truth; if the two disagree, the code wins.

| SLO | Target | Window | Measured by |
|---|---|---|---|
| Availability | 99.5% of requests non-5xx | 30 days | `aquapilot_http_errors_total` ÷ `aquapilot_http_requests_total` |
| API latency | p95 < 300 ms | 30 days | `aquapilot_http_request_duration_seconds` histogram |
| Simulation tick budget | p99 < 1000 ms | 1 hour | `aquapilot_tick_duration_max_ms` (per-process gauge) |
| WebSocket stability | unexpected disconnects < 1% | 24 hours | `aquapilot_ws_disconnections_total` ÷ accepted |

## Endpoints

- `GET /api/metrics` — Prometheus text exposition (default).
- `GET /api/metrics?format=json` — same data plus the SLO table, for humans and for the UI.
- `GET /api/health` — liveness: 200 as long as the process answers.
- `GET /api/health?deep=1` — readiness: 503 when the tick loop is paused **because
  it threw**, plus the last tick duration and the current simulated clock.

Both sit behind the same auth gate as every other `/api/*` route when
`AQUAPILOT_TOKEN` is set.

## What this process can and cannot measure

The server is a single process with in-memory counters. That is enough for a
live dashboard and for `curl`-based smoke checks, but **not** enough to evaluate a
30-day window: a restart resets every counter. Long-window SLOs therefore require
scraping by Prometheus (or any compatible agent) and evaluating the rate over time
on the monitoring side. This limitation is deliberate — embedding a time-series
database inside a simulator would be the wrong trade.

## Alerting thresholds (suggested, for whoever scrapes this)

| Condition | Severity | Meaning |
|---|---|---|
| `rate(aquapilot_http_errors_total[5m]) > 0` | page | Requests are failing |
| `aquapilot_tick_duration_max_ms > 1000` | page | Simulation is falling behind its 1 s cadence |
| `rate(aquapilot_auth_failures_total[5m]) > 10` | ticket | Possible credential stuffing or a misconfigured client |
| `aquapilot_ws_connections == 0` for 5 min while traffic continues | ticket | Clients cannot keep a live link |
| `rate(aquapilot_persistence_errors_total[5m]) > 0` | ticket | History is silently not being written |
