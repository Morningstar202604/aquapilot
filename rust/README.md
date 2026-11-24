# AquaPilot Rust core

M1 migration target. The TypeScript engine is the reference oracle until each
module passes the golden-corpus parity gate.

## Status

| Module | Rust | Parity |
|---|---|---|
| ASM2d components / processes / stoichiometry / rates | complete | CSTR 24 h exact (`tests/asm2d_parity.rs`) |
| ASM2d CSTR | complete | exact, `<=1e-12` |
| aeration / DO PI | complete | unit tests; network parity pending |
| ASM2d aggregate mapping | complete | unit-level mapping |
| ASM2d network (5-pool slice) | complete for the 5-pool A²/O fixture | 48 h exact all 19 components / 5 reactors (`tests/network_parity.rs`) |
| ASM1 / Takács / ADM1 / hydraulics | not started | — |
| server / AI / CLI | not started | — |

The exact CSTR fixture is `golden/asm2d-cstr-24h.json`, generated from
`src/sim/asm2d.ts`. The network fixture is `golden/asm2d-network-48h.json`,
covering 5 reactors, 1546 m³/h feed, 454 m³/h RAS, 48 h at 0.5 h steps. It
locks the fixed edge-flow table, the corrected external X_S fraction (0.65) and
the NH4-only external N mapping (`S_NH4=nh`, not TN) that made the TypeScript
and Rust paths diverge.

## Commands

```bash
cargo test
cargo clippy --all-targets -- -D warnings
cargo run -p aquapilot-core --example cstr
cargo run -p aquapilot-core --example network
```

Rules: no `unsafe`; no floating-point tolerance loosening; every module gets a
Rust unit test and a TS-golden parity test.
