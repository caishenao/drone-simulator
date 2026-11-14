// 占位瓦片修复自检。
//
// 现象：飞行中地面突然出现一大块 "Map data not yet available" 灰板，且永不消失。
// 根因：Esri MapServer 对未生成 / 无该级别数据的瓦片返回 HTTP 200 的灰底水印图，
// Cesium 当正常瓦片缓存。修复在 src/cesium/imagery.ts。
//
// 这里不用真去等 Esri 出占位（不可控），而是用 Playwright 拦截 18 级瓦片，
// 直接回一张实测抓下来的真占位图，然后看包装层是否按预期降级成低级别裁剪图。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire('C:/Users/31941/.workbuddy/binaries/node/workspace/package.json')
const { chromium } = require('playwright-core')

const CHROME = 'C:/Users/31941/AppData/Local/ms-playwright/chromium-1254/chrome-win64/chrome.exe'
const URL = 'http://127.0.0.1:5188/?terrain=0#/flight'
const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(HERE, '..', 'shots')
mkdirSync(OUT, { recursive: true })
const PLACEHOLDER = readFileSync(resolve(HERE, 'fixtures', 'esri-placeholder.jpg'))

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
const page = await browser.newPage({ viewport: { width: 720, height: 480 } })
const errs = []
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message))
page.on('console', (m) => {
  if (m.type() !== 'error') return
  const t = m.text()
  if (t.includes('429')) return
  errs.push('CONSOLE ' + t)
})

// 拦截 18 级瓦片：一律返回实测的占位图
let intercepted = 0
await page.route('**/MapServer/tile/18/**', async (route) => {
  intercepted += 1
  await route.fulfill({
    status: 200,
    headers: { 'content-type': 'image/jpeg', 'access-control-allow-origin': '*' },
    body: PLACEHOLDER,
  })
})

// 降级链路会先要 17 级，再退 16 / 14
const seen = { 14: 0, 16: 0, 17: 0, 19: 0 }
page.on('request', (r) => {
  const u = r.url()
  if (!u.includes('MapServer/tile/')) return
  for (const z of [14, 16, 17, 19]) if (u.includes(`/tile/${z}/`)) seen[z] += 1
})

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90_000 })
await page.waitForFunction(() => window.__droneDebug && window.__droneDebug().ready, null, {
  timeout: 120_000,
})

// 层序：0 = 11 级兜底、1 = 19 级主层、（境内可能还有 2 = 天地图注记）
const stack = await page.evaluate(() => {
  const layers = window.__scene.viewer.imageryLayers
  const out = []
  for (let i = 0; i < layers.length; i++) {
    const p = layers.get(i).imageryProvider
    out.push({ i, max: p.maximumLevel, alpha: p.hasAlphaChannel })
  }
  return out
})
ck('卫星影像叠了 11 级兜底层', stack[0]?.max === 11, `层 0 maximumLevel=${stack[0]?.max}`)
ck('主影像层仍是 19 级封顶', stack[1]?.max === 19, `层 1 maximumLevel=${stack[1]?.max}`)

// 直接问 provider 要瓦片：18 级全被拦截成占位图，19 级是真实影像
const probe = await page.evaluate(async () => {
  const p = window.__scene.viewer.imageryLayers.get(1).imageryProvider
  const name = (v) => (v ? v.constructor?.name : 'null')
  const bad = await p.requestImage(215698, 99323, 18)
  const good = await p.requestImage(431396, 198646, 19)
  return {
    bad: { ctor: name(bad), w: bad?.width ?? 0, h: bad?.height ?? 0 },
    good: { ctor: name(good), w: good?.width ?? 0, h: good?.height ?? 0 },
  }
})

ck('拦截确实生效（至少一次 18 级请求被替换成占位图）', intercepted > 0, `${intercepted} 次`)
ck(
  '占位瓦片被换成低级别裁剪图',
  probe.bad.ctor === 'HTMLCanvasElement' && probe.bad.w === 256 && probe.bad.h === 256,
  `${probe.bad.ctor} ${probe.bad.w}×${probe.bad.h}`,
)
ck('降级时先追 17 级瓦片', seen[17] > 0, `${seen[17]} 次`)
ck(
  '真实 19 级影像没被误判',
  probe.good.ctor !== 'HTMLCanvasElement',
  `${probe.good.ctor} ${probe.good.w}×${probe.good.h}`,
)

// 兜底层必须能出图（否则透明兜底会变成空洞）
const base = await page.evaluate(async () => {
  const p = window.__scene.viewer.imageryLayers.get(0).imageryProvider
  const img = await p.requestImage(13481, 6207, 14).catch(() => null)
  return { ctor: img ? img.constructor?.name : 'null', w: img?.width ?? 0 }
})
ck('11 级兜底层能正常出图', base.ctor !== 'null' && base.w === 256, `${base.ctor} ${base.w}`)

// 走一次真实渲染：搬到老山、切云台第一视角。此时 18 级瓦片仍全被伪装成占位图，
// 如果修复没生效，整片地面会是一块 "Map data not yet available" 灰板。
await page.waitForTimeout(4000) // 让启动时的 IP 定位跑完，避免与下面这次切点抢序号
const moved = await page.evaluate(() =>
  window.__droneSim.setTakeoff({
    lon: 116.2167,
    lat: 39.9149,
    name: '老山',
    detail: '北京市石景山区',
    kind: '山峰',
    source: 'search',
  }),
)
await page
  .waitForFunction(() => window.__droneSim.takeoff.place.name === '老山', null, { timeout: 30_000 })
  .catch(() => {})
const place = await page.evaluate(() => window.__droneSim.takeoff.place.name)
ck('起飞点已切到老山（未被启动定位顶掉）', moved === true && place === '老山', `${place}`)

await page.evaluate(() => {
  window.__droneSim.setFollowMode('fpv')
  window.__droneSim.setGimbal(-37, -37)
})
await page.waitForTimeout(12000)
await page.screenshot({ path: OUT + '/96_placeholder_fixed.png' })

ck('无页面脚本错误', errs.length === 0, errs.slice(0, 2).join(' | '))

const passed = checks.filter((c) => c.ok).length
console.log(`\n${passed}/${checks.length} 通过 · 拦截 ${intercepted} 次 · 16 级请求 ${seen[16]} 次`)
writeFileSync(
  OUT + '/report-tiles.json',
  JSON.stringify({ passed, total: checks.length, checks, errors: errs, intercepted, seen }, null, 2),
  'utf8',
)
await browser.close()
process.exit(passed === checks.length ? 0 : 1)
