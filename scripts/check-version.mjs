#!/usr/bin/env node
/**
 * 版本一致性检查。
 *
 * 一个仓库里「版本号」出现在四处：package.json、CITATION.cff、
 * CHANGELOG 的最新一节、以及发布 tag。任何两处不一致，读者都会
 * 看到「README 说 0.5.0、安装出来是 0.4.0」这类割裂。
 * release.yml 的 verify-tag job 只查 tag 与 package.json；
 * 这个脚本把另外两处也纳入，本地 `npm run ci` 一起跑。
 *
 * 用法：
 *   node scripts/check-version.mjs                # 一致性检查
 *   node scripts/check-version.mjs --fix-cff     # 把 CITATION.cff 对齐到 package.json
 */

import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const version = pkg.version;

const fail = (msg) => {
  console.error(`::error::${msg}`);
  process.exit(1);
};

// ---- package.json ---------------------------------------------------------
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  fail(`package.json version "${version}" 不是三段式 semver（major.minor.patch）`);
}

// ---- CITATION.cff ----------------------------------------------------------
const cff = readFileSync('CITATION.cff', 'utf8');
const cffVersion = cff.match(/^version:\s*"?([^"\n]+)"?\s*$/m)?.[1];
const cffDate = cff.match(/^date-released:\s*"?([^"\n]+)"?\s*$/m)?.[1];

if (process.argv.includes('--fix-cff')) {
  if (cffVersion !== version || !cffDate) {
    const today = new Date().toISOString().slice(0, 10);
    const updated = cff
      .replace(/^version:\s*"?[^"\n]+"?\s*$/m, `version: "${version}"`)
      .replace(/^date-released:\s*"?[^"\n]+"?\s*$/m, `date-released: "${today}"`);
    writeFileSync('CITATION.cff', updated);
    console.log(`CITATION.cff 已对齐到 ${version} / ${today}`);
  } else {
    console.log('CITATION.cff 已是一致，无需修改');
  }
}

const cffAfter = readFileSync('CITATION.cff', 'utf8');
const cffVersionAfter = cffAfter.match(/^version:\s*"?([^"\n]+)"?\s*$/m)?.[1];
if (cffVersionAfter !== version) {
  fail(`CITATION.cff version "${cffVersionAfter}" 与 package.json "${version}" 不一致（运行 node scripts/check-version.mjs --fix-cff 可自动对齐）`);
}

// ---- CHANGELOG --------------------------------------------------------------
const changelog = readFileSync('CHANGELOG.md', 'utf8');
// 最新一节必须是 `## [x.y.z] — 日期` 或 `## [Unreleased]`；发布时 Unreleased 必须为空
const headings = [...changelog.matchAll(/^## \[([^\]]+)\](?: — ([^\n]+))?$/gm)];
if (headings.length === 0) fail('CHANGELOG.md 里没有任何 `## [版本]` 标题');

const [first] = headings;
const isUnreleased = first[1] === 'Unreleased';
if (isUnreleased) {
  // 允许存在 Unreleased，但下面必须还有一节带日期的正式版本
  const dated = headings.find((h) => h[1] !== 'Unreleased' && h[2]);
  if (!dated) fail('CHANGELOG.md 只有 [Unreleased]，没有任何带日期的正式版本节');
  console.log(`CHANGELOG 顶部是 [Unreleased]（上一版 ${dated[1]}），未发布状态——允许，但发布前请把它改成版本号`);
} else {
  if (!first[2]) fail(`CHANGELOG 顶部节 [${first[1]}] 缺少日期（格式：## [${first[1]}] — YYYY-MM-DD）`);
  if (first[1] !== version) {
    fail(`CHANGELOG 顶部节 [${first[1]}] 与 package.json "${version}" 不一致。发版步骤：改 package.json → 把 Unreleased 改成版本号与日期`);
  }
}

// ---- 版本号与历史节不许倒序 ---------------------------------------------------
const semverOf = (v) => v.split('.').map(Number);
for (let i = 1; i < headings.length; i += 1) {
  const a = headings[i - 1][1];
  const b = headings[i][1];
  if (a === 'Unreleased' || b === 'Unreleased') continue;
  const [amaj, amin, apat] = semverOf(a);
  const [bmaj, bmin, bpat] = semverOf(b);
  const newer = amaj > bmaj || (amaj === bmaj && amin > bmin) || (amaj === bmaj && amin === bmin && apat > bpat);
  const same = amaj === bmaj && amin === bmin && apat === bpat;
  if (!newer || same) fail(`CHANGELOG 版本顺序错误：[${a}] 必须严格新于 [${b}]`);
}

console.log(`版本一致性通过：package.json=${version}，CITATION.cff=${cffVersionAfter}，CHANGELOG 顶部=[${first[1]}]`);
