import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';

const OUT = 'out/shots';
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(3500);
await page.screenshot({ path: `${OUT}/20-plant.png` });

// 遍历全部 5 个侧栏面板，确认无渲染错误
const tabs = ['AI 对话', '决策解释', '控制与工况', '告警', '效益'];
const results: Record<string, string> = {};
for (let i = 0; i < tabs.length; i++) {
  await page.locator(`.side-tab:nth-child(${i + 1})`).click();
  await page.waitForTimeout(800);
  const text = (await page.evaluate(`document.querySelector('.side-tabs').parentElement.innerText || ''`)) as string;
  results[tabs[i]] = text.replace(/\s+/g, ' ').slice(0, 100);
  await page.screenshot({ path: `${OUT}/21-tab-${i + 1}.png` });
}

// 检查关键数值是否合理
const kpis = await page.evaluate(`(() => {
  const rows = [...document.querySelectorAll('.kpi')].map((k) => ({
    label: k.querySelector('.kpi-label')?.innerText?.replace(/\s+/g, ' '),
    value: k.querySelector('.kpi-num')?.textContent,
  }));
  return rows;
})()`);

// 效益面板里的 F/M 与成本
await page.locator('.side-tab:nth-child(5)').click();
await page.waitForTimeout(700);
const insights = await page.evaluate(`(document.querySelector('.scroll-panel')?.innerText || '').replace(/\s+/g, ' ').slice(0, 700)`);

console.log('KPI:', JSON.stringify(kpis, null, 1));
console.log('INSIGHTS:', insights);
console.log('TABS:', JSON.stringify(results, null, 1));
console.log('ERRORS:', JSON.stringify(errors, null, 1));
await browser.close();
