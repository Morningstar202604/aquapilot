import { chromium } from 'playwright-core';
const exe = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ executablePath: exe, headless: true, args:['--force-device-scale-factor=1'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto('http://127.0.0.1:5199/', { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
// frame timing
const frames = await page.evaluate(() => new Promise(res => {
  const ts=[]; let last=performance.now();
  function loop(t){ ts.push(t-last); last=t; if (ts.length<300) requestAnimationFrame(loop); else res(ts); }
  requestAnimationFrame(loop);
}));
frames.sort((a,b)=>a-b);
const q = p => frames[Math.floor(frames.length*p)].toFixed(1);
console.log('frame interval ms: p50', q(0.5), 'p90', q(0.9), 'p99', q(0.99), 'max', frames[frames.length-1].toFixed(1));
// JS profile of a snapshot render: measure time from message to paint is hard; count react commits via PerformanceObserver long tasks and use User Timing?
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
const snap = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
const a = await snap(); await page.waitForTimeout(5000); const b = await snap();
const d=k=>(b[k]-a[k]);
console.log('5s: Task', d('TaskDuration').toFixed(2), 'Script', d('ScriptDuration').toFixed(3), 'Layout', d('LayoutCount'), 'Style', d('RecalcStyleCount'), 'Frames', d('Frames'));
// control: about:blank
const p2 = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await p2.goto('about:blank');
const c2 = await p2.context().newCDPSession(p2);
await c2.send('Performance.enable');
const sa = async () => Object.fromEntries((await c2.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
const x = await sa(); await p2.waitForTimeout(5000); const y = await sa();
console.log('blank 5s: Task', (y.TaskDuration-x.TaskDuration).toFixed(2), 'Script', (y.ScriptDuration-x.ScriptDuration).toFixed(2));
await browser.close();
