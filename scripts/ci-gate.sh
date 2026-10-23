#!/usr/bin/env bash
# 与 .github/workflows/ci.yml 等价的本地门禁。可在任意平台执行。
set -euo pipefail

step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }
pass() { printf '\033[1;32m  PASS\033[0m %s\n' "$1"; }
fail() { printf '\033[1;31m  FAIL\033[0m %s\n' "$1"; exit 1; }

step "1/9 依赖一致性 (package-lock)"
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

step "2/9 TypeScript 严格检查"
npm run typecheck > /dev/null 2>&1 && pass "0 错误" || fail "类型检查失败"

step "3/9 严格未使用检查"
npx tsc --noEmit --noUnusedLocals --noUnusedParameters > /dev/null 2>&1 && pass "无未使用代码" || fail "存在未使用变量/导入"

step "4/9 单元测试 + 覆盖率"
npx vitest run --coverage --reporter=json --outputFile=test-results.json > /tmp/coverage.log 2>&1 || {
  tail -20 /tmp/coverage.log
  fail "测试或覆盖率未达标"
}
grep -E "All files" /tmp/coverage.log | head -1
TOTAL=$(node -e "console.log(require('./test-results.json').numTotalTests)")
PASSED=$(node -e "console.log(require('./test-results.json').numPassedTests)")
rm -f test-results.json
[ "$PASSED" -eq "$TOTAL" ] && pass "$PASSED/$TOTAL 通过" || fail "$PASSED/$TOTAL，存在失败"
[ "$TOTAL" -ge 300 ] && pass "测试数量 $TOTAL ≥ 300" || fail "测试数量 $TOTAL 低于下限 300"

step "5/9 构建"
npm run build > /dev/null 2>&1 && pass "客户端与服务端构建成功" || fail "构建失败"
[ -f dist/client/index.html ] || fail "缺少客户端产物"
[ -f dist/server/index.mjs ] || fail "缺少服务端产物"
pass "产物齐全"

step "6/9 生产服务器冒烟测试"
PORT=5180 node dist/server/index.mjs > /tmp/ci-smoke.log 2>&1 &
SMOKE_PID=$!
trap 'kill $SMOKE_PID 2>/dev/null || true' EXIT
OK=0
for _ in $(seq 1 30); do
  if curl -sf http://127.0.0.1:5180/api/snapshot > /dev/null 2>&1; then OK=1; break; fi
  sleep 1
done
[ "$OK" -eq 1 ] || { cat /tmp/ci-smoke.log; fail "服务器未在 30 秒内就绪"; }
curl -sf http://127.0.0.1:5180/api/snapshot | grep -q '"effluent"' || fail "snapshot API 返回异常"
curl -sf http://127.0.0.1:5180/api/topology | grep -q '"topology"' || fail "topology API 返回异常"
curl -sf http://127.0.0.1:5180/ | grep -q '<div id="root">' || fail "静态首页异常"
kill $SMOKE_PID 2>/dev/null || true
trap - EXIT
pass "三个端点均正常"

step "7/9 密钥与产物扫描"
# 排除定义扫描规则的文件（否则规则字符串会命中自己）
if git grep -qIE '(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})' -- .      ':(exclude)package-lock.json'      ':(exclude).github/workflows/ci.yml'      ':(exclude)scripts/ci-gate.sh'      ':(exclude).workflow/aquapilot-ci.yml' 2>/dev/null; then
  fail "源码中发现疑似令牌"
fi
pass "无硬编码令牌"
if [ -n "$(git ls-files dist out node_modules 2>/dev/null | head -1)" ]; then
  fail "构建产物被提交"
fi
pass "构建产物未入库"

step "8/9 依赖安全审计"
# 镜像源（npmmirror）不实现 audit 接口，会返回 NOT_IMPLEMENTED。
# 这里显式指定官方源；若网络不可达，则明确标记"未审计"而不是假装通过。
if AUDIT_OUT=$(npm audit --registry=https://registry.npmjs.org --audit-level=high 2>&1); then
  pass "0 高危漏洞"
elif printf '%s' "$AUDIT_OUT" | grep -qE "ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|network|SSL|TLS|dh key too small|audit endpoint returned an error"; then
  printf '[1;33m  SKIP[0m 依赖审计（官方源不可达，未验证）
'
else
  printf '%s
' "$AUDIT_OUT" | tail -10
  fail "存在高危依赖漏洞"
fi

step "9/9 工程卫生"
[ -f LICENSE ] || fail "缺少 LICENSE"
[ -f README.md ] || fail "缺少 README.md"
[ -f README.zh-CN.md ] || fail "缺少中文 README"
[ -f .github/workflows/ci.yml ] || fail "缺少 CI 工作流"
[ -f .gitignore ] || fail "缺少 .gitignore"
[ -f CODE_OF_CONDUCT.md ] || fail "缺少 CODE_OF_CONDUCT.md"
[ -f .env.example ] || fail "缺少 .env.example"
[ -f Dockerfile ] || fail "缺少 Dockerfile"
[ -f docs/API.md ] || fail "缺少 docs/API.md"
pass "必要文件齐全"

printf '\n\033[1;42m  CI GATE: ALL GREEN  \033[0m\n'
printf '  typecheck  0 errors\n'
printf '  tests      %s/%s\n' "$PASSED" "$TOTAL"
printf '  build      client + server\n'
printf '  smoke      3 endpoints OK\n\n'
