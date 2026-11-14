// 浏览器端验证：物理页加载、姿态响应、自由落体、风扰动、零报错
import { createRequire } from 'node:module';
const require = createRequire('C:/Users/31941/.workbuddy/binaries/node/workspace/package.json');
const { chromium } = require('playwright-core');

const CHROME = 'C:/Users/31941/AppData/Local/ms-playwright/chromium-1254/chrome-win64/chrome.exe';
const URL = 'http://127.0.0.1:8899/examples/frontend/physics.html';
const SHOT = 'D:/work/self/无人机模型器/examples/frontend/check_physics.png';

const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errs = [], fails = [];
page.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
page.on('requestfailed', r => fails.push(r.url() + ' :: ' + (r.failure()?.errorText || '')));

await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForFunction(
  () => document.getElementById('load').style.display === 'none',
  { timeout: 60000 });
await page.waitForTimeout(1200);
const read = () => page.evaluate(() => ({
  pos: document.getElementById('t-pos').textContent,
  vel: document.getElementById('t-vel').textContent,
  att: document.getElementById('t-att').textContent,
  omg: document.getElementById('t-omg').textContent,
  thr: document.getElementById('t-thr').textContent,
  rpm: document.getElementById('t-rpm').textContent,
  eng: document.getElementById('t-eng').textContent,
  con: document.getElementById('t-con').textContent,
  hud: document.getElementById('hud').textContent,
}));
const hover = await read();

// 前倾 → 机头下压 + 产生角速度
await page.keyboard.down('KeyW');
await page.waitForTimeout(700);
await page.keyboard.up('KeyW');
await page.waitForTimeout(200);
const tilted = await read();

// 切断动力 → 自由落体并触地
await page.locator('#b-drop').click();
await page.waitForTimeout(2200);
const dropped = await read();

// 阵风 → 速度响应
await page.locator('#b-reset').click();
await page.waitForTimeout(300);
const beforeWind = await read();
await page.locator('#b-gust').click();
await page.waitForTimeout(500);
const afterWind = await read();

await page.screenshot({ path: SHOT });
const num = s => parseFloat(s);
const pitchOf = s => num(s.split('/')[0]);
const yOf = s => num(s.split(',')[1]);
console.log(JSON.stringify({
  hover, tilted, dropped, beforeWind, afterWind,
  errors: errs, requestFailures: fails, shot: SHOT,
  assertions: {
    loaded: hover.hud.includes('质量'),
    hoverStable: Math.abs(yOf(hover.pos) - 0.35) < 0.15,
    tiltResponse: pitchOf(tilted.att) < -3,
    angularVelocity: Math.abs(num(tilted.omg.split(',')[0])) > 0.1,
    freeFallLanded: yOf(dropped.pos) < 0.12,
    contactDetected: dropped.con.includes('接触'),
    windResponse: beforeWind.vel !== afterWind.vel,
    rotorsDriven: hover.rpm.split('/').every(x => parseInt(x) > 1000),
    noErrors: errs.length === 0 && fails.length === 0,
  },
}, null, 1));
await browser.close();
