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
| ASM1 components / stoich / rates / reaction | complete | 20 °C and 15 °C exact (`tests/asm1_parity.rs`) |
| ASM1 CSTR / network integration | complete for the 5-tank slice | 24 h CSTR + 48 h network exact, `<=1e-12` (`tests/asm1_network_parity.rs`) |
| Takács 10-layer clarifier | complete for the BSM1 slice | 24 h profile exact within 64 f64 ulps (`tests/takacs_parity.rs`) |
| ADM1 / hydraulics | not started | — |
| server / AI / CLI | not started | — |

The ASM1 fixture is `golden/asm1-reaction.json` (20 °C and 15 °C reaction vectors).
The exact CSTR fixtures are `golden/asm2d-cstr-24h.json` and
`golden/asm1-cstr-24h.json`; the ASM1 network fixture is
`golden/asm1-network-48h.json`, generated from `src/sim/asm1Network.ts`.
The ASM2d network fixture is `golden/asm2d-network-48h.json`, covering 5 reactors,
1546 m³/h feed, 454 m³/h RAS, 48 h at 0.5 h steps. It locks the fixed edge-flow
table, the corrected external X_S fraction (0.65) and the NH4-only external N
mapping (`S_NH4=nh`, not TN) that made the TypeScript and Rust paths diverge.
The Takács fixture is `golden/takacs-24h.json`: 1500 m², 4 m depth, 10 layers,
18446 m³/d feed at 3000 g/m³, 3850 m³/d underflow, 24 h at 1 h steps.

## Commands

```bash
cargo test
cargo clippy --all-targets -- -D warnings
cargo run -p aquapilot-core --example cstr
cargo run -p aquapilot-core --example network
```

Rules: no `unsafe`; no floating-point tolerance loosening; every module gets a
Rust unit test and a TS-golden parity test.
