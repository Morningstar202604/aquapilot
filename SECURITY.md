# Security

## Reporting

Report vulnerabilities privately to the maintainers. Do not open a public issue
for anything that could be exploited before a fix is available.

## Threat model

This project is a **local simulation prototype**. It is not hardened for public
exposure and its threat model reflects that:

| Concern | Current state |
|---|---|
| Authentication | Opt-in single shared token (`AQUAPILOT_TOKEN`), constant-time compared. Off by default; set it before exposing the server beyond localhost |
| Authorization | Single-user. Every connected client can control the plant |
| Transport | Plain HTTP/WebSocket. Terminate TLS and set `AQUAPILOT_TOKEN` at a proxy before any non-local exposure |
| Input validation | All client messages validated and range-checked server-side; HTTP API is read-only (GET/HEAD only) |
| Payload size | WebSocket frames capped at 512 KB |
| Origin | WebSocket connections restricted to localhost origins |
| Rate limits | Control operations 500 ms, topology changes 5 s, per client |
| Secrets | None stored in the repository; CI scans for tokens and private keys |
| LLM dialogue | Off by default. When enabled, only computed facts are sent; answers whose numbers are absent from those facts are discarded and the rule answer is kept |
| Exports | Read-only CSV/Markdown generation; auth-gated like every other `/api/*` route |

## Known limitations

- No per-user identity: the token is one shared secret, so actions cannot be attributed
- AI decisions are persisted with their reasoning; manual control changes are not written to an audit log
- Simulation state is in memory; history (decisions, snapshots) is persisted to SQLite on Node 22+ and used for replay
- No TLS termination inside the process
- An enabled LLM endpoint is a trust boundary: the prompt contains plant state. Point it at a provider you are willing to share simulated operating data with, and never at an untrusted proxy

## Dependency vulnerabilities

`npm audit --audit-level=high` runs in CI. If it fails, the build is red; do not
merge around it.
