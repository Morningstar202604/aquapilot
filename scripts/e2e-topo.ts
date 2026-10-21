import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';

const OUT = 'out/shots';
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(3500);
await page.screenshot({ path: `${OUT}/10-plant.png` });

const state = await page.evaluate(`({
  units: document.querySelectorAll('.plant-node').length,
  edges: document.querySelectorAll('.plant-canvas path[marker-end]').length,
  labels: [...document.querySelectorAll('.unit-title')].map(e => e.textContent),
})`);
console.log('PLANT', JSON.stringify(state, null, 1));

// go to editor
const editorBtn = page.locator('.topbar-right button', { hasText: '工艺编排' });
await editorBtn.click();
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/11-editor.png` });

const editorState = await page.evaluate(`({
  palette: document.querySelectorAll('.palette-item').length,
  nodes: document.querySelectorAll('.plant-node').length,
  tabs: [...document.querySelectorAll('.editor-tab')].map(t => t.textContent),
})`);
console.log('EDITOR', JSON.stringify(editorState));

// add an extra aerobic tank
const aerobicBtn = page.locator('.palette-item', { hasText: '好氧池' }).first();
await aerobicBtn.click();
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/12-editor-added.png` });

const afterAdd = await page.evaluate(`({
  nodes: document.querySelectorAll('.plant-node').length,
  banner: document.querySelector('.draft-banner')?.textContent?.trim() ?? null,
})`);
console.log('AFTER_ADD', JSON.stringify(afterAdd));

// open check pane
await page.locator('.editor-tab', { hasText: '校验' }).click();
await page.waitForTimeout(700);
const check = await page.evaluate(`({
  readiness: document.querySelector('.readiness') ? document.querySelector('.readiness').innerText : null,
  issues: Array.from(document.querySelectorAll('.issue')).map(function (i) { return i.textContent; }),
})`);
console.log('CHECK', JSON.stringify(check, null, 1));
await page.screenshot({ path: `${OUT}/13-editor-check.png` });

// delete the added tank to return to a runnable state, then apply
await page.locator('.editor-tab', { hasText: '属性' }).click();
await page.waitForTimeout(400);
await page.locator('.btn', { hasText: '删除单元' }).click();
await page.waitForTimeout(800);

await page.locator('.editor-tab', { hasText: '校验' }).click();
await page.waitForTimeout(500);
const afterDelete = await page.evaluate(`document.querySelector('.readiness')?.innerText ?? null`);
console.log('AFTER_DELETE_READINESS', JSON.stringify(afterDelete));

await page.locator('.pill', { hasText: '应用到仿真' }).click();
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/14-applied.png` });

const applied = await page.evaluate(`({
  notices: [...document.querySelectorAll('.notice')].map(n => n.textContent?.trim()),
  hasPlant: document.querySelectorAll('.plant-node').length,
})`);
console.log('APPLIED', JSON.stringify(applied, null, 1));

console.log('ERRORS', JSON.stringify(errors, null, 1));
await browser.close();
