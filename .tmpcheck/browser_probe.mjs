import { chromium } from 'playwright-core';
const exe = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ executablePath: exe, headless: true, args:['--force-device-scale-factor=1'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: '+e.message));
page.on('console', m => { if (m.type()==='error') errors.push('console: '+m.text()); });
await page.goto('http://127.0.0.1:5199/', { waitUntil: 'networkidle' });
await page.waitForTimeout(4000);
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
const before = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
// instrument echarts setOption count by wrapping canvas contexts? instead count paint via MutationObserver on svg
await page.evaluate(() => {
  window.__mut = 0;
  const target = document.querySelector('svg.plant-canvas');
  const mo = new MutationObserver(list => { window.__mut += list.length; });
  mo.observe(target, { subtree: true, attributes: true, childList: true, characterData: true });
});
const t0 = Date.now();
await page.waitForTimeout(10000);
const after = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
const d = k => (after[k]-before[k]);
console.log('10s window:');
console.log(' TaskDuration(s):', d('TaskDuration').toFixed(3));
console.log(' ScriptDuration(s):', d('ScriptDuration').toFixed(3));
console.log(' LayoutCount:', d('LayoutCount'));
console.log(' RecalcStyleCount:', d('RecalcStyleCount'));
console.log(' JSHeapUsedSize MB:', (after.JSHeapUsedSize/1048576).toFixed(1));
console.log(' svg mutations in 10s:', await page.evaluate(()=>window.__mut));
console.log(' DOM nodes:', await page.evaluate(()=>document.querySelectorAll('*').length));
// long tasks
const longtasks = await page.evaluate(() => new Promise(res => {
  const arr=[]; const po=new PerformanceObserver(l=>{for(const e of l.getEntries()) arr.push(Math.round(e.duration));}); po.observe({entryTypes:['longtask']});
  setTimeout(()=>{po.disconnect();res(arr);},8000);
}));
console.log(' long tasks >50ms in 8s:', longtasks.length, longtasks.slice(0,10));
console.log(' errors:', errors);

// narrowed screenshots
await page.screenshot({ path: '.tmpcheck/desktop.png', fullPage: false });
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(1500);
await page.screenshot({ path: '.tmpcheck/mobile.png', fullPage: false });
const overflow = await page.evaluate(() => ({ scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth }));
console.log(' mobile overflow:', overflow);

// keyboard focus walk
await page.setViewportSize({ width: 1600, height: 900 });
await page.waitForTimeout(800);
const focusOrder = [];
for (let i=0;i<25;i++){
  await page.keyboard.press('Tab');
  focusOrder.push(await page.evaluate(() => {
    const el = document.activeElement;
    return el ? `${el.tagName.toLowerCase()}${el.className && typeof el.className==='string' ? '.'+el.className.split(' ')[0] : ''}:${(el.getAttribute('aria-label')||el.textContent||'').trim().slice(0,18)}` : 'none';
  }));
}
console.log(' focus order:', focusOrder.join(' | '));
await browser.close();
