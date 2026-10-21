import { chromium } from 'playwright-core';
const exe = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto('http://127.0.0.1:5199/', { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
const snap = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
const run = async (label) => { const a=await snap(); await page.waitForTimeout(5000); const b=await snap(); console.log(label, 'Task', (b.TaskDuration-a.TaskDuration).toFixed(2), 'Script', (b.ScriptDuration-a.ScriptDuration).toFixed(3), 'Style', b.RecalcStyleCount-a.RecalcStyleCount, 'Layout', b.LayoutCount-a.LayoutCount); };
await run('running');
await page.getByRole('button', { name: '运行中' }).click();
await page.waitForTimeout(1500);
await run('paused');
// hide the flowing-SMIL by removing animate nodes to separate SMIL cost
await page.evaluate(()=>document.querySelectorAll('animate').forEach(a=>a.remove()));
await run('paused+noSMIL');
// count SMIL animate nodes
console.log('animate nodes at load:', await page.evaluate(()=>document.querySelectorAll('animate').length));
// tabs: measure while on editor view
await page.getByRole('button', { name: '工艺编排' }).click();
await page.waitForTimeout(1000);
await run('editor');
await browser.close();
