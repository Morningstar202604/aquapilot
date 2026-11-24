# AquaPilot Rust core

M1 migration target. The TypeScript engine is the reference oracle until each
module passes the golden-corpus parity gate.

## Status

| Module | Rust | Parity |
|---|---|---|
| ASM2d components / processes / stoichiometry / rates | complete | CSTR 24 h exact (`tests/asm2d_parity.rs`) |
| ASM2d CSTR | complete | exact, `<=1e-12` |
| ASM2d aggregate mapping | complete | unit-level mapping |
| ASM2d network | partial (advection + reaction + RAS + supplemental processes) | finite/nonnegative smoke; no TS parity yet |
| ASM1 / Takács / ADM1 / hydraulics | not started | — |
| server / AI / CLI | not started | — |

The exact CSTR fixture is `golden/asm2d-cstr-24h.json`, generated from
`src/sim/asm2d.ts`.

## Commands

```bash
cargo test
cargo clippy --all-targets -- -D warnings
cargo run -p aquapilot-core --example cstr
```

Rules: no `unsafe`; no floating-point tolerance loosening; every module gets a
Rust unit test and a TS-golden parity test.
