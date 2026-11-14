// 无头浏览器自检：GLB 是否真的加载、旋翼/飞行控制是否生效、有无运行时报错
import { createRequire } from 'node:module';
const require = createRequire('C:/Users/31941/.workbuddy/binaries/node/workspace/package.json');
const { chromium } = require('playwright-core');

const CHROME = 'C:/Users/31941/AppData/Local/ms-playwright/chromium-1254/chrome-win64/chrome.exe';
const URL = 'http://127.0.0.1:8899/threejs_drone.html';
const SHOT = 'D:/work/self/无人机模型器/check_threejs_flight.png';
const HERO = 'D:/work/self/无人机模型器/check_threejs_hero.png';

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [], fails = [];
page.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
page.on('requestfailed', r => fails.push(r.url() + ' :: ' + (r.failure()?.errorText || '')));

await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForFunction(
  () => document.getElementById('t-state').textContent.includes('READY'),
  { timeout: 60000 });
await page.waitForTimeout(2200);

const read = () => page.evaluate(() => ({
  state: document.getElementById('t-state').textContent.trim(),
  pos: document.getElementById('t-pos').textContent.trim(),
  att: document.getElementById('t-att').textContent.trim(),
  rpm: document.getElementById('t-rpm').textContent.trim(),
  fps: document.getElementById('t-fps').textContent.trim(),
  nodes: document.querySelectorAll('#parts .part').length,
  folded: document.getElementById('b-fold').classList.contains('on'),
}));

const before = await read();
await page.screenshot({ path: HERO });
await page.locator('#b-fold').click();
await page.evaluate(() => {
  const s = document.getElementById('thr');
  s.value = '90'; s.dispatchEvent(new Event('input'));
});
await page.keyboard.down('KeyW');
await page.waitForTimeout(900);
await page.keyboard.up('KeyW');
await page.waitForTimeout(400);
const after = await read();
await page.screenshot({ path: SHOT });

console.log(JSON.stringify({
  before, after, errors: errs, requestFailures: fails,
  shot: SHOT,
  assertions: {
    loaded: before.state.includes('READY'),
    nodesListed: before.nodes >= 28,
    rendering: parseInt(before.fps) > 0,
    foldToggled: after.folded && !before.folded,
    throttleChanged: before.rpm !== after.rpm,
    flightMoved: before.pos !== after.pos || before.att !== after.att,
    noErrors: errs.length === 0 && fails.length === 0,
  },
}, null, 1));
await browser.close();
