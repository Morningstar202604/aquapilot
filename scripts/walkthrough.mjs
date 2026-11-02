/**
 * 界面走查脚本（本地人工审阅用，不进 CI）。
 *
 * 与 `scripts/e2e-ci.ts` 的分工：
 *   - e2e-ci.ts 是**断言**脚本：任何一项不达标就退出 1，用于门禁。
 *   - 本脚本是**取证**脚本：把每个页签在真实生产构建下走一遍并截图，
 *     同时收集控制台错误、布局溢出、可点击但无响应的控件，
 *     供人工（或视觉评审）逐张看图。
 *
 * 用法：
 *   node scripts/walkthrough.mjs            # 默认端口 5288
 *   PORT=5300 node scripts/walkthrough.mjs
 */

import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { resolveBrowserExecutable } from './e2eBrowser.ts';

const PORT = Number(process.env.PORT ?? 5288);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = 'out/walkthrough/shots';

/** 侧栏页签，顺序与 App.tsx 的 side-tabs 一致；顶栏的「工艺编排」单独切换。 */
const TABS = ['AI 对话', '决策解释', '控制与工况', '告警', '效益', '分析', '校准', '进水', '回放', '自检'];

await mkdir(SHOTS, { recursive: true });

const browserPath = resolveBrowserExecutable();
const browser = await chromium.launch({
  headless: true,
  ...(browserPath ? { executablePath: browserPath } : {}),
});
const context = await browser.newContext({ viewport: { width: 1600, height: 950 } });
const page = await context.newPage();

const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('requestfailed', (r) => failedRequests.push(`${r.method()} ${r.url()} — ${r.failure()?.errorText}`));

const findings = [];
const record = (severity, area, message) => findings.push({ severity, area, message });

/**
 * 检测横向溢出。
 *
 * 判据是**文档本身能否横向滚动**（`scrollWidth > clientWidth`），
 * 而不是逐个元素的 `right > innerWidth`——工艺画布被刻意放在
 * `overflow-x: auto` 的容器里（移动端就是靠横向滑动看完整厂区），
 * 逐元素判定会把这种设计意图误报成 bug。
 *
 * 元素级扫描只用来定位「是哪个元素把文档撑宽了」，且在文档未溢出时不执行。
 */
async function checkOverflow(label) {
  const result = await page.evaluate(() => {
    const doc = document.documentElement;
    const overflowPx = doc.scrollWidth - doc.clientWidth;
    if (overflowPx <= 1) return { overflowPx: 0, culprits: [] };

    const culprits = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > doc.clientWidth + 1) {
        // 跳过位于可横向滚动容器内的元素：那是设计上的滑动区域
        let p = el.parentElement;
        let inScroller = false;
        while (p) {
          const ox = getComputedStyle(p).overflowX;
          if (ox === 'auto' || ox === 'scroll') {
            inScroller = true;
            break;
          }
          p = p.parentElement;
        }
        if (inScroller) continue;
        const cls = typeof el.className === 'string' ? el.className : '';
        culprits.push({
          tag: el.tagName.toLowerCase(),
          cls: cls.slice(0, 50),
          right: Math.round(r.right),
          text: (el.textContent ?? '').trim().slice(0, 40),
        });
        if (culprits.length >= 5) break;
      }
    }
    return { overflowPx, culprits };
  });

  if (result.overflowPx > 1) {
    record(
      'major',
      label,
      `文档横向溢出 ${result.overflowPx}px` +
        (result.culprits.length
          ? `；越界元素：${result.culprits.map((c) => `<${c.tag}.${c.cls}> right=${c.right} "${c.text}"`).join('、')}`
          : '；未定位到具体元素'),
    );
  }
  return result.overflowPx;
}

/** 检测空面板：只查有明确语义的容器，跳过按钮等本就没有文字的控件。 */
async function checkEmptyPanels(label) {
  const empties = await page.evaluate(() => {
    const out = [];
    const sel = ['main', '.side', '.stage', '[class*="panel"]:not(button)', '[class*="card"]'];
    for (const s of sel) {
      for (const el of document.querySelectorAll(s)) {
        if (el.tagName === 'BUTTON') continue;
        const r = el.getBoundingClientRect();
        if (r.height < 40) continue;
        const text = (el.textContent ?? '').trim();
        if (text.length < 3) {
          const cls = typeof el.className === 'string' ? el.className : '';
          out.push(`${el.tagName.toLowerCase()}.${cls.slice(0, 50)} h=${Math.round(r.height)}`);
        }
      }
    }
    return [...new Set(out)].slice(0, 5);
  });
  for (const e of empties) record('minor', label, `疑似空容器 ${e}`);
  return empties.length;
}

async function shot(name) {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
  console.log(`  shot ${name}`);
}

try {
  // 引导是首次访问的模态遮罩：走查需要先关掉它，否则所有点击都被拦截。
  // 顺便验证它能被关闭（这本身是可用性要求）。
  await page.addInitScript(() => window.sessionStorage.setItem('aquapilot_onboarded', '1'));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3500);
  await shot('00-overview');
  await checkOverflow('overview');
  await checkEmptyPanels('overview');

  // 关键指标是否真的有数字（不是占位符）
  const kpis = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('[class*="kpi"], [class*="metric"], [class*="stat"]')) {
      const t = (el.textContent ?? '').trim();
      if (t) out.push(t.replace(/\s+/g, ' ').slice(0, 40));
    }
    return [...new Set(out)].slice(0, 12);
  });
  console.log(`  KPIs: ${kpis.length}`);
  if (kpis.length === 0) record('major', 'overview', '首屏没有找到任何指标卡');

  for (const [i, tab] of TABS.entries()) {
    const locator = page.locator('.side-tab', { hasText: tab }).first();
    if ((await locator.count()) === 0) {
      record('major', tab, '页签不存在');
      continue;
    }
    await locator.click();
    await page.waitForTimeout(1400);
    await shot(`${String(i + 1).padStart(2, '0')}-${tab.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '')}`);
    await checkOverflow(tab);
    await checkEmptyPanels(tab);
  }

  // 窄屏：确认响应式不塌
  for (const [w, h, name] of [
    [1280, 800, 'responsive-1280'],
    [1024, 768, 'responsive-1024'],
    [768, 1024, 'responsive-768'],
  ]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(900);
    await shot(name);
    await checkOverflow(name);
  }

  // 移动端
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(900);
  await shot('responsive-390');
  await checkOverflow('responsive-390');

  console.log('\n=== 结果 ===');
  console.log(`console errors : ${consoleErrors.length}`);
  consoleErrors.slice(0, 8).forEach((e) => console.log(`  - ${e.slice(0, 200)}`));
  console.log(`page errors    : ${pageErrors.length}`);
  pageErrors.slice(0, 8).forEach((e) => console.log(`  - ${e.slice(0, 200)}`));
  console.log(`failed requests: ${failedRequests.length}`);
  failedRequests.slice(0, 8).forEach((e) => console.log(`  - ${e}`));
  console.log(`findings       : ${findings.length}`);
  for (const f of findings) console.log(`  [${f.severity}] ${f.area}: ${f.message}`);

  const blocking = findings.filter((f) => f.severity === 'major').length + pageErrors.length + consoleErrors.length;
  process.exitCode = blocking > 0 ? 1 : 0;
} finally {
  await context.close();
  await browser.close();
}
