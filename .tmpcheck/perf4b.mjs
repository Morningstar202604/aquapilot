import { chromium } from '../node_modules/playwright-core/index.mjs';
const exe = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto('http://127.0.0.1:5199/', { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
console.log('animate nodes:', await page.evaluate(()=>document.querySelectorAll('animate').length));
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
const snap = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
const run = async (label) => { const a=await snap(); await page.waitForTimeout(5000); const b=await snap(); console.log(label.padEnd(28), 'Task', (b.TaskDuration-a.TaskDuration).toFixed(2), 'Script', (b.ScriptDuration-a.ScriptDuration).toFixed(3), 'Style', b.RecalcStyleCount-a.RecalcStyleCount, 'Layout', b.LayoutCount-a.LayoutCount); };
await run('baseline');
await page.addStyleTag({content:'.trends{display:none !important}'});
await page.waitForTimeout(1500);
await run('no trends');
await page.addStyleTag({content:'.plant-canvas{display:none !important}'});
await page.waitForTimeout(1500);
await run('no trends/no canvas');
// measure ResizeObserver firing count
const roCount = await page.evaluate(() => new Promise(res => {
  let n=0; const el=document.querySelector('.trend-canvas');
  if(!el) return res('no el');
  const ro=new ResizeObserver(()=>n++); ro.observe(el);
  setTimeout(()=>{ro.disconnect();res(n);},3000);
}));
console.log('trend-canvas ResizeObserver fires in 3s (hidden):', roCount);
await browser.close();
