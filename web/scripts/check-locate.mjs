// 屏幕遥测 HUD 与任意起飞点选择的端到端自检：
// HUD 数值一致、H 键开关、地图点选（含 Esc 取消）、经纬度输入、山区地名搜索。
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire('C:/Users/31941/.workbuddy/binaries/node/workspace/package.json')
const { chromium } = require('playwright-core')

const CHROME = 'C:/Users/31941/AppData/Local/ms-playwright/chromium-1254/chrome-win64/chrome.exe'
// ?terrain=0：无头软件渲染下真实高程会把帧率压到 1 FPS 以下，飞行类断言会全部超时
// （地形本身由 check-terrain.mjs 专门验证）
const URL = 'http://127.0.0.1:5188/?terrain=0#/flight'
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'shots')
mkdirSync(OUT, { recursive: true })

const checks = []
const ck = (name, ok, detail = '') => {
  checks.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errs = []
const throttled = []
const netErrs = []
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message))
page.on('console', (m) => {
  if (m.type() !== 'error') return
  const text = m.text()
  // 瓦片 / 地名服务的连接被重置属于网络波动，不算脚本错误
  if (text.includes('429')) throttled.push(text)
  else if (text.includes('Failed to load resource')) netErrs.push(text)
  else errs.push('CONSOLE ' + text)
})

const dbg = () => page.evaluate(() => window.__droneDebug())
const idle = () =>
  page.waitForFunction(
    () => {
      const d = window.__droneDebug()
      return !d.takeoff.loading && !d.takeoff.locating
    },
    null,
    { timeout: 150_000 },
  )
/** 把机体摆到平飞姿态，避免起点的建筑/风向干扰数值比对 */
const settle = async () => {
  await page.evaluate(() => {
    const s = window.__droneSim
    s.reset()
    s.body.velocity = [0, 0, 0]
    s.body.omega = [0, 0, 0]
  })
  await page.waitForTimeout(600)
}

const t0 = Date.now()
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90_000 })
await page.waitForFunction(() => window.__droneDebug && window.__droneDebug().ready, null, {
  timeout: 120_000,
})
await idle().catch(() => {})
await page.waitForTimeout(1200)
const loadMs = Date.now() - t0

// ---- 1. HUD 存在且与遥测一致 ----
const hudInfo = await page.evaluate(() => {
  const el = document.querySelector('.hud')
  const d = window.__droneDebug()
  return {
    present: !!el,
    text: el ? el.innerText : '',
    box: el ? el.getBoundingClientRect().toJSON() : null,
    alt: d.tele.altitude,
    thr: d.tele.throttle,
    lat: d.tele.lat,
    lon: d.tele.lon,
  }
})
ck('屏幕内遥测 HUD 已显示', hudInfo.present, hudInfo.present ? `${Math.round(hudInfo.box.width)}×${Math.round(hudInfo.box.height)}` : '未找到 .hud')
ck(
  'HUD 高度与遥测一致',
  hudInfo.text.includes(hudInfo.alt.toFixed(1)),
  `HUD 含 ${hudInfo.alt.toFixed(1)} · 遥测 ${hudInfo.alt.toFixed(2)} m`,
)
ck(
  'HUD 油门与遥测一致',
  hudInfo.text.includes(Math.round(hudInfo.thr * 100) + '%'),
  `油门 ${(hudInfo.thr * 100).toFixed(0)}%`,
)
ck(
  'HUD 显示当前经纬度',
  hudInfo.text.includes(hudInfo.lat.toFixed(4)) && hudInfo.text.includes(hudInfo.lon.toFixed(4)),
  `${hudInfo.lat.toFixed(4)}, ${hudInfo.lon.toFixed(4)}`,
)
ck('HUD 不遮挡侧栏', hudInfo.box.right < 1440 - 320, `HUD 右边界 ${Math.round(hudInfo.box.right)}px`)

// ---- 2. H 键开关 ----
await page.keyboard.press('KeyH')
await page.waitForTimeout(250)
const hudOff = await page.evaluate(() => !document.querySelector('.hud'))
ck('H 键可隐藏 HUD', hudOff)
await page.keyboard.press('KeyH')
await page.waitForTimeout(250)
const hudOn = await page.evaluate(() => !!document.querySelector('.hud'))
ck('再按 H 恢复 HUD', hudOn)

// ---- 3. 点选模式：提示条 + Esc 取消 ----
await page.locator('button.pick').click()
await page.waitForTimeout(350)
const pickOn = await page.evaluate(() => ({
  picking: window.__droneDebug().ui.picking,
  bar: (document.querySelector('.pickbar')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
  cursor: window.__scene.viewer.scene.canvas.style.cursor,
  follow: window.__droneDebug().ui.followMode,
}))
ck(
  '进入地图点选模式有提示且光标变十字',
  pickOn.picking && pickOn.bar.includes('设为起飞点') && pickOn.cursor === 'crosshair',
  `${pickOn.bar.slice(0, 24)}… · cursor=${pickOn.cursor || 'default'}`,
)
ck(
  '点选时切到自由视角（可拖动地图找位置）',
  pickOn.follow === 'free',
  `follow=${pickOn.follow}`,
)
await page.screenshot({ path: OUT + '/50_pick_mode.png' })
await page.keyboard.press('Escape')
// Vue Transition 的离场动画靠 rAF 推进，无头低帧率下 250ms 不保证节点已移除
await page.waitForFunction(() => !document.querySelector('.pickbar'), null, { timeout: 4000 }).catch(() => {})
await page.waitForTimeout(200)
const pickEsc = await page.evaluate(() => ({
  picking: window.__droneDebug().ui.picking,
  bar: !!document.querySelector('.pickbar'),
  cursor: window.__scene.viewer.scene.canvas.style.cursor,
  follow: window.__droneDebug().ui.followMode,
}))
ck(
  'Esc 取消点选并恢复原镜头',
  !pickEsc.picking && !pickEsc.bar && pickEsc.cursor !== 'crosshair' && pickEsc.follow === 'chase',
  `picking=${pickEsc.picking} · follow=${pickEsc.follow} · cursor=${pickEsc.cursor || 'default'}`,
)

// ---- 4. 地图点选真实落地 ----
const before = await page.evaluate(() => {
  const d = window.__droneDebug()
  return { lon: d.takeoff.place.lon, lat: d.takeoff.place.lat, origin: d.scene.origin }
})
await page.locator('button.pick').click()
await page.waitForTimeout(300)
await page.mouse.click(430, 650)
await idle()
await page.waitForTimeout(1200)
const picked = await page.evaluate(() => {
  const d = window.__droneDebug()
  return {
    lon: d.takeoff.place.lon,
    lat: d.takeoff.place.lat,
    name: d.takeoff.place.name,
    source: d.takeoff.place.source,
    picking: d.ui.picking,
    origin: d.scene.origin,
    buildings: d.buildings,
    note: d.takeoff.note,
  }
})
const mLon = (picked.origin[0] - before.origin[0]) * 111320 * Math.cos((before.origin[1] * Math.PI) / 180)
const mLat = (picked.origin[1] - before.origin[1]) * 110540
const moved = Math.hypot(mLon, mLat)
ck(
  '地图点选把起飞点搬到点击处',
  picked.source === 'manual' && moved > 20 && !picked.picking,
  `${picked.name} · 位移 ${moved.toFixed(0)} m · ${picked.buildings} 栋`,
)
ck(
  '点选后场景原点与起飞点一致',
  Math.abs(picked.origin[0] - picked.lon) < 1e-6 && Math.abs(picked.origin[1] - picked.lat) < 1e-6,
  `${picked.lon.toFixed(5)}, ${picked.lat.toFixed(5)}`,
)
await page.screenshot({ path: OUT + '/52_pick_landed.png' })

// ---- 5. 经纬度输入：支持「经度, 纬度」反序 ----
await page.locator('details.fold summary', { hasText: '输入经纬度' }).click()
await page.waitForTimeout(250)
await page.locator('.coordrow input').fill('116.4602, 39.9026')
await page.locator('.coordrow button').click()
await idle()
await page.waitForTimeout(900)
const bj = await dbg()
const conv = { lon: bj.takeoff.place.lon, lat: bj.takeoff.place.lat, origin: bj.scene.origin, note: bj.takeoff.note }
ck(
  '坐标输入自动识别「经度, 纬度」顺序',
  Math.abs(conv.origin[0] - 116.4602) < 1e-5 && Math.abs(conv.origin[1] - 39.9026) < 1e-5,
  `原点 ${conv.origin[0].toFixed(4)}, ${conv.origin[1].toFixed(4)}`,
)
ck('坐标输入走后端解析并给出提示', conv.note.includes('坐标'), conv.note)
await settle()
await page.screenshot({ path: OUT + '/53_coord_input.png' })

// ---- 6. 非法坐标不搬场景 ----
const badBefore = await page.evaluate(() => window.__droneDebug().scene.origin)
await page.locator('.coordrow input').fill('999, 999')
await page.locator('.coordrow button').click()
await page.waitForTimeout(500)
const bad = await page.evaluate(() => ({
  err: (document.querySelector('.fold .err')?.textContent ?? '').trim(),
  origin: window.__droneDebug().scene.origin,
}))
ck(
  '非法坐标给出错误且不搬场景',
  bad.err.length > 0 && Math.abs(bad.origin[0] - badBefore[0]) < 1e-9,
  bad.err || '无错误提示',
)

// ---- 7. 搜索任意地点（山区）：有结果就落地，无结果只记录 ----
await page.locator('.search input').fill('珠穆朗玛峰')
await page.locator('.search button').click()
await page
  .waitForFunction(() => document.querySelectorAll('.results li').length > 0, null, { timeout: 45_000 })
  .catch(() => {})
const results = await page.locator('.results li').allInnerTexts()
if (!results.length) {
  console.log('SKIP  山区地名搜索：网络或地名服务不可用')
} else {
  ck('地名搜索支持山峰等任意地点', /\S/.test(results[0]), results[0].replace(/\n/g, ' · ').slice(0, 60))
  await page.locator('.results li').first().click()
  await idle()
  await page.waitForTimeout(1500)
  const mtn = await dbg()
  ck(
    '可落地到无 3D 建筑的山区',
    mtn.takeoff.place.name.includes('珠') || mtn.takeoff.place.kind === '山峰' || mtn.buildings === 0,
    `${mtn.takeoff.place.name} · ${mtn.buildings} 栋 · ${mtn.takeoff.place.lon.toFixed(3)}, ${mtn.takeoff.place.lat.toFixed(3)}`,
  )
  ck(
    '无建筑区域给出可继续飞行的提示',
    !!mtn.takeoff.error && mtn.takeoff.error.includes('仍可自由飞行'),
    mtn.takeoff.error || '缺少提示',
  )
  await page.screenshot({ path: OUT + '/55_mountain.png' })
}

// ---- 8. 无脚本错误 ----
ck('无页面脚本错误', errs.length === 0, `${errs.length} 条脚本错误 · ${netErrs.length} 条资源波动`)

const passed = checks.filter((c) => c.ok).length
writeFileSync(
  resolve(OUT, 'report-locate.json'),
  JSON.stringify({ passed, total: checks.length, checks, errors: errs, netErrs, throttled, loadMs }, null, 2),
)
console.log(`\n${passed}/${checks.length} 通过 · 429 限流 ${throttled.length} 条`)
await browser.close()
process.exit(passed === checks.length ? 0 : 1)
