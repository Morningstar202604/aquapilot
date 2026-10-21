import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = 'out/shots';
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 980 }, deviceScaleFactor: 1 });

const errors: string[] = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(3500);
await page.screenshot({ path: `${OUT}/01-main.png` });

const readState = async () => {
  return page.evaluate(`(() => {
    const text = (sel) => document.querySelector(sel)?.textContent ?? null;
    return {
      title: document.title,
      kpis: [...document.querySelectorAll('.kpi')].map((k) => ({
        label: k.querySelector('.kpi-label')?.textContent,
        value: k.querySelector('.kpi-num')?.textContent,
      })),
      clock: [...document.querySelectorAll('.meta-value')].map((m) => m.textContent),
      chartCanvases: document.querySelectorAll('.trend-canvas canvas').length,
      svgNodes: document.querySelectorAll('.flow-svg rect').length,
      tabCount: document.querySelectorAll('.side-tab').length,
      connected: text('.topbar-right')?.includes('链路正常') ?? false,
    };
  })()`);
};

const state1 = await readState();
console.log('STATE1', JSON.stringify(state1, null, 2));

await page.click('.side-tab:nth-child(2)');
await page.waitForTimeout(1000);
await page.screenshot({ path: `${OUT}/02-decision.png` });

await page.click('.side-tab:nth-child(3)');
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/03-control.png` });

await page.click('.side-tab:nth-child(1)');
await page.waitForTimeout(500);
const input = page.locator('.composer input');
await input.fill('现在运行怎么样');
await input.press('Enter');
await page.waitForTimeout(1500);
await input.fill('如果发生暴雨会怎样');
await input.press('Enter');
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/04-chat.png` });

const chatText = await page.evaluate(`[...document.querySelectorAll('.msg')].map((m) => m.textContent?.slice(0, 220))`);
console.log('CHAT', JSON.stringify(chatText, null, 2));

// Inject storm scenario from control tab
await page.click('.side-tab:nth-child(3)');
await page.waitForTimeout(400);
const stormBtn = page.locator('.scenario-btn', { hasText: '暴雨冲击' });
await stormBtn.click();
await page.waitForTimeout(9000);
await page.screenshot({ path: `${OUT}/05-storm.png` });

const stormState = await page.evaluate(`({
  notices: [...document.querySelectorAll('.notice')].map((n) => n.textContent),
  alarmCount: document.querySelectorAll('.alarm-row').length,
  kpis: [...document.querySelectorAll('.kpi')].map((k) => k.querySelector('.kpi-num')?.textContent),
})`);
console.log('STORM', JSON.stringify(stormState, null, 2));

await page.click('.side-tab:nth-child(4)');
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/06-alarms.png` });

// Mobile
const mobile = await browser.newPage({ viewport: { width: 420, height: 900 } });
await mobile.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await mobile.waitForTimeout(2500);
await mobile.screenshot({ path: `${OUT}/07-mobile.png`, fullPage: true });

console.log('CONSOLE_ERRORS', JSON.stringify(errors, null, 2));

await browser.close();
