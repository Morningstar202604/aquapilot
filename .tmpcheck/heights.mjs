import { chromium } from '../node_modules/playwright-core/index.mjs';
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
for (const [name,w,h] of [['laptop',1366,768],['small',1280,600],['hd',1920,1080]]) {
  const page = await browser.newPage({ viewport:{width:w,height:h} });
  await page.goto('http://127.0.0.1:5199/', { waitUntil:'networkidle' });
  await page.waitForTimeout(2000);
  const m = await page.evaluate(()=>{
    const wrap=document.querySelector('.canvas-wrap');
    const svg=document.querySelector('svg.plant-canvas');
    const stage=document.querySelector('.stage');
    return {
      wrapH: wrap?.getBoundingClientRect().height,
      svgH: svg?.getBoundingClientRect().height,
      svgBottomVsWrap: svg ? +(svg.getBoundingClientRect().bottom - wrap.getBoundingClientRect().bottom).toFixed(0) : null,
      wrapScrollH: wrap?.scrollHeight,
      wrapClientH: wrap?.clientHeight,
      stageH: stage?.getBoundingClientRect().height,
      bodyScrollH: document.body.scrollHeight, innerH: window.innerHeight
    };
  });
  console.log(name, JSON.stringify(m));
  await page.screenshot({path:`.tmpcheck/${name}.png`});
  await page.close();
}
await browser.close();
