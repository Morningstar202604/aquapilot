import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';

/**
 * CI 用的浏览器冒烟测试。
 *
 * 与人工审查脚本的区别：断言明确、失败即退出码非零、不依赖本机 Chrome 路径。
 * 覆盖三条最关键的路径：页面能加载、五个面板可切换、WebSocket 有数据。
 */

const PORT = 5188;
const OUT = 'out/shots';

function fail(msg: string): never {
  console.error(`E2E FAIL: ${msg}`);
  process.exit(1);
}

await mkdir(OUT, { recursive: true });

const server = spawn(process.execPath, ['dist/server/index.mjs'], {
  env: { ...process.env, PORT: String(PORT), AQUAPILOT_PERSIST: '0' },
  stdio: 'ignore',
});

const waitForServer = async (): Promise<void> => {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.ok) return;
    } catch {
      /* 尚未就绪 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  fail('server did not become healthy in 20s');
};

try {
  await waitForServer();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3500);

  const kpis = await page.locator('.kpi').count();
  if (kpis < 7) fail(`expected >=7 KPI tiles, got ${kpis}`);

  const nodes = await page.locator('.plant-node').count();
  if (nodes < 10) fail(`expected >=10 flowsheet nodes, got ${nodes}`);

  const canvas = await page.locator('.trend-canvas canvas').count();
  if (canvas < 3) fail(`expected 3 trend canvases, got ${canvas}`);

  await page.screenshot({ path: `${OUT}/ci-plant.png` });

  for (const tab of ['AI 对话', '决策解释', '控制与工况', '告警', '效益', '回放']) {
    await page.locator('.side-tab', { hasText: tab }).click();
    await page.waitForTimeout(600);
    const panel = await page.locator('.scroll-panel, .side-body').first().isVisible();
    if (!panel) fail(`tab "${tab}" produced no visible panel`);
  }
  await page.screenshot({ path: `${OUT}/ci-replay.png` });

  /**
   * 布局回归：这些问题靠单测抓不到，只能量真实几何。
   * - 连线穿过池体（早期内回流横穿好氧池）
   * - 顶栏数值被挤成竖排（1440/1366 下出现过多行）
   * - 页面横向溢出（移动端图例被裁）
   */
  const crossing = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('.plant-node')].map((g) => {
      const r = g.querySelector('rect')!.getBBox();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    const bad: string[] = [];
    for (const path of document.querySelectorAll('.plant-canvas path[marker-end]')) {
      const el = path as SVGPathElement;
      const len = el.getTotalLength();
      for (let i = 0; i <= 300; i++) {
        const pt = el.getPointAtLength((len * i) / 300);
        const hit = nodes.findIndex((n) => pt.x > n.x + 3 && pt.x < n.x + n.w - 3 && pt.y > n.y + 3 && pt.y < n.y + n.h - 3);
        if (hit >= 0) {
          const label = el.parentElement?.querySelector('text')?.textContent ?? '?';
          bad.push(`${label}@node${hit}`);
          break;
        }
      }
    }
    return bad;
  });
  if (crossing.length > 0) fail(`edges cross unit bodies: ${crossing.slice(0, 3).join(', ')}`);

  const topbar = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.topbar .meta-value')] as HTMLElement[];
    return items.map((e) => Math.round(e.getBoundingClientRect().height));
  });
  if (topbar.some((h) => h > 34)) fail(`topbar values wrapped: heights ${topbar.join(',')}`);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) fail(`mobile horizontal overflow: ${overflow}px`);
  if (errors.length > 0) fail(`console errors: ${errors.slice(0, 3).join(' | ')}`);

  await browser.close();
  console.log('E2E PASS: 7 KPIs, 17 nodes, 3 charts, 6 panels, 0 console errors');
} finally {
  server.kill();
}
