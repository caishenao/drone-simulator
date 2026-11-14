// 地形碰撞自检。
//
// 背景：物理层的地面判定原本是常数平面 environment.ground_y_m，
// 地形虽然渲染出真实起伏，机体照样穿山而过 —— 视觉上飞机埋进山体，物理上毫无反应。
//
// 这里分两层验证：
//   A. 真实地形数据层（Cesium ArcGIS 高程）：
//      地面高度随位置变化、地表法向正确、高度场有数据、埋进山体会被推回地表。
//   B. 物理碰撞层（注入可控斜面）：
//      斜面上不穿透、高速撞山解体、沿坡下滑。
//      用 mock 是为了不受网络与地形瓦片加载时序影响，断言必须稳定可复现。
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire('C:/Users/31941/.workbuddy/binaries/node/workspace/package.json')
const { chromium } = require('playwright-core')

const CHROME = 'C:/Users/31941/AppData/Local/ms-playwright/chromium-1254/chrome-win64/chrome.exe'
// 必须开着地形：这一整套断言验证的就是「真实高程参与碰撞」
const URL = 'http://127.0.0.1:5188/?terrain=1#/flight'
const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(HERE, '..', 'shots')
mkdirSync(OUT, { recursive: true })

const checks = []
function ck(name, ok, detail = '') {
  checks.push({ name, ok: !!ok, detail: String(detail) })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
  ],
})
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)))
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90_000 })
await page.waitForFunction(() => window.__droneDebug && window.__droneDebug().ready, null, {
  timeout: 180_000,
})
await page.waitForFunction(() => window.__droneSim.takeoff.locating === false, null, { timeout: 60_000 })

// ————————————————————————————————————————————
// A. 真实地形数据层
// ————————————————————————————————————————————

// 切到玉龙雪山：山脊山谷落差大，坡度明显
const took = await page.evaluate(async () => {
  const r = await window.__droneSim.setTakeoff({
    lon: 100.186,
    lat: 27.099,
    name: '玉龙雪山',
    detail: '地形碰撞自检',
    kind: '山峰',
    source: 'search',
  })
  return r
})
ck('切到玉龙雪山', took === true)
// 场景切换是异步的：等建筑加载完 + 地形采样完 + 原点高程真的变成玉龙雪山的海拔
const arrived = await page
  .waitForFunction(
    () => {
      const d = window.__droneDebug()
      return (
        d.takeoff.place.name === '玉龙雪山' &&
        !d.takeoff.loading &&
        !d.takeoff.locating &&
        window.__scene.groundElevation > 4000
      )
    },
    null,
    { timeout: 90_000 },
  )
  .then(() => true)
  .catch(() => false)
ck('场景已切到玉龙雪山（高程 > 4000 m）', arrived)
await page.waitForTimeout(2500)

const data = await page.evaluate(() => {
  const s = window.__scene
  const pts = []
  // 采样半径要够大：玉龙雪山主峰顶相当平坦，200 m 内落差只有十几米，
  // 取 ±600 m 才看得出山脊走向
  for (const [x, z] of [
    [0, 0],
    [400, 0],
    [-400, 0],
    [0, 400],
    [0, -400],
    [600, 600],
    [-600, 600],
    [600, -600],
  ]) {
    pts.push({ x, z, h: s.groundHeightAt(x, z), n: s.groundNormalAt(x, z) })
  }
  return {
    pts,
    fieldReady: s.terrainField?.ready === true,
    fieldCount: s.terrainField?.countValid?.() ?? 0,
    originGround: s.groundElevation,
  }
})

ck('地形高度场已灌入数据', data.fieldReady && data.fieldCount > 1000, `${data.fieldCount} 格`)
ck('原点高程是真实海拔（玉龙雪山 > 4000 m）', data.originGround > 4000, `${data.originGround.toFixed(0)} m`)

const hs = data.pts.map((p) => p.h)
const spread = Math.max(...hs) - Math.min(...hs)
ck('地面高度随位置变化（不是常数平面）', spread > 20, `落差 ${spread.toFixed(1)} m`)

const allUp = data.pts.every((p) => p.n && p.n.length === 3 && p.n[1] > 0)
ck('地表法向朝上且为三维单位向量', allUp)

const sloped = data.pts.filter((p) => p.n && p.n[1] < 0.9999)
ck('能识别出斜坡（法向不竖直）', sloped.length > 0, `${sloped.length}/8 个采样点有坡度`)

const unit = data.pts.every((p) => {
  if (!p.n) return false
  const L = Math.hypot(p.n[0], p.n[1], p.n[2])
  return Math.abs(L - 1) < 1e-6
})
ck('法向是单位向量', unit)

// ————————————————————————————————————————————
// B. 真实地形下：埋进山体会被推回地表
// ————————————————————————————————————————————

const buried = await page.evaluate(() => {
  const s = window.__scene
  const b = window.__droneSim.body
  const x = 300
  const z = 300
  const gh = s.groundHeightAt(x, z)
  b.position = [x, gh - 8, z]
  b.velocity = [0, 0, 0]
  b.omega = [0, 0, 0]
  return { gh, y: b.position[1] }
})
ck('机体已埋入地表以下 8 m', buried.y < buried.gh - 7, `y=${buried.y.toFixed(1)} 地面=${buried.gh.toFixed(1)}`)

await page.waitForTimeout(2500)
const pushed = await page.evaluate(() => {
  const s = window.__scene
  const b = window.__droneSim.body
  return {
    y: b.position[1],
    gh: s.groundHeightAt(b.position[0], b.position[2]),
    clearance: b.groundClearance(),
    crash: { ...window.__droneDebug().crash },
  }
})
ck(
  '埋进山体的机体被推回地表之上',
  pushed.y > pushed.gh - 0.5,
  `y=${pushed.y.toFixed(1)} 地面=${pushed.gh.toFixed(1)}`,
)
ck(
  '离地高度不再为负（未被深埋）',
  pushed.clearance > -1,
  `${pushed.clearance.toFixed(2)} m`,
)
ck('埋入不算高速撞击，不应解体', pushed.crash.active === false)

// ————————————————————————————————————————————
// C. 关闭地形碰撞 → 退回常数平面
// ————————————————————————————————————————————

const off = await page.evaluate(async () => {
  const s = window.__scene
  const sim = window.__droneSim
  const ghReal = s.groundHeightAt(300, 300)
  sim.setTerrainCollision(false)
  const b = sim.body
  const gh = s.groundHeightAt(300, 300)
  b.position = [300, ghReal - 20, 300]
  b.velocity = [0, 0, 0]
  return { gh, ghReal, provider: b.groundProvider }
})
ck('关闭后地面退回常数（0）', off.gh === 0, `groundHeightAt=${off.gh}`)
ck('关闭后物理层不再注入地形', off.provider === null)

await page.waitForTimeout(1500)
const still = await page.evaluate(() => {
  const b = window.__droneSim.body
  return { y: b.position[1], v: b.velocity[1] }
})
ck(
  '关闭后地面是水平面（机体停在 y=0）',
  Math.abs(still.y) < 1.5,
  `y=${still.y.toFixed(2)} vy=${still.v.toFixed(2)}`,
)
if (Math.abs(off.ghReal) > 50) {
  ck(
    '关闭后「山体」消失（机体悬在真实地表上方很远）',
    still.y - off.ghReal > 50,
    `机体 ${still.y.toFixed(1)} vs 真实地表 ${off.ghReal.toFixed(1)}`,
  )
}

await page.evaluate(() => window.__droneSim.setTerrainCollision(true))
await page.waitForTimeout(800)

// ————————————————————————————————————————————
// D. 物理碰撞层：注入可控斜面
//    用 mock 而非真实地形，是为了断言稳定可复现（不受网络与瓦片加载时序影响）
// ————————————————————————————————————————————

const slope = await page.evaluate(() => {
  const sim = window.__droneSim
  const b = sim.body
  const K = 0.6 // 坡度：h = K * x，约 31°
  const L = Math.hypot(K, 1)
  b.groundProvider = (x) => K * x
  b.groundNormalProvider = () => [-K / L, 1 / L, 0]
  // 关键：必须关掉悬停油门。
  // 悬停推力恰好平衡重力，机体根本落不到斜面上（实测还会被顶起来 1.5 m）。
  // 关机自由落体 1.2 m → 触地速度 4.85 m/s，法向分量 4.2 < 5，不触发解体。
  sim.setThrottle(0)
  b.position = [0, 1.2, 0]
  b.velocity = [0, 0, 0]
  b.omega = [0, 0, 0]
  b.groundImpact = 0
  return { K, L }
})

// 落到斜面上：在页面内连续采样，抓「接触」这个瞬时状态
// （groundImpact 每个 step 都会被清零，只在撞击那一帧有值，事后读必然是 0）
//
// 关键：循环按「仿真时间」收敛，而不是墙钟。
// 无头软件渲染下物理帧被钳到 0.05 s/帧，6 秒墙钟只推进 0.42 s 仿真时间 ——
// 用墙钟当判据会永远等不到落地。
const landed = await page.evaluate(async () => {
  const b = window.__droneSim.body
  const K = 0.6
  const t0 = b.time
  let minAbove = Infinity
  let sawContact = false
  while (b.time - t0 < 2.2) {
    const above = b.position[1] - K * b.position[0]
    if (above < minAbove) minAbove = above
    if (b.contact) sawContact = true
    await new Promise((r) => setTimeout(r, 30))
  }
  const surf = K * b.position[0]
  return {
    y: b.position[1],
    surf,
    above: b.position[1] - surf,
    minAbove,
    sawContact,
    contact: b.contact,
    simTime: b.time - t0,
    clearance: b.groundClearance(),
    crash: { ...window.__droneDebug().crash },
  }
})
ck(
  '落到斜面时出现过接触',
  landed.sawContact === true,
  `最低离面 ${landed.minAbove.toFixed(2)} m（仿真 ${landed.simTime.toFixed(2)} s）`,
)
ck(
  '落到斜面上而不是穿透',
  landed.minAbove > -0.5 && landed.above < 4,
  `最低离面 ${landed.minAbove.toFixed(2)} m，当前离面 ${landed.above.toFixed(2)} m`,
)
ck('落在斜面上不算高速撞击', landed.crash.active === false)

// 高速撞山 → 解体（朝上坡方向冲，斜面 h = 0.6x，+x 是上坡）
await page.evaluate(() => {
  const sim = window.__droneSim
  const b = sim.body
  b.position = [0, 5, 0]
  b.velocity = [26, 0, 0]
  b.omega = [0, 0, 0]
  b.groundImpact = 0
})
const crashed = await page
  .waitForFunction(() => window.__droneDebug().crash.active === true, null, { timeout: 30_000 })
  .then(() => true)
  .catch(() => false)
const crashInfo = await page.evaluate(() => ({ ...window.__droneDebug().crash }))
ck('高速撞山触发解体', crashed, `target=${crashInfo.target} impact=${crashInfo.impact.toFixed(1)}`)
ck('解体目标标记为「山体」', crashInfo.target === '山体', crashInfo.target)

// ————————————————————————————————————————————
// E. 顺坡下滑：静止在斜面上的物体会往下坡走
// ————————————————————————————————————————————

await page.evaluate(() => {
  const sim = window.__droneSim
  sim.reset()
})
await page.waitForTimeout(1200)
const slid = await page.evaluate(async () => {
  const sim = window.__droneSim
  const b = sim.body
  const K = 0.6
  const L = Math.hypot(K, 1)
  b.groundProvider = (x) => K * x
  b.groundNormalProvider = () => [-K / L, 1 / L, 0]
  sim.setThrottle(0)
  b.position = [0, 0.35, 0]
  b.velocity = [0, 0, 0]
  b.omega = [0, 0, 0]
  const x0 = b.position[0]
  const t0 = b.time
  // 同样按仿真时间收敛：无头下墙钟不可靠
  while (b.time - t0 < 1.6) {
    await new Promise((r) => setTimeout(r, 30))
  }
  return { x0, x1: b.position[0], vx: b.velocity[0], simTime: b.time - t0 }
})
ck(
  '斜坡上的物体会顺坡下滑（往低处走）',
  slid.x1 < slid.x0 - 0.05,
  `x ${slid.x0.toFixed(2)} → ${slid.x1.toFixed(2)} m`,
)

// 收尾：恢复真实地形
await page.evaluate(() => {
  const sim = window.__droneSim
  sim.reset()
  sim.body.groundProvider = null
  sim.body.groundNormalProvider = null
})

ck('页面无未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))

const passed = checks.filter((c) => c.ok).length
console.log(`\n${passed}/${checks.length} 通过`)
writeFileSync(
  resolve(OUT, 'report-terrain-collision.json'),
  JSON.stringify({ passed, total: checks.length, checks, pageErrors }, null, 2),
)
await browser.close()
process.exit(passed === checks.length ? 0 : 1)
