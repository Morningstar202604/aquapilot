# AquaPilot Work Log

## Current milestone

- [x] M0 Rust workspace, ASM2d CSTR + 5-pool network parity
- [x] M1 ASM1 reaction surface (13 components, 8 processes, 20/15 C parity)
- [ ] M1 ASM1 CSTR / network integration
- [ ] M1 Takács settler parity
- [ ] M1 ADM1 parity
- [ ] M1 hydraulics / transport parity
- [ ] WP2 30 d COD/N/P balance closure
- [ ] M2 Rust server / AI / CLI
- [ ] M3 frontend / industrial acceptance
- [ ] M4 optional zero-TypeScript migration

## Latest verifiable state

- `cargo test`: 8 unit + ASM1 parity 2 + CSTR parity 1 + network parity 1, all pass
- `cargo clippy --all-targets -- -D warnings`: clean
- `npx vitest run`: 1616 passed / 1617; one WP2 30 d balance failure
- Latest commits: `26e8ccc`, `22b405c`, `b988495`
- Working tree clean; no branch, no push

## Rule

Every turn must land a code/test/golden commit or explicitly record a blocker;
do not repeat the same probe without a code change.

## 2026-11-24 repository delivery

- [x] Concise English/Chinese README, screenshots and demo linked
- [x] Five-platform main synced; all side branches removed
- [x] GitHub descriptions, topics, auto-merge, delete-branch-on-merge and main protection enabled
- [x] Gitee/GitCode descriptions, main branch and merge settings set
- [x] Docs consistency tests repaired
- [ ] WP2 30 d COD/N/P balance closure (remaining red CI gate)
