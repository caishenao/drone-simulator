// 跟随相机端到端验证：无人机飞走后相机是否仍贴着它、三模式循环、归位、零报错
import { createRequire } from 'node:module';
const require = createRequire('C:/Users/31941/.workbuddy/binaries/node/workspace/package.json');
const { chromium } = require('playwright-core');

const CHROME = 'C:/Users/31941/AppData/Local/ms-playwright/chromium-1254/chrome-win64/chrome.exe';
const BASE = 'http://127.0.0.1:8899';
const M_TOL = 0.35;              // 统一按「米」比较（主预览页有 10× 显示缩放）
const PAGES = [
  { name: '主预览页', url: BASE + '/threejs_drone.html', hasBtn: true, tag: 'main' },
  { name: '物理演示页', url: BASE + '/examples/frontend/physics.html', hasBtn: true, tag: 'physics' },
  { name: '最小示例', url: BASE + '/examples/frontend/index.html', hasBtn: false, tag: 'minimal' },
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
  await page.waitForTimeout(900);

  const scale = await page.evaluate(() => window.__droneView.scale || 1);
  const state = async () => {
    const s = await page.evaluate(() => window.__droneView.state());
    return { ...s, lag_m: s.lag / scale };   // 归一化成米
  };
  const s0 = await state();

  // 油门拉高 + 持续前飞，让无人机明显离开初始位置
  await page.evaluate(() => {
    const s = document.getElementById('thr');
    if (s) { s.value = '85'; s.dispatchEvent(new Event('input')); }
  });
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1100);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(700);
  const s1 = await state();

  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const droneMoved = dist(s0.drone, s1.drone) / scale;   // 米
  const camMoved = dist(s0.camera, s1.camera) / scale;

  // 模式循环：world -> body -> off -> world，同时记录控制权归属
  const modes = [], enabled = [];
  for (let i = 0; i < 3; i++) {
    if (p.hasBtn) await page.locator('#b-follow').click();
    else await page.keyboard.press('KeyC');
    await page.waitForTimeout(140);
    const r = await page.evaluate(() => ({
      mode: window.__droneView.follow.mode,
      controls: window.__droneView.follow.controls.enabled,
    }));
    modes.push(r.mode); enabled.push(r.controls);
  }

  // 镜头归位：跟随模式下滞后应立刻归零
  let snapLag = null;
  if (p.hasBtn) {
    // 同步点按钮并立刻读 lag：若等一帧，高速飞行会重新产生正常滞后
    snapLag = await page.evaluate(() => {
      document.getElementById('b-snap').click();
      return window.__droneView.state().lag;
    }) / scale;
  }

  const shot = 'D:/work/self/无人机模型器/examples/frontend/check_follow_' + p.tag + '.png';
  await page.screenshot({ path: shot });

  results.push({
    page: p.name, shot, scale,
    s0: { mode: s0.mode, lag_m: +s0.lag_m.toFixed(4), camera: s0.camera.map(x => +x.toFixed(2)) },
    s1: { mode: s1.mode, lag_m: +s1.lag_m.toFixed(4), camera: s1.camera.map(x => +x.toFixed(2)) },
    droneMoved_m: +droneMoved.toFixed(3), camMoved_m: +camMoved.toFixed(3),
    modes, controlsEnabledByMode: enabled, snapLag_m: snapLag === null ? null : +snapLag.toFixed(4),
    errors: errs, requestFailures: fails,
    assertions: {
      initialFollows: s0.lag_m < M_TOL,
      droneActuallyMoved: droneMoved > 0.05,
      cameraFollowed: camMoved > 0.05,
      stillFollowingAfterFlight: s1.lag_m < M_TOL,
      modeCycle: JSON.stringify(modes) === JSON.stringify(['body', 'off', 'world']),
      offReturnsControl: enabled[1] === true,
      followTakesControlBack: enabled[2] === false,
      snapWorks: p.hasBtn ? snapLag < 0.02 : true,
      noErrors: errs.length === 0 && fails.length === 0,
    },
  });
  await page.close();
}
console.log(JSON.stringify(results, null, 1));
await browser.close();
