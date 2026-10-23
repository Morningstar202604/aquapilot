# Scripts

Development and verification helpers. None of them are needed at runtime; the
server bundle in `dist/server` is self-contained.

| Script | What it answers | Needs a running server |
|---|---|---|
| `npm run dev` → `dev.mjs` | Start server + Vite with hot reload | — |
| `npm run build` → `build-server.mjs` | Bundle the server with esbuild | — |
| `npm run ci` → `ci-gate.sh` | Full local gate: deps, types, tests, build, smoke, secret scan | — |
| `npm run e2e` → `e2e-ci.ts` | Playwright smoke: renders, tabs, no console errors, no edges crossing units | spawns its own |
| `backup.ts` | Consistent `VACUUM INTO` backup, verified restore, list | — |
| `backup-seed.ts` | Create/verify a database with known row counts (used by CI) | — |
| `bench.ts` | Step, forecast and decision timings; 30-day spin-up cost | — |
| `bench-server.ts` | Same for the topology runtime + AI cycle | — |
| `check-takacs.ts` | Settler calibration: effluent SS and solids loading | — |
| `prove-network-solving.ts` | Adding a reactor really adds a solved reactor | — |
| `prove-topology-matters.ts` | Plant parameters change the physics, with numbers | — |
| `e2e-topology-live.ts` | Apply a topology over the live API and compare effluent | yes |
| `bsm1-gap.ts` | Structural differences between this plant and BSM1 | — |
| `calibrate.ts` | Parameter sensitivity / calibration sweep | — |
| `harness.ts` | Interactive engine harness for manual experiments | — |

The last five are exploratory tools: they print numbers for a human to read and
are not part of CI.

## Conventions

- Scripts import from `src/` directly and run through `tsx` (no build step).
- `scripts/__*` and `scripts/tmp-*` are scratch prefixes and are excluded from
  `tsconfig.json`; nothing in that shape is committed.
- Anything a reviewer needs to reproduce belongs in a test, not in a script.
