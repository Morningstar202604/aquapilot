# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- CI configuration for GitHub Actions, Gitee Go and GitCode
- Local quality gate (`npm run ci`) mirroring CI in eight steps
- Regression tests for input validation and crash boundaries (15)
- Production-path AI tests running against the deployed engine (11)

### Changed
- `tsconfig` now enforces `noUnusedLocals` and `noUnusedParameters`

## [0.1.0] — 2026-10-21

### Added
- Topology-driven simulation engine: reactor count and order derive from the
  flowsheet rather than being hard-coded
- ASM1 implementation (13 components, 8 processes) with stoichiometry derived
  from parameters; nitrogen and alkalinity conservation verified to machine
  precision
- Takács ten-layer secondary clarifier, calibrated against BSM1-scale operating
  points for effluent suspended solids and solids loading
- AI operator: rolling 4-hour forecast, candidate scoring on compliance margin,
  cost and stability, hard guardrails on dissolved oxygen, PAC dose and SRT
- Control-room UI: SVG flowsheet with three lanes, live trends, decision
  explanations, scenario injection
- Visual flowsheet editor with structural and run-readiness validation
- Eight scenarios: storm, shock load, toxicity, blower failure, RAS failure,
  power outage, winter, chemical shortage

### Security
- Runtime validation on every inbound client message
- Path-traversal rejection in static file serving
- WebSocket origin allowlist, payload cap and heartbeat
- Crash boundaries around the tick loop and message handler
