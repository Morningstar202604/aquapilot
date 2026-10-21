import { chromium } from '../node_modules/playwright-core/index.mjs';
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport:{width:1600,height:900} });
await page.goto('http://127.0.0.1:5199/', { waitUntil:'networkidle' });
await page.waitForTimeout(3500);
await page.screenshot({path:'.tmpcheck/plus3.png'});
const m = await page.evaluate(()=>({
  canvasScrollW: document.querySelector('.canvas-wrap')?.scrollWidth,
  canvasClientW: document.querySelector('.canvas-wrap')?.clientWidth,
  canvasScrollH: document.querySelector('.canvas-wrap')?.scrollHeight,
  canvasClientH: document.querySelector('.canvas-wrap')?.clientHeight,
  textOverflowCount: [...document.querySelectorAll('.unit-sub,.unit-value,.edge-label')].filter(e=>{const r=e.getBoundingClientRect(); const p=e.closest('g'); return false;}).length,
  units: document.querySelectorAll('.plant-node').length
}));
console.log(m);
// horizontal scroll to the right end to inspect overlap
await page.evaluate(()=>{ const w=document.querySelector('.canvas-wrap'); if(w) w.scrollLeft = w.scrollWidth; });
await page.waitForTimeout(800);
await page.screenshot({path:'.tmpcheck/plus3_right.png'});
await browser.close();
