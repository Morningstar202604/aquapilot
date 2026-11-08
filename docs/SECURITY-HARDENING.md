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

## 6. 0.9.0 复审：CodeQL 21 → 0 open

第二轮复核把 21 条 open 告警逐条走完。结果分两类，两类都留下了可复查的依据。

### 6.1 结构性修复（代码真的改了）

| 规则 | 位置 | 处理 |
|---|---|---|
| `js/path-injection` | `staticFiles.ts` | 改为 `resolveStaticPath()`：按段白名单重建路径，点段与非 `[A-Za-z0-9._~-]` 字符直接判为不可服务。不存在"拼好再判断"的窗口。 |
| `js/file-system-race` | `staticFiles.ts` | `lstat` 先拒符号链接与非常规文件，再用单一句柄 `fstat + readFile`；句柄关闭在 `finally`。 |
| `js/remote-property-injection` | `topologyEdit.ts` | `deleteUnits` / `setRoute` 改用 `Object.fromEntries` 重建，不再 `delete obj[dynamicKey]`。 |
| `js/remote-property-injection` | `useSimulation.ts` | `llmPending` 由普通对象改为 `Map`，动态删除不接触原型链。 |
| `js/remote-property-injection` | `UnitInspector.tsx` | 迭代方向反转：遍历编译期常量表 `CONTROL_BOUNDS`，用单元声明的清单过滤。 |
| `js/remote-property-injection` | `ProcessEditor.tsx` | `positions` 用 `Object.fromEntries` 追加，不再对动态键赋值。 |
| `js/log-injection` | `e2e-topology-live.ts` | 脚本不再打印任何服务端字符串：只输出计数与固定小数位数值。 |
| `js/user-controlled-bypass` | `index.ts` | 鉴权改为默认拒绝结构 `isApiPath(pathname) && !isPublicApiPath(pathname)`；`isPublicApiPath` 是两条常量集合，大小写统一。 |

### 6.2 判定为误报（已在平台上以理由关闭）

关闭时逐条写明依据，不是静默忽略：

- **`user-controlled-bypass` ×3**：`pathnameOf()` 折叠重复斜杠、解析点段、夹住根目录；`isApiPath()` 大小写不敏感；公开端点是两条常量。用真实服务验证：无令牌访问 `/api/snapshot`、`//api/snapshot`、`/API/snapshot` 均为 401，带令牌均为 200。
- **`file-system-race`**：路径由白名单重建 + `realpath` + `lstat` 三重约束，读用已打开句柄；`tests/staticFiles.test.ts` 覆盖穿越、软链逃逸与畸形编码。
- **`log-injection`**：该行只插值数字（计数与字符长度合计），所有服务端文本已在 0.9.0 移除。
- **`remote-property-injection`**：`newId` 由 `nextId()` 本地生成（`kind` + 递增整数），且已改为 `Object.fromEntries` 构造。

### 6.3 反证记录

- 软链逃逸：临时禁用 `realpath` 校验后，测试能读到根目录外的 `TOP SECRET`；启用后返回 403。
- 原型污染：把 `isSafeId` 换回旧的长度校验，3 条测试变红；恢复后全绿。
- 状态写入：把 mutator 换回「直接改 state 快照」，`controlHandler` 测试变红。
- 文档门禁：注入 BEL 字符后 `node scripts/check-docs.mjs` 退出码 1。
