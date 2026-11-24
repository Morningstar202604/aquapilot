# AquaPilot Rust core

This workspace is the M1 migration target. The TypeScript engine remains the
reference oracle until each module passes the golden-corpus parity gate.

Rules:
- no `unsafe`;
- no binary floating-point serialization assumptions in contracts;
- every module needs a Rust unit test and a parity test against `golden/`.
