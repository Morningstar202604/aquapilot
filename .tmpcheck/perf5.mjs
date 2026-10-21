import { chromium } from '../node_modules/playwright-core/index.mjs';
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport:{width:1600,height:900} });
await page.goto('http://127.0.0.1:5199/', { waitUntil:'networkidle' });
await page.waitForTimeout(3000);
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
const snap = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
const run = async (label) => { const a=await snap(); await page.waitForTimeout(5000); const b=await snap(); console.log(label.padEnd(32), 'Task', (b.TaskDuration-a.TaskDuration).toFixed(2)+'s', 'Script', (b.ScriptDuration-a.ScriptDuration).toFixed(3)+'s', 'Style', (b.RecalcStyleCount-a.RecalcStyleCount), 'Layout', (b.LayoutCount-a.LayoutCount)); };
await run('running (SMIL + 1Hz rerender)');
// kill SMIL only, keep snapshots flowing
await page.evaluate(()=>{ document.querySelectorAll('animate').forEach(n=>n.remove()); });
await page.waitForTimeout(1200);
console.log('animate after removal:', await page.evaluate(()=>document.querySelectorAll('animate').length));
await run('running, SMIL removed');
await page.evaluate(()=>{ document.querySelectorAll('animate').forEach(n=>n.remove()); });
await run('running, SMIL removed again');
// long tasks
const lt = await page.evaluate(()=>new Promise(res=>{const arr=[];const po=new PerformanceObserver(l=>{for(const e of l.getEntries())arr.push(+e.duration.toFixed(0))});po.observe({entryTypes:['longtask']});setTimeout(()=>{po.disconnect();res(arr)},6000)}));
console.log('longtasks in 6s:', lt.length, lt);
await browser.close();
