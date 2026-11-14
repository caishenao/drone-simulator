// 特技飞行端到端自检：手动模式可连续横滚、一键横滚/一键倒飞、倒飞悬停、
// 倒扣切增稳能自动改平、3D 油门负值生效、UI 联动。
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
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message))
page.on('console', (m) => {
  if (m.type() !== 'error') return
  const text = m.text()
  if (text.includes('429')) throttled.push(text)
  else errs.push('CONSOLE ' + text)
})

const t0 = Date.now()
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90_000 })
await page.waitForFunction(() => window.__droneDebug && window.__droneDebug().ready, null, {
  timeout: 120_000,
})
await page.waitForFunction(
  () => {
    const d = window.__droneDebug()
    return d.buildings > 0 && !d.takeoff.loading && !d.takeoff.locating
  },
  null,
  { timeout: 120_000 },
).catch(() => {})
await page.evaluate(async () => {
  await window.__scene.waitForGround(17, 20_000)
  await window.__scene.waitForTiles(10_000)
})
const loadMs = Date.now() - t0

const dbg = () => page.evaluate(() => window.__droneDebug())

/** 按仿真时间推进；每秒采样一次姿态，便于统计滚转扫过的范围 */
async function advance(seconds, maxWallMs = 40_000) {
  const start = (await dbg()).tele.time
  const startWall = Date.now()
  while (Date.now() - startWall < maxWallMs) {
    await page.waitForTimeout(100)
    if ((await dbg()).tele.time - start >= seconds) break
  }
}

/** 推进并采样：返回这段时间里横滚角的最小/最大值与倒飞命中情况 */
async function sweep(seconds, maxWallMs = 40_000) {
  const start = (await dbg()).tele.time
  const startWall = Date.now()
  let min = 999
  let max = -999
  let inverted = false
  let upMin = 1
  let altMax = -1e9
  let altMin = 1e9
  while (Date.now() - startWall < maxWallMs) {
    const d = await dbg()
    const r = d.tele.roll
    min = Math.min(min, r)
    max = Math.max(max, r)
    upMin = Math.min(upMin, d.tele.upDot)
    altMax = Math.max(altMax, d.tele.altitude)
    altMin = Math.min(altMin, d.tele.altitude)
    if (d.tele.inverted) inverted = true
    if (d.tele.time - start >= seconds) break
    await page.waitForTimeout(80)
  }
  return { min, max, inverted, upMin, altMax, altMin }
}

/** 把飞机摆到 400 m 高空、姿态归零：特技动作会掉高，避免撞到楼顶干扰用例 */
async function liftTo(height = 400) {
  await page.evaluate((h) => {
    const s = window.__droneSim
    s.setStabilize(true)
    s.setThreeD(false)
    s.setThrottle(0.455)
    s.body.position = [0, h, 0]
    s.body.velocity = [0, 0, 0]
    s.body.omega = [0, 0, 0]
    s.body.quaternion = [0, 0, 0, 1]
  }, height)
  await advance(0.8)
}

const first = await dbg()
ck('页面就绪', first.ready === true, `${(loadMs / 1000).toFixed(1)}s`)
ck('默认为增稳模式', first.ui.stabilize === true && first.ui.threeD === false, JSON.stringify({ stabilize: first.ui.stabilize, threeD: first.ui.threeD }))

// ---- 1. 增稳模式下横滚被限制（自稳会顶回来）
await page.keyboard.down('KeyD')
const limited = await sweep(1.8)
await page.keyboard.up('KeyD')
await advance(0.6)
ck(
  '增稳模式横滚受自稳限制（无法翻过去）',
  limited.max < 70 && limited.min > -70 && !limited.inverted,
  `横滚 ${limited.min.toFixed(0)}°..${limited.max.toFixed(0)}°`,
)

// ---- 2. 手动模式按住 D 可连续横滚（滚过 180° 两侧）
await page.evaluate(() => window.__droneSim.setStabilize(false))
await advance(0.5)
await page.keyboard.down('KeyD')
const rolled = await sweep(3.2)
await page.keyboard.up('KeyD')
ck(
  '手动模式可连续横滚（A/D 全周滚转）',
  rolled.max > 120 && rolled.min < -120,
  `横滚 ${rolled.min.toFixed(0)}°..${rolled.max.toFixed(0)}°`,
)
await liftTo()

// ---- 3. 一键横滚：滚满 360° 后回到水平
await page.evaluate(() => window.__droneSim.setStabilize(true))
await page.keyboard.press('KeyK')
const flipRoll = await sweep(5.5)
await advance(2.2)
const afterRoll = await dbg()
ck(
  '一键横滚滚满一周',
  flipRoll.max > 120 && flipRoll.min < -120,
  `横滚 ${flipRoll.min.toFixed(0)}°..${flipRoll.max.toFixed(0)}°`,
)
ck(
  '横滚结束后自动改平',
  Math.abs(afterRoll.tele.roll) < 12 && Math.abs(afterRoll.tele.upDot) > 0.96,
  `横滚 ${afterRoll.tele.roll.toFixed(1)}° · up ${afterRoll.tele.upDot.toFixed(3)}`,
)
ck('横滚结束复位按钮状态', afterRoll.ui.flipping === false)

// ---- 4. 一键倒飞：滚 180° 停在倒置 + 反向悬停
await liftTo()
await page.keyboard.press('KeyL')
await page.waitForFunction(() => window.__droneSim.ui.flipping === false, null, { timeout: 30_000 })
// 翻完有 2.2s「接住」窗口：先满反向油门制动，再收敛到反向悬停
await advance(3.2)
const inv = await dbg()
ck(
  '一键倒飞后机身倒置',
  inv.tele.inverted === true && inv.tele.upDot < -0.97,
  `up ${inv.tele.upDot.toFixed(3)} · 横滚 ${inv.tele.roll.toFixed(0)}°`,
)
ck(
  '倒飞自动打开 3D 并给负油门',
  inv.ui.threeD === true && inv.ui.stabilize === false && inv.ui.throttle < -0.4,
  `3D=${inv.ui.threeD} 油门 ${(inv.ui.throttle * 100).toFixed(0)}% 模式=${inv.ui.stabilize ? '增稳' : '手动'}`,
)
ck(
  '倒飞推力仍朝上（负推力托住机身）',
  inv.tele.thrust < 0 && Math.abs(inv.tele.vertical) < 1.2,
  `总推力 ${inv.tele.thrust.toFixed(2)} N · 垂速 ${inv.tele.vertical.toFixed(2)} m/s`,
)

// ---- 5. 倒飞悬停 2.5s 掉高有限
const hoverStart = (await dbg()).tele.altitude
await advance(2.5)
const hoverEnd = await dbg()
ck(
  '倒飞悬停可保持高度',
  Math.abs(hoverEnd.tele.altitude - hoverStart) < 2 && hoverEnd.tele.inverted,
  `ΔH ${(hoverEnd.tele.altitude - hoverStart).toFixed(2)} m · up ${hoverEnd.tele.upDot.toFixed(2)}`,
)
await page.screenshot({ path: OUT + '/30_inverted_hover.png' })

// ---- 6. 倒飞状态仍可前飞（相对机体，位移非零）
const p0 = await page.evaluate(() => [...window.__droneSim.body.position])
await page.keyboard.down('KeyW')
await advance(1.4)
await page.keyboard.up('KeyW')
const p1 = await page.evaluate(() => [...window.__droneSim.body.position])
const p1tele = (await dbg()).tele
const horizontal = Math.hypot(p1[0] - p0[0], p1[2] - p0[2])
ck(
  '倒飞中仍可操纵飞行',
  horizontal > 3 && !p1tele.contact,
  `水平位移 ${horizontal.toFixed(1)} m · 垂速 ${p1tele.vertical.toFixed(2)} m/s`,
)

// ---- 7. 倒扣切回增稳：自动翻正
await page.evaluate(() => window.__droneSim.setStabilize(true))
await advance(3.2)
const recovered = await dbg()
ck(
  '倒扣切增稳可自动翻正',
  recovered.tele.inverted === false && recovered.tele.upDot > 0.9,
  `up ${recovered.tele.upDot.toFixed(3)} · 横滚 ${recovered.tele.roll.toFixed(0)}°`,
)
ck(
  '改平后油门回到正向',
  recovered.ui.throttle > 0.2,
  `${(recovered.ui.throttle * 100).toFixed(0)}%`,
)

// ---- 8. 关闭 3D 时负油门被夹回 0
await page.evaluate(() => {
  window.__droneSim.setThreeD(true)
  window.__droneSim.setThrottle(-0.6)
})
await advance(0.4)
const negOk = (await dbg()).ui.throttle
await page.evaluate(() => {
  window.__droneSim.setThreeD(false)
  window.__droneSim.setThrottle(-0.6)
})
await advance(0.4)
const clamped = (await dbg()).ui.throttle
ck('3D 模式允许负油门', negOk < -0.5, `${(negOk * 100).toFixed(0)}%`)
ck('关闭 3D 后负油门被夹到 0', clamped === 0, `${(clamped * 100).toFixed(0)}%`)

// ---- 9. UI：按钮进入倒飞、油门滑杆量程跟着 3D 变
await page.evaluate(() => window.__droneSim.reset())
await liftTo()
await page.locator('button', { hasText: '3D 双向油门' }).click()
await advance(0.4)
const slider = await page.evaluate(() => {
  const el = [...document.querySelectorAll('input[type=range]')].find((x) => x.max === '100')
  return el ? { min: el.min, max: el.max } : null
})
ck(
  '3D 开关连到油门滑杆量程',
  slider?.min === '-100' && slider?.max === '100',
  slider ? `${slider.min}..${slider.max}` : '未找到滑杆',
)
await page.locator('button', { hasText: '手动特技' }).click()
await page.locator('button', { hasText: '一键倒飞' }).click()
await page.waitForFunction(() => window.__droneSim.ui.flipping === false, null, { timeout: 30_000 })
await advance(1.2)
const uiInv = await dbg()
ck(
  '面板按钮一键倒飞可用',
  uiInv.tele.inverted === true,
  `up ${uiInv.tele.upDot.toFixed(2)} · 模式=${uiInv.ui.stabilize ? '增稳' : '手动'}`,
)
await page.screenshot({ path: OUT + '/31_inverted_ui.png' })

// 云台视角下倒飞：HUD 要有「倒飞」标记，画面仍保持水平（三轴增稳云台）
await page.evaluate(() => window.__droneSim.toggleFpv())
await advance(0.9)
const fpvInv = await page.evaluate(() => {
  const el = document.querySelector('.fpv-hud .inv')
  return { badge: el ? el.textContent.trim() : '', roll: Cesium.Math.toDegrees(window.__scene.viewer.camera.roll) }
})
ck(
  '云台视角倒飞显示「倒飞」标记',
  fpvInv.badge === '倒飞' && Math.min(Math.abs(fpvInv.roll) % 360, 360 - (Math.abs(fpvInv.roll) % 360)) < 0.6,
  `${fpvInv.badge || '无'} · 画面横滚 ${fpvInv.roll.toFixed(2)}°`,
)
await page.screenshot({ path: OUT + '/33_inverted_fpv.png' })
await page.evaluate(() => window.__droneSim.toggleFpv())
await advance(0.5)

// ---- 10. 倒飞视角截图（追尾镜头能看到机腹朝上）
await page.evaluate(() => window.__droneSim.setDistance(9))
await page.waitForTimeout(700)
await page.screenshot({ path: OUT + '/32_inverted_chase.png' })

ck('无页面脚本错误', errs.length === 0, errs.slice(0, 3).join(' | '))

const passed = checks.filter((c) => c.ok).length
writeFileSync(
  resolve(OUT, 'report-acro.json'),
  JSON.stringify({ passed, total: checks.length, checks, errors: errs, throttled }, null, 1),
)
console.log(`\n${passed}/${checks.length} 通过 · 429 限流 ${throttled.length} 条`)
await browser.close()
process.exit(passed === checks.length ? 0 : 1)
