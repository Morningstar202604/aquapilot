#!/usr/bin/env node
/**
 * 文档可见性检查。
 *
 * 两类只在渲染时才暴露的问题，靠肉眼 review 抓不住：
 *
 * 1. **不可见控制字符**：README / CHANGELOG 里混入 BEL(0x07) 时，终端与
 *    GitHub 都会渲染成乱码方块。它由「把 \a 当转义写进文档」引入过两次，
 *    而 diff 看起来完全正常。
 * 2. **被转义吃掉的路径分隔符**：`dist\aquapilot.exe` 里的 `\a` 被解释成
 *    BEL 后，剩下的文本会变成 `distquapilot.exe`；只删控制字符又会留下
 *    `distaquapilot.exe`。两种形态都不是可用路径。
 *
 * 退出码非零即视为门禁失败。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const problems = [];

function checkFile(path) {
  const text = readFileSync(path, 'utf8');
  const control = [];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 32 && code !== 10 && code !== 13 && code !== 9) {
      control.push(`0x${code.toString(16).padStart(2, '0')}`);
    }
  }
  if (control.length > 0) {
    problems.push(`${path}: 含不可见控制字符 ${control.slice(0, 3).join(', ')}`);
  }
}

const rootDocs = readdirSync('.').filter((f) => f.endsWith('.md'));
const docsDir = readdirSync('docs').filter((f) => f.endsWith('.md'));
for (const f of rootDocs) checkFile(f);
for (const f of docsDir) checkFile(join('docs', f));

// README 的 exe 路径：必须带分隔符
for (const f of ['README.md', 'README.zh-CN.md']) {
  const text = readFileSync(f, 'utf8');
  if (/dist(quapilot|aquapilot)\.exe/.test(text)) {
    problems.push(`${f}: exe 路径缺少分隔符（distquapilot.exe / distaquapilot.exe）`);
  }
  if (!/dist[\/]aquapilot\.exe/.test(text)) {
    problems.push(`${f}: 未找到 dist/aquapilot.exe 路径`);
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('docs clean: no control characters, exe paths intact');
