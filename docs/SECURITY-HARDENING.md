# Security hardening log

Findings closed in the 0.9.0 cycle, with the reproduction that proved each one and
the test that keeps it closed. Every entry was verified against a running server or
a negative control (the test fails on the pre-fix code); nothing here is a
"looks safer" change.

## 1. API path detection could be walked past (`js/user-controlled-bypass`)

**Finding.** `pathnameOf()` only stripped the query string, and `isApiPath()` did a
case-sensitive prefix test. `//api/snapshot`, `/API/snapshot` and `/x/../api/snapshot`
therefore did *not* match the API branch and fell through to the static handler,
which returned the SPA shell with HTTP 200.

**Impact.** No data leaked (verified: the body was the 1417-byte `index.html`, not
JSON), but any client calling `fetch('/api/...')` with a doubled slash receives HTML
and fails with a JSON parse error unrelated to the real cause. More importantly, the
auth gate is keyed on the same predicate, so the boundary depended on how the
upstream normalises paths.

**Fix.** `pathnameOf()` now collapses repeated slashes, resolves `.`/`..` segments and
refuses to climb above the root; `isApiPath()` compares case-insensitively.

**Reproduction (before → after).**

```text
//api/snapshot   200 HTML(SPA shell)  →  401 {"error":"...","authRequired":true}
/API/snapshot   200 HTML(SPA shell)  →  401 {"error":"...","authRequired":true}
///api/metrics  200 HTML(SPA shell)  →  401 {"error":"...","authRequired":true}
```

**Tests.** `tests/httpRoutes.test.ts` — 7 new cases (slash folding, dot segments,
case-insensitivity, root-escape clamp).

## 2. Prototype pollution through topology ids (`js/remote-property-injection`)

**Finding.** `sanitizeUnit()` / `sanitizeConnection()` accepted any non-empty string
up to 64 characters as an id. Ids become object keys (`positions[id]`, `routes[connId]`,
`delete positions[id]`), so `__proto__`, `constructor` and `prototype` were accepted
into the runtime graph.

**Fix.** `isSafeId()` enforces `/^[a-z0-9][a-z0-9_-]{0,63}$/` and rejects the three
reserved words (case-insensitive). Applied to unit ids, port ids and connection ids.

**Negative control.** Mutating the real `PLANT_TOPOLOGY` (only the id and its
references) is accepted by the old validator and rejected by the new one:

```text
"__proto__"   -> ACCEPTED (BAD)   |  rejected
"constructor" -> ACCEPTED (BAD)   |  rejected
"prototype"   -> ACCEPTED (BAD)   |  rejected
"a b"         -> ACCEPTED (BAD)   |  rejected
```

**Tests.** `tests/topologyInputSecurity.test.ts` — 7 cases. With the old validator
restored, 3 of them fail; with the fix, all pass.

## 3. Dynamic `delete` on client-side maps (`js/remote-property-injection`)

**Finding.** `delete llmPending.current[msg.requestId]` in eight places, and
`delete positions[id]` / `delete routes[connectionId]` in the topology editor. The
keys are server-supplied or document-supplied.

**Fix.** `safeDelete()` (`src/model/topologyEdit.ts`) and `dropPending()`
(`src/client/hooks/useSimulation.ts`) only delete own properties and refuse the three
reserved words. Two remaining CodeQL hits (`ProcessEditor.positions[newId]`,
`UnitInspector.CONTROL_BOUNDS[key]`) were checked and are not injection surfaces:
`nextId()` builds `kind + integer` locally, and `tickets` is filtered from the
compile-time `CONTROL_BOUNDS` table. Both sites now carry that reasoning inline.

**Tests.** `tests/topologyEditSecurity.test.ts` — 6 cases, including a check that
`Object.prototype` is untouched after passing `__proto__` to `deleteUnits`.

## 4. TOCTOU between `stat` and `readFile` (`js/file-system-race`)

**Finding.** `serveStatic()` called `stat()` and then `readFile()` as two separate
operations. Between them the path could be replaced with a directory, a FIFO or a
symlink pointing elsewhere.

**Fix.** One `open()` handle now serves both calls: `handle.stat()` confirms the type,
`handle.readFile()` reads from the same descriptor, and the handle is closed in
`finally`. The descriptor cannot be retargeted while it is open.

**Tests.** `tests/staticFiles.test.ts` — existing 14 cases still pass (serving,
fallback, 404, 403, gzip cache, conditional requests).

## 5. Terminal escape injection in the live-topology script (`js/log-injection`)

**Finding.** `scripts/e2e-topology-live.ts` printed server broadcast text directly.
The server embeds user-controlled strings (topology name, scenario name, error
detail) into notices, so a forged notice containing `ESC[2J` could clear the screen
and make a failing run look like a passing one.

**Fix.** A `safe()` wrapper strips C0 control characters and folds CR/LF before
anything reaches the console.

**Verification.** `"正常<ESC>[2J伪造通过<CR>覆盖"` becomes
`"正常?[2J伪造通过 覆盖"`.

## Not changed, and why

- **Shared tokens, not named accounts.** Three-tier tokens (`viewer` / `operator` /
  `admin`) give role separation but no per-user audit trail beyond the role string
  stored with each verdict. Named identities need a user store and a session model —
  a product decision recorded in `docs/COMPETITIVE-ANALYSIS.md`, not a bug.
- **No OPC UA / Modbus.** Out of scope; requires an industrial security assessment.
- **`delete next.routes`.** A static property name, not a remote key.
