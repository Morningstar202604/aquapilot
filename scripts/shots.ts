import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';

const OUT = 'out/shots';
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });

async function shoot(name: string, w: number, h: number, actions: (p: any) => Promise<void>, fullPage = false) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3500);
  await actions(page);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage });
  if (errors.length) console.log(`  ${name} ERRORS:`, errors.slice(0, 3));
  await page.close();
}

console.log('== 桌面 1600×950 ==');
await shoot('a1-plant', 1600, 950, async () => {});
await shoot('a2-chat', 1600, 950, async (p) => {
  const i = p.locator('.composer input');
  await i.fill('现在运行怎么样');
  await i.press('Enter');
  await p.waitForTimeout(1500);
  await i.fill('如果发生暴雨会怎样');
  await i.press('Enter');
  await p.waitForTimeout(2000);
});
await shoot('a3-decision', 1600, 950, async (p) => { await p.locator('.side-tab', { hasText: '决策解释' }).click(); await p.waitForTimeout(1200); });
await shoot('a4-control', 1600, 950, async (p) => { await p.locator('.side-tab', { hasText: '控制与工况' }).click(); await p.waitForTimeout(1000); });
await shoot('a5-alarms', 1600, 950, async (p) => { await p.locator('.side-tab', { hasText: '告警' }).click(); await p.waitForTimeout(1000); });
await shoot('a6-insights', 1600, 950, async (p) => { await p.locator('.side-tab', { hasText: '效益' }).click(); await p.waitForTimeout(1000); });
await shoot('a7-replay', 1600, 950, async (p) => { await p.locator('.side-tab', { hasText: '回放' }).click(); await p.waitForTimeout(2500); });
await shoot('a8-editor', 1600, 950, async (p) => {
  await p.locator('.topbar-right button', { hasText: '工艺编排' }).click();
  await p.waitForTimeout(1500);
});

console.log('== 笔记本 1366×768 ==');
await shoot('b1-plant', 1366, 768, async () => {});

console.log('== 小屏 1024×700 ==');
await shoot('c1-plant', 1024, 700, async () => {});

console.log('== 移动 390×844 ==');
await shoot('d1-mobile', 390, 844, async () => {}, true);

await browser.close();
console.log('done');
