# Open-source landscape and what AquaPilot borrowed

Query date: 2026-10-24. Star counts come from the GitHub REST API at that time and
will drift; they are recorded to show relative scale, not as a live metric.

## 1. Comparison matrix

| Project | Stars | License | Stack | Model depth | Live UI | AI operator | Topology editing | Benchmark gate |
|---|---:|---|---|---|---|---|---|---|
| **AquaPilot** | — | MIT | TypeScript / React / Node | ASM1 + Takács + BSM1 | Yes | Yes | Yes | BSM1 Table 6 in CI |
| [fau-evt/bsm2-python](https://github.com/fau-evt/bsm2-python) | 44 | BSD-3-Clause | Python | BSM1/BSM2, ADM1, energy management | No | No | No | BSM1/BSM2 reference values |
| [toogad/PooPyLab_Project](https://github.com/toogad/PooPyLab_Project) | 79 | GPL-3.0 | Python | ASM family, steady state | No | No | Diagram files | Unit tests |
| [modelica-3rdparty/WasteWater](https://github.com/modelica-3rdparty/WasteWater) | 75 | not declared | Modelica | Wastewater library | No | No | Modelica | No |
| [endearqb/AutoWaterSimu](https://github.com/endearqb/AutoWaterSimu) | 15 | NOASSERTION | Go + Python + React | ASM1 / ASM3 / UDM | Yes | Partial | Yes | Golden scenarios |
| [USEPA/Stormwater-Management-Model](https://github.com/USEPA/Stormwater-Management-Model) | 376 | not declared | C | Hydrology / hydraulics | Desktop | No | Network editor | Regression suite |

Sources: repository metadata fetched from `api.github.com` on 2026-10-24; README
content read for bsm2-python, PooPyLab and AutoWaterSimu.

## 2. What was borrowed, and why

### From bsm2-python

- **Benchmark-first credibility.** They publish reference comparisons for BSM1 and
  BSM2 and ship a DOI. AquaPilot already had a BSM1 test; this release makes the
  gate explicit and documents every residual.
- **PyPI-style distribution discipline.** Their install story is one line. AquaPilot
  keeps `npm ci && npm run build && npm start` and a Docker image.
- **What we did not take:** their plant layouts are fixed. AquaPilot's differentiator
  is that the layout is data.

### From PooPyLab

- **Process-flow-diagram-as-input.** PooPyLab lets users describe a plant and then
  solves it. That confirmed the "topology is the model" direction, which AquaPilot
  implements with a typed graph, port compatibility checks and a compile step.
- **What we did not take:** their steady-state focus. AquaPilot is dynamic by design.

### From modelica-3rdparty/WasteWater

- **Component libraries beat monoliths.** Their value is a catalogue of reusable
  process units. AquaPilot's palette (`ProcessEditor`) follows the same idea, with
  each unit declaring ports, states and allowed interventions.
- **What we did not take:** Modelica itself. A browser-first TypeScript engine keeps
  the demo runnable without a toolchain install.

### From AutoWaterSimu

- **Contract-first boundaries.** Their current mainline separates UI state, process
  topology, executable simulation input and artifacts with JSON Schema. AquaPilot
  has the same separation implicitly (`model/` → `sim/` → `shared/protocol.ts`);
  this release makes the protocol explicit and test-covered.
- **Evidence artifacts.** They store summaries in metadata and large series in
  artifact files. AquaPilot's SQLite snapshot table plus CSV/Markdown export is a
  smaller version of the same idea.

### From USEPA SWMM

- **Network editor ergonomics.** SWMM's longevity comes partly from letting engineers
  draw and validate a network quickly. AquaPilot's editor adds structural validation
  (ports, duplicate links, self loops) and run-readiness (no clarifier, no aerobic
  zone, unconnected train) as two separate gates.
- **What we did not take:** their hydrology scope. Different problem.

## 3. Anti-patterns observed in the landscape

| Anti-pattern | Seen in | AquaPilot's countermeasure |
|---|---|---|
| "Model is validated" with no numbers | Several small projects | BSM1 Table 6 test with per-metric deviation gates |
| UI that draws a flowsheet but solves a hard-coded plant | Commercial demos, some prototypes | Topology compiles to reactors; adding a tank changes the solve (`scripts/prove-network-solving.ts`) |
| AI claims without a baseline | Marketing pages | Shadow benchmark on identical influent and initial state |
| Single-point forecast presented as certainty | Most dashboards | Fixed-perturbation ensemble with explicit "not a statistical CI" wording |
| Silent degradation (persistence off, LLM down) | Common in demos | Visible status in UI and metrics; rule-engine fallback always answers |

## 4. Where AquaPilot is still behind

| Gap | Closest project that does it | Effort |
|---|---|---|
| BSM2 (anaerobic digestion, ADM1) | bsm2-python | Large; out of scope for a UI-first prototype |
| Design-grade calibration against measured plant data | Commercial tools | Requires data we do not have |
| Multi-plant / multi-tenant operation | AutoWaterSimu (workspace model) | Medium |
| Full ASM2d phosphorus | Research code | Medium; ASM1 + chemical P is documented as the current boundary |
| Published package (npm / PyPI) | bsm2-python | Small; packaging only |

## 5. References

- BSM1 technical report, IWA Task Group: <http://iwa-mia.org/wp-content/uploads/2019/04/BSM_TG_Tech_Report_no_1_BSM1_General_Description.pdf>
- BSM2 technical report: <https://iwaponline.com/ebooks/book-pdf/650794/wio9781780401171.pdf>
- fau-evt/bsm2-python: <https://github.com/fau-evt/bsm2-python>
- toogad/PooPyLab_Project: <https://github.com/toogad/PooPyLab_Project>
- modelica-3rdparty/WasteWater: <https://github.com/modelica-3rdparty/WasteWater>
- endearqb/AutoWaterSimu: <https://github.com/endearqb/AutoWaterSimu>
- USEPA Stormwater Management Model: <https://github.com/USEPA/Stormwater-Management-Model>
