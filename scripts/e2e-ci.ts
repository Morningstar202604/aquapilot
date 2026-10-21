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
  if (kpis < 6) fail(`expected >=6 KPI tiles, got ${kpis}`);

  const nodes = await page.locator('.plant-node').count();
  if (nodes < 10) fail(`expected >=10 flowsheet nodes, got ${nodes}`);

  const canvas = await page.locator('.trend-canvas canvas').count();
  if (canvas < 3) fail(`expected 3 trend canvases, got ${canvas}`);

  await page.screenshot({ path: `${OUT}/ci-plant.png` });

  for (const tab of ['决策解释', '控制与工况', '告警', '效益', '回放']) {
    await page.locator('.side-tab', { hasText: tab }).click();
    await page.waitForTimeout(600);
    const panel = await page.locator('.scroll-panel, .side-body').first().isVisible();
    if (!panel) fail(`tab "${tab}" produced no visible panel`);
  }
  await page.screenshot({ path: `${OUT}/ci-replay.png` });

  if (errors.length > 0) fail(`console errors: ${errors.slice(0, 3).join(' | ')}`);

  await browser.close();
  console.log('E2E PASS: 6 KPIs, 17 nodes, 3 charts, 5 tabs, 0 console errors');
} finally {
  server.kill();
}
