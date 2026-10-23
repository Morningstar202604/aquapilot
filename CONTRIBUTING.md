# Contributing

## Before you start

```bash
npm ci
npm run ci        # must be green before any commit
```

`npm run ci` runs the same nine gates as CI: dependency install, type check,
unused-code check, tests with coverage thresholds, build, production smoke test,
secret scan, dependency audit, and repository hygiene (LICENSE, README,
CODE_OF_CONDUCT, `.env.example`, Dockerfile, API docs).

## Ground rules

- **No unreferenced constants.** Kinetic parameters live in `src/sim/kinetics.ts`,
  limit values in `src/sim/config.ts`. If you need a new constant, put it where
  its siblings are.
- **No silent failure.** Do not swallow errors with empty `catch` blocks, `|| true`
  or `2>/dev/null`. If a failure is genuinely acceptable, say so in a comment.
- **Tests assert physics, not implementation.** A test that restates the code it
  covers is not a test. Prefer assertions on conservation laws, monotonic
  responses, and bounds.
- **Document limits.** If something does not work, or works only under
  assumptions, write it in `docs/QUALITY-ROADMAP.md`.

## Environment

Copy [.env.example](.env.example) if you need to override defaults. Never commit
a real `.env`. `AQUAPILOT_TOKEN` is the only secret the server reads; leave it
empty for local work.

## Commit messages

Conventional commits, imperative mood, lowercase subject:

```
fix: reject non-finite control values from websocket clients
feat: add Takacs settler with solids flux limitation
docs: record why ASM1 integration failed on the first attempt
```

## Adding a process unit

1. Add the kind to `UnitKind` in `src/model/topology.ts`
2. Add ports and a default size
3. Add a palette entry in `ProcessEditor.tsx` if it should be placeable
4. Decide whether it participates in the reactor train or is a pass-through
5. Add a layout size in `src/model/layout.ts`
6. Write a test that proves it changes a solved quantity

## Reporting problems

Include the command you ran, the output, and what you expected. For simulation
issues, include the seed and the topology you used so the result is reproducible.
