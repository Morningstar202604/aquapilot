import { chromium } from '../node_modules/playwright-core/index.mjs';
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport:{width:1600,height:900} });
await page.goto('http://127.0.0.1:5199/', { waitUntil:'networkidle' });
await page.waitForTimeout(2500);
const cdp = await page.context().newCDPSession(page);
await cdp.send('Accessibility.enable');
const { nodes } = await cdp.send('Accessibility.getFullAXTree');
const buttons = nodes.filter(n=>n.role?.value==='button');
console.log('AX buttons:', buttons.length);
console.log('first 8 button names:', buttons.slice(0,8).map(b=>b.name?.value));
const img = nodes.find(n=>n.role?.value==='image');
console.log('image node:', img?.name?.value?.slice(0,80), 'children:', img?.childIds?.length);
// are plant node buttons in AX tree?
console.log('plant node names in AX:', buttons.filter(b=>/进水渠|好氧池|二沉池/.test(b.name?.value||'')).map(b=>b.name.value));
// focus test with keyboard into svg
const scale = await page.evaluate(()=>{
  const t=document.querySelector('.unit-sub');
  const m=t.getScreenCTM();
  return {font:getComputedStyle(t).fontSize, scaleX:+m.a.toFixed(3), scaleY:+m.d.toFixed(3), effPx:+(parseFloat(getComputedStyle(t).fontSize)*m.a).toFixed(2)};
});
console.log('svg text scale:', scale);
const kpiOverflow = await page.evaluate(()=>[...document.querySelectorAll('.kpi-label')].map(el=>({text:el.textContent.trim().slice(0,30), over: el.scrollWidth>el.clientWidth, sw:el.scrollWidth, cw:el.clientWidth})));
console.log('kpi label overflow:', kpiOverflow.filter(k=>k.over));
await browser.close();
