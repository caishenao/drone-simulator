// 天空/地面视觉分层 + 落地不穿模的端到端验证
import { createRequire } from 'node:module';
const require = createRequire('C:/Users/31941/.workbuddy/binaries/node/workspace/package.json');
const { chromium } = require('playwright-core');

const CHROME = 'C:/Users/31941/AppData/Local/ms-playwright/chromium-1254/chrome-win64/chrome.exe';
const BASE = 'http://127.0.0.1:8899';
const OUT = 'D:/work/self/无人机模型器/examples/frontend/';
const PAGES = [
  { name: '主预览页', url: BASE + '/threejs_drone.html', tag: 'main', hasDrop: true, scale: 10 },
  { name: '物理演示页', url: BASE + '/examples/frontend/physics.html', tag: 'physics', hasDrop: true, scale: 1 },
  { name: '最小示例', url: BASE + '/examples/frontend/index.html', tag: 'minimal', hasDrop: false, scale: 1 },
];

const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
const results = [];
for (const p of PAGES) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const errs = [], fails = [];
  page.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  page.on('requestfailed', r => fails.push(r.url()));
  await page.goto(p.url, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForFunction(() => !!window.__droneView, { timeout: 60000 });
  await page.waitForTimeout(1000);
  const skyShot = OUT + 'check_sky_' + p.tag + '.png';
  await page.screenshot({ path: skyShot });

  let clearance = null;
  if (p.hasDrop) {
    await page.locator('#b-drop').click();
    await page.waitForTimeout(2600);
    clearance = await page.evaluate(() => window.__dronePhysics.groundClearance());
  }
  const droneY = await page.evaluate(() => window.__droneView.state().drone[1]);
  const groundShot = OUT + 'check_ground_' + p.tag + '.png';
  await page.screenshot({ path: groundShot });

  results.push({
    page: p.name, skyShot, groundShot, scale: p.scale,
    clearance_m: clearance === null ? null : +clearance.toFixed(5),
    droneY_m: +(droneY / p.scale).toFixed(5),
    errors: errs, requestFailures: fails,
    assertions: {
      landedWithoutClipping: p.hasDrop
        ? clearance >= 0.003 - 1e-6
        : droneY / p.scale >= 0.052 - 1e-6,
      noErrors: errs.length === 0 && fails.length === 0,
    },
  });
  await page.close();
}
console.log(JSON.stringify(results, null, 1));
await browser.close();
