import { chromium } from '../node_modules/playwright-core/index.mjs';
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
for (const [name,w,h] of [['desktop',1600,900],['tablet',900,1024],['mobile',390,844],['narrow',320,640]]) {
  const page = await browser.newPage({ viewport:{width:w,height:h} });
  await page.goto('http://127.0.0.1:5199/', { waitUntil:'networkidle' });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `.tmpcheck/${name}.png` });
  const m = await page.evaluate(()=>({
    docSW: document.documentElement.scrollWidth, docCW: document.documentElement.clientWidth,
    topbarH: document.querySelector('.topbar')?.getBoundingClientRect().height,
    canvasWrapSW: document.querySelector('.canvas-wrap')?.scrollWidth,
    canvasWrapCW: document.querySelector('.canvas-wrap')?.clientWidth,
    canvasWrapH: document.querySelector('.canvas-wrap')?.getBoundingClientRect().height,
    svgH: document.querySelector('svg.plant-canvas')?.getBoundingClientRect().height,
    sideH: document.querySelector('.side')?.getBoundingClientRect().height,
    bodyOverflowY: getComputedStyle(document.body).overflowY,
    hitTargets: [...document.querySelectorAll('button')].map(b=>{const r=b.getBoundingClientRect(); return {t:(b.textContent||'').trim().slice(0,10), h:Math.round(r.height), w:Math.round(r.width)}}).filter(x=>x.h>0 && x.h<32)
  }));
  console.log(name, JSON.stringify(m, null, 0));
  await page.close();
}
await browser.close();
