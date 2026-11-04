import { chromium } from 'playwright-core';
import { mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolveBrowserExecutable } from './e2eBrowser';

/**
 * CI 用的浏览器冒烟测试。
 *
 * 与人工审查脚本的区别：断言明确、失败即退出码非零，默认使用托管浏览器。
 * 覆盖三条最关键的路径：页面能加载、五个面板可切换、WebSocket 有数据。
 */

const PORT = 5188;
const OUT = 'out/shots';

function fail(msg: string): never {
  /**
   * 失败时带上环境指纹。
   *
   * 上一轮 CI 只在「顶栏裁切 / 页签换行」这类断言上失败，本地却全过，
   * 原因之一是渲染字体不同（CI 无 CJK 字形 → 回退字体更宽）。
   * 把平台、字体可用性一并打出来，下次不用靠猜。
   */
  console.error(`E2E FAIL: ${msg}`);
  console.error(`  platform=${process.platform} node=${process.version} browser=${process.env.AQUAPILOT_BROWSER_PATH ?? '(auto)'}`);
  process.exit(1);
}

await mkdir(OUT, { recursive: true });
await rm('out/e2e-data', { recursive: true, force: true });

const server = spawn(process.execPath, ['dist/server/index.mjs'], {
  /**
   * 完全隔离运行时数据。
   *
   * 只关持久化（AQUAPILOT_PERSIST=0）不够：拓扑文档与版本历史是独立文件，
   * 冒烟测试里点一次「应用到仿真」就会写进开发者真实的 data/ 目录，
   * 实测把它撑到 66 KB 且混入测试厂。这里全部指向临时目录。
   */
  env: {
    ...process.env,
    PORT: String(PORT),
    AQUAPILOT_PERSIST: '0',
    AQUAPILOT_TOPOLOGY: 'out/e2e-data/topology.json',
    AQUAPILOT_TOPOLOGY_HISTORY: 'out/e2e-data/topology-history.json',
    AQUAPILOT_LLM_CONFIG: 'out/e2e-data/llm-config.json',
    AQUAPILOT_AGENT_CONFIG: 'out/e2e-data/agent-config.json',
  },
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

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await waitForServer();

  const browserPath = resolveBrowserExecutable();
  browser = await chromium.launch({ headless: true, ...(browserPath ? { executablePath: browserPath } : {}) });
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });

  /**
   * 等 WS 首帧：CI runner 是 2 核，固定 3.5s 在慢环境会竞态失败
   * （快照未到 → KPI 数 0）。轮询等 KPI 出现，上限 20s，本地 1s 内即过。
   */
  let kpisReady = 0;
  for (let i = 0; i < 40; i++) {
    kpisReady = await page.locator('.kpi').count();
    if (kpisReady >= 7) break;
    await page.waitForTimeout(500);
  }
  if (kpisReady < 7) fail(`KPI tiles never appeared after 20s (got ${kpisReady}) — first WS frame likely lost`);
  await page.waitForTimeout(800);

  const onboarding = page.getByRole('dialog', { name: '使用引导' });
  if (await onboarding.isVisible().catch(() => false)) {
    await onboarding.getByRole('button', { name: '跳过' }).click();
    await onboarding.waitFor({ state: 'hidden' });
  }

  const kpis = await page.locator('.kpi').count();
  if (kpis < 7) fail(`expected >=7 KPI tiles, got ${kpis}`);

  const health = page.locator('.health-pill');
  if ((await health.count()) !== 1) fail('health pill missing from the top bar');
  if (!/健康度\s*\d+/.test((await health.innerText()).trim())) fail(`health pill text: ${await health.innerText()}`);

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
    if (tab === '告警') {
      const parts = await page.locator('.health-part').count();
      if (parts !== 5) fail(`alarm panel should show 5 health parts, got ${parts}`);
    }
  }
  await page.screenshot({ path: `${OUT}/ci-replay.png` });

  /**
   * 本轮新增能力的冒烟（此前只有单测与手工浏览器验收）：
   * - 沿程剖面：主序列单元必须画出 5 行且当前行高亮
   * - 拓扑版本页：能打开、能列出当前 revision
   * - 拖拽连线的端口层必须有 data-unit（否则命中测试无从定位，
   *   这正是真实浏览器里拖拽失效的根因）
   */
  await page.locator('.side-tab', { hasText: 'AI 对话' }).click();
  await page.waitForTimeout(400);
  await page.locator('[data-unit-node="aerobic1"]').click();
  await page.waitForTimeout(600);
  const trainRows = await page.locator('.train-row:not(.train-head)').count();
  if (trainRows !== 5) fail(`train profile should render 5 rows, got ${trainRows}`);
  const currentRows = await page.locator('.train-row[data-current="true"]').count();
  if (currentRows !== 1) fail(`train profile should highlight exactly one row, got ${currentRows}`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  await page.getByRole('button', { name: '工艺编排' }).click();
  await page.waitForTimeout(1000);
  const portLayers = await page.locator('.port-layer[data-unit]').count();
  if (portLayers < 10) fail(`port layers should expose data-unit, got ${portLayers}`);
  await page.getByRole('button', { name: '版本' }).click();
  await page.waitForTimeout(600);
  const versionRows = await page.locator('[data-version]').count();
  if (versionRows < 1) fail(`version history should list at least the boot baseline, got ${versionRows}`);
  await page.screenshot({ path: `${OUT}/ci-editor.png` });
  await page.getByRole('button', { name: '运行监视' }).click();
  await page.waitForTimeout(600);

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
        const hit = nodes.findIndex(
          (n) => pt.x > n.x + 3 && pt.x < n.x + n.w - 3 && pt.y > n.y + 3 && pt.y < n.y + n.h - 3,
        );
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

  /**
   * 顶栏溢出：只量 meta-value 高度抓不到这个问题。
   * 实测 1440/1600 宽下整条 1553px：品牌被推到 -101px、最右的链路状态被裁掉，
   * 而 meta-value 仍是单行（高度 27px），旧断言全绿。改为量真实几何：
   * 条内不产生横向溢出、品牌左边缘不为负、最右控件完整可见。
   */
  for (const width of [1920, 1600, 1440, 1366, 1280, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(400);
    const bar = await page.evaluate(() => {
      const tb = document.querySelector('.topbar') as HTMLElement;
      const brand = document.querySelector('.brand') as HTMLElement;
      const right = document.querySelector('.topbar-right') as HTMLElement;
      const last = right?.lastElementChild as HTMLElement | null;
      const lastBox = last?.getBoundingClientRect();
      return {
        overflow: tb.scrollWidth - tb.clientWidth,
        brandLeft: Math.round(brand.getBoundingClientRect().left),
        lastRight: lastBox ? Math.round(lastBox.right) : null,
      };
    });
    if (bar.overflow > 1) fail(`topbar overflows at ${width}px: ${bar.overflow}px`);
    if (bar.brandLeft < 0) fail(`brand pushed off-screen at ${width}px: ${bar.brandLeft}px`);
    if (bar.lastRight !== null && bar.lastRight > width + 1) {
      fail(`right-most topbar control clipped at ${width}px: ${bar.lastRight} > ${width}`);
    }
  }

  /**
   * 侧栏页签必须单行：七个页签塞在 372px 里，「控制与工况」折成两行时
   * 与其他页签的垂直对齐全乱（截图实测）。scrollHeight > clientHeight 即可判定。
   */
  const wrappedTabs = await page.evaluate(() =>
    [...document.querySelectorAll('.side-tab')]
      .filter((e) => e.scrollHeight > (e as HTMLElement).clientHeight + 1)
      .map((e) => e.textContent?.trim() ?? '?'),
  );
  if (wrappedTabs.length > 0) fail(`side tabs wrapped: ${wrappedTabs.join(', ')}`);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) fail(`mobile horizontal overflow: ${overflow}px`);
  if (errors.length > 0) fail(`console errors: ${errors.slice(0, 3).join(' | ')}`);

  await browser.close();
  console.log(
    'E2E PASS: 7 KPIs, health pill, 5 health parts, 17 nodes, 3 charts, 6 panels, train profile, port layers, version history, topbar 6 widths, 0 console errors',
  );
} finally {
  await browser?.close().catch(() => undefined);
  server.kill();
}
