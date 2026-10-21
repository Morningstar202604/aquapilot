import { chromium } from '../node_modules/playwright-core/index.mjs';
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport:{width:1600,height:900} });
await page.goto('http://127.0.0.1:5199/', { waitUntil:'networkidle' });
await page.waitForTimeout(3000);
const r = await page.evaluate(()=>{
  const svg = document.querySelector('svg.plant-canvas');
  const vb = svg.viewBox.baseVal;
  const ctm = svg.getScreenCTM();
  const out = {viewBoxW: vb.width, viewBoxH: vb.height, screenW: svg.getBoundingClientRect().width, scale: +ctm.a.toFixed(3)};
  // text overflowing its node rect
  const over = [];
  document.querySelectorAll('.plant-node').forEach(g=>{
    const rect = g.querySelector('rect');
    const rx = +rect.getAttribute('x'), rw = +rect.getAttribute('width');
    g.querySelectorAll('text').forEach(t=>{
      const b = t.getBBox();
      if (b.x + b.width > rx + rw - 2) over.push({unit: g.getAttribute('aria-label'), text: t.textContent, overflowPx: +(b.x+b.width-(rx+rw)).toFixed(1)});
    });
  });
  out.textOverflow = over.slice(0,12); out.overflowCount = over.length;
  out.effectiveFontPx = +(9.5*ctm.a).toFixed(2);
  return out;
});
console.log(JSON.stringify(r,null,1));
await browser.close();
