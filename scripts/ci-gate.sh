#!/usr/bin/env bash
# 与 .github/workflows/ci.yml 等价的本地门禁。可在任意平台执行。
set -euo pipefail

step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }
pass() { printf '\033[1;32m  PASS\033[0m %s\n' "$1"; }
fail() { printf '\033[1;31m  FAIL\033[0m %s\n' "$1"; exit 1; }

step "1/7 依赖一致性 (package-lock)"
[ -f package-lock.json ] || fail "缺少 package-lock.json"
npm ci --prefer-offline --no-audit --no-fund > /dev/null 2>&1 || fail "npm ci 失败"
pass "依赖安装成功"

step "2/7 TypeScript 严格检查"
npm run typecheck > /dev/null 2>&1 && pass "0 错误" || fail "类型检查失败"

step "3/8 严格未使用检查"
npx tsc --noEmit --noUnusedLocals --noUnusedParameters > /dev/null 2>&1 && pass "无未使用代码" || fail "存在未使用变量/导入"

step "4/8 单元测试"
npx vitest run --reporter=json --outputFile=test-results.json > /dev/null 2>&1 || true
TOTAL=$(node -e "console.log(require('./test-results.json').numTotalTests)")
PASSED=$(node -e "console.log(require('./test-results.json').numPassedTests)")
rm -f test-results.json
[ "$PASSED" -eq "$TOTAL" ] && pass "$PASSED/$TOTAL 通过" || fail "$PASSED/$TOTAL，存在失败"
[ "$TOTAL" -ge 160 ] && pass "测试数量 $TOTAL ≥ 160" || fail "测试数量 $TOTAL 低于下限 160"

step "5/8 构建"
npm run build > /dev/null 2>&1 && pass "客户端与服务端构建成功" || fail "构建失败"
[ -f dist/client/index.html ] || fail "缺少客户端产物"
[ -f dist/server/index.mjs ] || fail "缺少服务端产物"
pass "产物齐全"

step "6/8 生产服务器冒烟测试"
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

step "7/8 密钥与产物扫描"
# 排除定义扫描规则的文件（否则规则字符串会命中自己）
if git grep -qIE '(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})' -- .      ':(exclude)package-lock.json'      ':(exclude).github/workflows/ci.yml'      ':(exclude)scripts/ci-gate.sh'      ':(exclude).workflow/aquapilot-ci.yml' 2>/dev/null; then
  fail "源码中发现疑似令牌"
fi
pass "无硬编码令牌"
if [ -n "$(git ls-files dist out node_modules 2>/dev/null | head -1)" ]; then
  fail "构建产物被提交"
fi
pass "构建产物未入库"

step "8/8 工程卫生"
[ -f LICENSE ] || fail "缺少 LICENSE"
[ -f README.md ] || fail "缺少 README.md"
[ -f README.zh-CN.md ] || fail "缺少中文 README"
[ -f .github/workflows/ci.yml ] || fail "缺少 CI 工作流"
[ -f .gitignore ] || fail "缺少 .gitignore"
pass "必要文件齐全"

printf '\n\033[1;42m  CI GATE: ALL GREEN  \033[0m\n'
printf '  typecheck  0 errors\n'
printf '  tests      %s/%s\n' "$PASSED" "$TOTAL"
printf '  build      client + server\n'
printf '  smoke      3 endpoints OK\n\n'
