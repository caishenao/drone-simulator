// 端到端流程自检：首页 → 飞行配置页 → 选点 → 镜头过渡 → 飞行页 → 回到配置页。
//
// 这一条链路是新加的（配置页、机型切换、轨迹配色、视角过渡），
// 单测覆盖不到「点开始飞行之后镜头有没有真的切过去」，必须用浏览器跑一遍。
//
// 注意：无头 swiftshader 下不能按墙钟等待 —— 软件渲染一帧要几百毫秒，
// 仿真时间推进比真实时间慢得多，所有等待都按仿真时间 / 状态标志来卡。
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire('C:/Users/31941/.workbuddy/binaries/node/workspace/package.json')
const { chromium } = require('playwright-core')

const CHROME = 'C:/Users/31941/AppData/Local/ms-playwright/chromium-1254/chrome-win64/chrome.exe'
// terrain=0：关掉真实高程。无头软件渲染下地形会把帧率压到 1 FPS 以下，
// 过渡动画与仿真推进都跑不动。地形本身另有 check-terrain-collision.mjs 专门验证。
const URL = 'http://127.0.0.1:5188/?terrain=0'
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)))
const consoleErrors = []
page.on('console', (m) => {
  if (m.type() !== 'error') return
  const t = m.text()
  if (t.includes('429')) return // 天地图限流是外部配额问题，不算页面错误
  consoleErrors.push(t.slice(0, 200))
})

// ————————————————————————————————————————————
// 1. 首页
// ————————————————————————————————————————————
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90_000 })
await page.waitForSelector('text=3D 地图飞行', { timeout: 20_000 })
ck('首页渲染出「3D 地图飞行」卡片', true)
const cards = await page.locator('button.card').count()
ck('首页功能卡片数量 ≥ 4', cards >= 4, `${cards} 张`)
ck('首页默认不加载三维地球', (await page.locator('.cesium-viewer').count()) === 0)

// ————————————————————————————————————————————
// 2. 进入配置页
// ————————————————————————————————————————————
await page.locator('button.card.active').click()
await page.waitForFunction(() => location.hash.includes('config'), null, { timeout: 10_000 })
ck('点击卡片进入飞行配置页', page.url().includes('#/config'), page.url())
await page.waitForSelector('.panel .drone', { timeout: 20_000 })
await page.waitForFunction(() => window.__droneDebug && window.__droneDebug().ready, null, {
  timeout: 180_000,
})
ck('配置页三维地球就绪', true)
ck('配置页渲染三张机型卡片', (await page.locator('.panel .drone').count()) === 3)
ck('配置页渲染轨迹色板', (await page.locator('.swatch').count()) >= 6)
ck('配置页渲染起飞点卡片', (await page.locator('.place .launch').count()) === 1)

// 配置页不该跑物理：没有起飞点之前飞行状态是冻结的
const cfgTime = await page.evaluate(() => window.__droneDebug().tele.time)
ck('配置页不推进飞行物理', cfgTime === 0, `t=${cfgTime}`)

// ————————————————————————————————————————————
// 3. 机型切换：物理参数与悬停油门跟着变
// ————————————————————————————————————————————
await page.locator('.drone', { hasText: '微型穿越机' }).click()
await page.waitForTimeout(200)
const cine = await page.evaluate(() => ({
  id: window.__droneSim.ui.droneTypeId,
  hover: window.__droneSim.hoverThrottle,
  mass: window.__droneSim.body.p.body.mass_kg,
  scale: window.__droneSim.ui.droneScale,
}))
ck('机型切到微型穿越机', cine.id === 'cinewhoop', cine.id)
ck('穿越机质量生效（95 g）', Math.abs(cine.mass - 0.095) < 1e-6, `${cine.mass} kg`)
ck(
  '悬停油门按机型重算（mg / 最大推力 ≈ 0.32）',
  Math.abs(cine.hover - (0.095 * 9.81) / 2.9) < 0.01,
  cine.hover.toFixed(4),
)
ck('视觉比例随机型切换（×5）', cine.scale === 5, `×${cine.scale}`)

// 换回基准机型
await page.locator('.drone', { hasText: 'Mini 3 Pro' }).click()
await page.waitForTimeout(200)
const mini = await page.evaluate(() => ({
  id: window.__droneSim.ui.droneTypeId,
  hover: window.__droneSim.hoverThrottle,
  mass: window.__droneSim.body.p.body.mass_kg,
}))
ck('机型切回 Mini 3 Pro', mini.id === 'mini3pro', mini.id)
ck('基准机质量生效（249 g）', Math.abs(mini.mass - 0.249) < 1e-6, `${mini.mass} kg`)
ck(
  '悬停油门回到 0.45 附近',
  Math.abs(mini.hover - 0.455) < 0.005,
  mini.hover.toFixed(4),
)

// ————————————————————————————————————————————
// 4. 轨迹配置：颜色与线宽落到场景
// ————————————————————————————————————————————
await page.locator('.swatch[title="荧光绿"]').click()
await page.waitForTimeout(200)
const trail = await page.evaluate(() => window.__scene.trailStyle)
ck('轨迹颜色切换生效', trail.color.toLowerCase() === '#57ffb0', trail.color)

// 关掉轨迹显示
await page.locator('.panel .row2 button', { hasText: '轨迹显示' }).click()
await page.waitForTimeout(150)
const trailOff = await page.evaluate(() => window.__droneSim.ui.trail)
ck('轨迹显示开关生效', trailOff === false, `trail=${trailOff}`)
await page.locator('.panel .row2 button', { hasText: '轨迹显示' }).click()
await page.waitForTimeout(150)
const trailOn = await page.evaluate(() => window.__droneSim.ui.trail)
ck('轨迹显示可恢复', trailOn === true, `trail=${trailOn}`)

// ————————————————————————————————————————————
// 5. 选点：直接调预览接口换起飞点
// ————————————————————————————————————————————
const picked = await page.evaluate(async () => {
  const ok = await window.__droneSim.previewPlace({
    lon: 116.4602,
    lat: 39.9026,
    name: '北京 · 国贸',
    source: 'preset',
  })
  const d = window.__droneDebug()
  return { ok, origin: d.scene.origin, place: d.takeoff.place.name }
})
ck('配置页可预览起飞点', picked.ok === true, JSON.stringify(picked.origin))
ck('场景原点跟随选点', Math.abs(picked.origin[0] - 116.4602) < 1e-3, `${picked.origin}`)

// ————————————————————————————————————————————
// 6. 开始飞行：镜头过渡 + 物理循环
// ————————————————————————————————————————————
const camBefore = await page.evaluate(() => {
  const c = window.__scene.viewer.camera
  return { h: c.height, len: c.positionCartographic.height }
})
await page.locator('.place .launch').click()
await page.waitForFunction(() => location.hash.includes('flight'), null, { timeout: 30_000 })
ck('开始飞行后进入飞行页', page.url().includes('#/flight'), page.url())

// 过渡动画需要真实帧推进，等仿真时间走起来再判断镜头
await page.waitForFunction(() => window.__droneDebug().tele.time > 0.5, null, { timeout: 60_000 })
const after = await page.evaluate(() => {
  const d = window.__droneDebug()
  const c = window.__scene.viewer.camera
  return {
    time: d.tele.time,
    follow: d.scene.follow,
    dist: d.scene.distance,
    alt: c.positionCartographic.height,
    origin: d.scene.origin,
    drone: d.scene.drone,
    inputs: d.scene.inputs,
  }
})
ck('飞行页物理循环已启动', after.time > 0.5, `t=${after.time.toFixed(2)}s`)
ck('镜头已切到跟随机位', after.follow === 'chase', after.follow)
ck(
  '镜头停在追尾距离附近（不是俯视全景）',
  after.dist > 3 && after.dist < 90,
  `${after.dist.toFixed(1)} m`,
)
ck(
  '相机高度降到机体高度带（不再是高空俯瞰）',
  Math.abs(after.alt - 150) < 400,
  `相机海拔 ${after.alt.toFixed(0)} m`,
)
ck('飞行页锁定手动相机输入（跟随机位不被拖动）', after.inputs === false, `inputs=${after.inputs}`)
await page.screenshot({ path: resolve(OUT, 'flow-flight.png') })

// ————————————————————————————————————————————
// 7. 回到配置页：物理停摆、镜头交回自由视角
// ————————————————————————————————————————————
await page.locator('.topbar button', { hasText: '重新配置' }).click()
await page.waitForFunction(() => location.hash.includes('config'), null, { timeout: 20_000 })
// 回到配置页会重播一遍俯视全景动画，动画期间 Cesium 会锁住手动输入，
// 结束后才交还给用户 —— 这里等它解锁再断言
await page.waitForFunction(() => window.__droneDebug().scene.inputs === true, null, {
  timeout: 20_000,
})
const back = await page.evaluate(() => {
  const d = window.__droneDebug()
  return { stage: d.stage, follow: d.scene.follow, inputs: d.scene.inputs, time: d.tele.time }
})
ck('可从飞行页回到配置页', back.stage === 'config', back.stage)
ck(
  '回到配置页后镜头交回自由视角（可拖动地球）',
  back.follow === 'free' && back.inputs === true,
  JSON.stringify(back),
)

// ————————————————————————————————————————————
// 8. 无脚本错误
// ————————————————————————————————————————————
ck('页面无 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))
ck('控制台无错误', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))

await page.screenshot({ path: resolve(OUT, 'flow-config.png') })
writeFileSync(
  resolve(OUT, 'flow-report.json'),
  JSON.stringify({ checks, at: new Date().toISOString() }, null, 2),
)

const pass = checks.filter((c) => c.ok).length
console.log(`\n${pass}/${checks.length} 通过`)
await browser.close()
process.exit(pass === checks.length ? 0 : 1)
