import { chromium } from 'playwright-core';
import { mkdir, rename, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * 对外展示素材生成器：README 截图 + 演示视频。
 *
 * 与 e2e-ci.ts 的区别：那个是断言脚本，失败即退出；这个是展示脚本，
 * 负责把真实界面按固定剧本走一遍并落盘。所有画面都来自真实运行的
 * 生产构建（dist/），不是设计稿。
 *
 * 输出：
 *   docs/screenshots/*.jpg   10 张
 *   docs/media/demo.webm     原始录制
 *   （外层用 ffmpeg 转 docs/media/demo.mp4 与 demo.gif）
 */

const PORT = 5190;
const SHOT = 'docs/screenshots';
const VIDEO_DIR = 'out/video';
const DB = 'out/media-demo.db';

function fail(msg: string): never {
  console.error(`MEDIA FAIL: ${msg}`);
  process.exit(1);
}

await mkdir(SHOT, { recursive: true });
await mkdir(VIDEO_DIR, { recursive: true });
for (const suffix of ['', '-wal', '-shm']) {
  try {
    await rm(`${DB}${suffix}`, { force: true });
  } catch {
    /* nothing to remove */
  }
}

/**
 * 展示录制要开持久化：回放面板的数据只来自 SQLite。
 * 用 out/ 下的临时库，截图里就能看到真实历史而不是"持久化未启用"。
 * TICK_MS=200 让 30 秒内积累足够多的抽样点，画面里曲线不是空的。
 */
const server = spawn(process.execPath, ['dist/server/index.mjs'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    AQUAPILOT_DB: DB,
    AQUAPILOT_PERSIST: '1',
    TICK_MS: '200',
    SIM_MINUTES_PER_TICK: '4',
  },
  stdio: 'ignore',
});

const waitForServer = async (): Promise<void> => {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.ok) return;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  fail('server did not become healthy');
};

async function snap(page: import('playwright-core').Page, name: string) {
  await page.screenshot({ path: `${SHOT}/${name}.jpg`, quality: 92, type: 'jpeg' });
  console.log(`  shot ${name}`);
}

try {
  await waitForServer();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 950 },
    recordVideo: { dir: VIDEO_DIR, size: { width: 1600, height: 950 } },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(5000);

  await snap(page, '01-overview');
  await page.waitForTimeout(2500);

  // AI 对话
  await page.locator('.side-tab', { hasText: 'AI 对话' }).click();
  const input = page.getByLabel('向 AI 值班员提问');
  await page.waitForTimeout(800);
  await input.fill('现在运行怎么样');
  await input.press('Enter');
  await page.waitForTimeout(1800);
  await input.fill('为什么这样调节');
  await input.press('Enter');
  await page.waitForTimeout(1800);
  await snap(page, '02-chat');

  // 决策解释
  await page.locator('.side-tab', { hasText: '决策解释' }).click();
  await page.waitForTimeout(1200);
  await snap(page, '03-decision');

  // 控制与工况：注入暴雨
  await page.locator('.side-tab', { hasText: '控制与工况' }).click();
  await page.waitForTimeout(900);
  await page.locator('.scenario-btn', { hasText: '暴雨冲击' }).click();
  await page.waitForTimeout(3000);
  await snap(page, '04-control');

  // 效益（双跑 + 导出）
  await page.locator('.side-tab', { hasText: '效益' }).click();
  await page.waitForTimeout(1200);
  await snap(page, '05-insights');

  // 告警归因：注入毒性抑制，让告警真实触发后再截
  await page.locator('.side-tab', { hasText: '控制与工况' }).click();
  await page.waitForTimeout(600);
  await page.locator('.scenario-btn', { hasText: '毒性抑制' }).click();
  await page.waitForTimeout(6000);
  await page.locator('.side-tab', { hasText: '告警' }).click();
  await page.waitForTimeout(1200);
  await snap(page, '10-alarms');

  // 回放：先让持久化真正写入几轮，再刷新面板
  await page.locator('.side-tab', { hasText: '回放' }).click();
  await page.waitForTimeout(3000);
  const refresh = page.locator('.scroll-panel .chip', { hasText: '刷新' }).first();
  if (await refresh.count()) await refresh.click();
  await page.waitForTimeout(2500);
  await snap(page, '06-replay');

  // 工艺编排
  await page.locator('.topbar button', { hasText: '工艺编排' }).click();
  await page.waitForTimeout(2000);
  await page.locator('.plant-node').nth(5).click();
  await page.waitForTimeout(800);
  await snap(page, '07-editor');

  // 笔记本分辨率
  await page.locator('.topbar button', { hasText: '运行监视' }).click();
  await page.waitForTimeout(1200);
  await page.setViewportSize({ width: 1440, height: 810 });
  await page.waitForTimeout(1500);
  await snap(page, '08-laptop');

  // 移动端
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1500);
  await snap(page, '09-mobile');

  if (errors.length > 0) fail(`console errors: ${errors.slice(0, 3).join(' | ')}`);

  const video = page.video();
  await context.close();
  await browser.close();
  if (video) {
    const raw = await video.path();
    if (existsSync(raw)) await rename(raw, 'docs/media/demo.webm');
  }
  console.log('MEDIA PASS: 10 screenshots + demo.webm');
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 500));
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      await rm(`${DB}${suffix}`, { force: true });
    } catch {
      /* Windows may hold the handle briefly */
    }
  }
}
