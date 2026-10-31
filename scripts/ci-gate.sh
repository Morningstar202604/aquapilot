#!/usr/bin/env bash
# 与 .github/workflows/ci.yml 等价的本地门禁。可在任意平台执行。
set -euo pipefail

# npm run 继承用户级 allow-scripts 环境变量时，npm ci 会把它当作 CLI 策略并拒绝项目安装；项目级 allowScripts 已在 package.json 明确声明。
unset npm_config_allow_scripts NPM_CONFIG_ALLOW_SCRIPTS

GATE_TMP=.tmp/ci-gate
rm -rf "$GATE_TMP"
mkdir -p "$GATE_TMP"
printf 'registry=%s\n' "$(npm config get registry)" > "$GATE_TMP/npmrc-clean"
export NPM_CONFIG_USERCONFIG="$PWD/$GATE_TMP/npmrc-clean"
cleanup() {
  if [ -n "${SMOKE_PID:-}" ] && kill -0 "$SMOKE_PID" 2>/dev/null; then
    kill "$SMOKE_PID" 2>/dev/null || true
  fi
  rm -rf "$GATE_TMP"
}
trap cleanup EXIT

step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }
pass() { printf '\033[1;32m  PASS\033[0m %s\n' "$1"; }
fail() { printf '\033[1;31m  FAIL\033[0m %s\n' "$1"; exit 1; }

step "1/10 依赖一致性 (package-lock)"
[ -f package-lock.json ] || fail "缺少 package-lock.json"
CI_OUT=$(npm ci --prefer-offline --no-audit --no-fund 2>&1) && pass "依赖安装成功" || {
  printf '%s
' "$CI_OUT" | tail -20
  if printf '%s' "$CI_OUT" | grep -q 'EPERM.*unlink'; then
    fail "npm ci 失败：node_modules 被占用（Windows 上常见于残留的 esbuild.exe / node 进程）。
        处理：先结束占用进程再重试——
          taskkill //F //IM esbuild.exe
          taskkill //F //IM node.exe   （会结束所有 node，包括正在运行的仿真服务）
        这不是代码问题，但必须清理后才能得到可信结果。"
  fi
  fail "npm ci 失败（见上方输出）"
}

step "2/10 TypeScript 严格检查"
npm run typecheck > /dev/null 2>&1 && pass "0 错误" || fail "类型检查失败"

step "3/10 严格未使用检查 + 格式"
npx tsc --noEmit --noUnusedLocals --noUnusedParameters > /dev/null 2>&1 && pass "无未使用代码" || fail "存在未使用变量/导入"
npm run format > /dev/null 2>&1 && pass "格式检查通过" || fail "格式检查失败"

step "4/10 单元测试 + 覆盖率"
npx vitest run --coverage --reporter=json --outputFile="$GATE_TMP/test-results.json" > "$GATE_TMP/coverage.log" 2>&1 || {
  tail -20 "$GATE_TMP/coverage.log"
  fail "测试或覆盖率未达标"
}
grep -E "All files" "$GATE_TMP/coverage.log" | head -1
TEST_COUNTS=$(node - <<'NODE'
const report = require('./.tmp/ci-gate/test-results.json');
const total = report.numTotalTests ?? 0;
const passed = report.numPassedTests ?? 0;
const failed = report.numFailedTests ?? 0;
const skipped = report.numPendingTests ?? 0;
const todo = report.numTodoTests ?? 0;
if (total < 300 || passed !== total || failed !== 0 || skipped !== 0 || todo !== 0) {
  console.error(JSON.stringify({ total, passed, failed, skipped, todo }));
  process.exit(1);
}
process.stdout.write(`${total} ${passed}`);
NODE
) || fail "测试报告存在失败、跳过、todo 或测试数量不足"
TOTAL=${TEST_COUNTS%% *}
PASSED=${TEST_COUNTS##* }
pass "$PASSED/$TOTAL 通过，0 失败/跳过/todo"

step "5/10 构建"
npm run build > /dev/null 2>&1 && pass "客户端与服务端构建成功" || fail "构建失败"
[ -f dist/client/index.html ] || fail "缺少客户端产物"
[ -f dist/server/index.mjs ] || fail "缺少服务端产物"
pass "产物齐全"

step "6/10 生产服务器冒烟测试"
PORT=5180 node dist/server/index.mjs > "$GATE_TMP/ci-smoke.log" 2>&1 &
SMOKE_PID=$!
OK=0
for _ in $(seq 1 30); do
  if curl -sf http://127.0.0.1:5180/api/snapshot > /dev/null 2>&1; then OK=1; break; fi
  sleep 1
done
[ "$OK" -eq 1 ] || { cat "$GATE_TMP/ci-smoke.log"; fail "服务器未在 30 秒内就绪"; }
curl -sf http://127.0.0.1:5180/api/snapshot | grep -q '"effluent"' || fail "snapshot API 返回异常"
curl -sf http://127.0.0.1:5180/api/topology | grep -q '"topology"' || fail "topology API 返回异常"
curl -sf http://127.0.0.1:5180/ | grep -q '<div id="root">' || fail "静态首页异常"
kill "$SMOKE_PID" 2>/dev/null || true
unset SMOKE_PID
pass "三个端点均正常"

step "7/10 密钥与产物扫描"
# 只抑制规则自身的文本，命中时绝不回显匹配行，避免把泄露值写入 CI 日志。
SECRET_PATTERN='(gh[pousr]_[A-Za-z0-9_\-]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|https?://[^/[:space:]@]+:[^@[:space:]]+@)'
if SECRET_SCAN=$(git grep -lIE "$SECRET_PATTERN" -- . 2>/dev/null); then
  :
else
  status=$?
  [ "$status" -eq 1 ] || fail "密钥扫描工具执行失败（退出码 $status）"
  SECRET_SCAN=''
fi
if [ -n "$SECRET_SCAN" ]; then
  printf '%s\n' "$SECRET_SCAN" | sed 's#^#疑似敏感文件：#'
  fail "源码中发现疑似凭据"
fi
pass "无硬编码令牌"
if ! TRACKED=$(git ls-files dist out node_modules 2>/dev/null); then
  fail "构建产物扫描工具执行失败"
fi
if [ -n "$TRACKED" ]; then
  printf '%s\n' "$TRACKED"
  fail "构建产物被提交"
fi
pass "构建产物未入库"

step "8/10 备份往返"
npx tsx scripts/backup-seed.ts "$GATE_TMP/seed.db"
npx tsx scripts/backup.ts create --db "$GATE_TMP/seed.db" --out "$GATE_TMP/snapshot.db" > /dev/null
npx tsx scripts/backup.ts restore --from "$GATE_TMP/snapshot.db" --db "$GATE_TMP/restored.db" --yes > /dev/null
npx tsx scripts/backup-seed.ts "$GATE_TMP/restored.db" --verify 5
pass "备份/恢复往返通过"

step "9/10 依赖安全审计"
# 镜像源（npmmirror）不实现 audit 接口，会返回 NOT_IMPLEMENTED。
# 这里显式指定官方源；若网络不可达，则明确标记"未审计"而不是假装通过。
if AUDIT_OUT=$(npm audit --registry=https://registry.npmjs.org --audit-level=high 2>&1); then
  pass "0 高危漏洞"
elif printf '%s' "$AUDIT_OUT" | grep -qE "ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|network|SSL|TLS|dh key too small|audit endpoint returned an error"; then
  printf '%s
' "$AUDIT_OUT" | tail -10
  fail "依赖审计无法连接官方服务，拒绝产生假绿"
else
  printf '%s
' "$AUDIT_OUT" | tail -10
  fail "存在高危依赖漏洞"
fi

step "10/10 工程卫生"
[ -f LICENSE ] || fail "缺少 LICENSE"
[ -f README.md ] || fail "缺少 README.md"
[ -f README.zh-CN.md ] || fail "缺少中文 README"
[ -f .github/workflows/ci.yml ] || fail "缺少 CI 工作流"
[ -f .gitignore ] || fail "缺少 .gitignore"
[ -f CODE_OF_CONDUCT.md ] || fail "缺少 CODE_OF_CONDUCT.md"
[ -f .env.example ] || fail "缺少 .env.example"
[ -f Dockerfile ] || fail "缺少 Dockerfile"
[ -f docs/API.md ] || fail "缺少 docs/API.md"
[ -f docs/RUNBOOK.md ] || fail "缺少 docs/RUNBOOK.md"
pass "必要文件齐全"

printf '\n\033[1;42m  CI GATE: ALL GREEN  \033[0m\n'
printf '  typecheck  0 errors\n'
printf '  tests      %s/%s\n' "$PASSED" "$TOTAL"
printf '  build      client + server\n'
printf '  smoke      3 endpoints OK\n\n'
