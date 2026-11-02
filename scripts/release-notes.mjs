#!/usr/bin/env node
/**
 * 提取 CHANGELOG 最新一节的正文，供 release workflow 作为发布说明。
 *
 * 为什么需要：release.yml 曾用 `body_path: CHANGELOG.md`，那会把**整份**
 * 更新日志（900+ 行、从 0.2.0 到现在）塞进 GitHub Release 正文——
 * 用户要翻到底部才能看到这个版本改了什么。
 *
 * 规则：
 * - 顶部节是 `[Unreleased]` 时报错退出：发布说明必须来自一个有版本号的小节
 * - 输出到 stdout，workflow 里重定向到文件
 */

import { readFileSync } from 'node:fs';

const changelog = readFileSync('CHANGELOG.md', 'utf8');
const headings = [...changelog.matchAll(/^## \[([^\]]+)\][^\n]*$/gm)];

if (headings.length === 0) {
  console.error('::error::CHANGELOG.md 中没有版本小节');
  process.exit(1);
}
const [first] = headings;
if (first[1] === 'Unreleased') {
  console.error('::error::CHANGELOG 顶部是 [Unreleased]；发布前请先把它改写成版本号小节');
  process.exit(1);
}

const start = first.index + first[0].length;
const end = headings[1] ? headings[1].index : changelog.length;
const body = changelog.slice(start, end).trim();

if (!body) {
  console.error(`::error::[${first[1]}] 小节是空的，没有可发布的说明`);
  process.exit(1);
}

process.stdout.write(`# ${first[1]}\n\n${body}\n`);
