# Security

## Reporting

Report vulnerabilities privately to the maintainers. Do not open a public issue
for anything that could be exploited before a fix is available.

## Threat model

This project is a **local simulation prototype**. It is not hardened for public
exposure and its threat model reflects that:

| Concern | Current state |
|---|---|
| Authentication | None. Do not expose the server to the internet without a reverse proxy that authenticates |
| Authorization | Single-user. Every connected client can control the plant |
| Transport | Plain HTTP/WebSocket. Terminate TLS at a proxy |
| Input validation | All client messages validated and range-checked server-side |
| Payload size | WebSocket frames capped at 512 KB |
| Origin | WebSocket connections restricted to localhost origins |
| Rate limits | Control operations 500 ms, topology changes 5 s, per client |
| Secrets | None stored in the repository; CI scans for tokens and private keys |

## Known limitations

- No audit log of control actions
- No per-user identity, so actions cannot be attributed
- In-memory state only; a restart loses all history
