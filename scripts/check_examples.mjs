// 无头浏览器验证前端最小示例：GLB 加载、旋翼/云台驱动、键盘飞行、零报错
import { createRequire } from 'node:module';
const require = createRequire('C:/Users/31941/.workbuddy/binaries/node/workspace/package.json');
const { chromium } = require('playwright-core');

const CHROME = 'C:/Users/31941/AppData/Local/ms-playwright/chromium-1254/chrome-win64/chrome.exe';
const URL = 'http://127.0.0.1:8899/examples/frontend/index.html';
const SHOT = 'D:/work/self/无人机模型器/examples/frontend/check.png';

const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
const errs = [], fails = [], logs = [];
page.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
page.on('console', m => {
  if (m.type() === 'error') errs.push('CONSOLE ' + m.text());
  if (m.type() === 'log') logs.push(m.text());
});
page.on('requestfailed', r => fails.push(r.url() + ' :: ' + (r.failure()?.errorText || '')));

await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForFunction(
  () => document.getElementById('hud').textContent.includes('旋翼'),
  { timeout: 60000 });
await page.waitForTimeout(1500);
const before = await page.locator('#hud').textContent();
await page.keyboard.down('KeyW');
await page.keyboard.down('ArrowUp');
await page.waitForTimeout(900);
await page.keyboard.up('KeyW');
await page.keyboard.up('ArrowUp');
await page.waitForTimeout(250);
const after = await page.locator('#hud').textContent();
await page.screenshot({ path: SHOT });

const pos = s => (s.match(/位置\s+([-\d., ]+)/) || [])[1]?.trim();
const gim = s => (s.match(/云台\s+(-?\d+)°/) || [])[1];
console.log(JSON.stringify({
  before: before.trim().split('\n'),
  after: after.trim().split('\n'),
  extrasLogged: logs.some(l => l.includes('根节点 extras')),
  errors: errs, requestFailures: fails, shot: SHOT,
  assertions: {
    loaded: before.includes('旋翼'),
    movedByKeyboard: pos(before) !== pos(after),
    gimbalChanged: gim(before) !== gim(after),
    noErrors: errs.length === 0 && fails.length === 0,
  },
}, null, 1));
await browser.close();
