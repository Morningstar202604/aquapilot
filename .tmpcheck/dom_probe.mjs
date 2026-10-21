import { chromium } from '../node_modules/playwright-core/index.mjs';
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport:{width:1600,height:900} });
await page.goto('http://127.0.0.1:5199/', { waitUntil:'networkidle' });
await page.waitForTimeout(2500);
console.log(await page.evaluate(()=>({
  pausedText: [...document.querySelectorAll('button')].filter(b=>b.textContent?.includes('运行中')||b.textContent?.includes('已暂停')).map(b=>b.textContent),
  svgCount: document.querySelectorAll('svg').length,
  animateTags: document.querySelectorAll('animate').length,
  smil: [...document.querySelectorAll('svg *')].filter(e=>e.tagName.toLowerCase()==='animate').length,
  paths: document.querySelectorAll('path').length,
  kpiBars: [...document.querySelectorAll('.kpi-bar span')].map(e=>getComputedStyle(e).width),
})));
console.log(await page.evaluate(()=>new Promise(res=>{
  let n=0; const mo=new MutationObserver(l=>n+=l.length);
  mo.observe(document.body,{subtree:true,attributes:true,childList:true,characterData:true});
  setTimeout(()=>{mo.disconnect();res('DOM mutations in 3s: '+n);},3000);
})));
await browser.close();
