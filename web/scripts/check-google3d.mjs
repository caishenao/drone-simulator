// Google 3D 实景可用性自检：面板选项增删是否到位、没有 key 时的降级链路是否可靠。
//
// 真实加载需要 Google Map Tiles API key + 能连 tile.googleapis.com 的网络，
// 本机两样都没有，所以这里验证的是「失败路径」——而失败路径恰恰才是演示时最先遇到的那条：
// 点了没反应 / 掉了底图 / 建筑开关被卡住，都是不能接受的。
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire('C:/Users/31941/.workbuddy/binaries/node/workspace/package.json')
const { chromium } = require('playwright-core')

const CHROME = 'C:/Users/31941/AppData/Local/ms-playwright/chromium-1254/chrome-win64/chrome.exe'
// ?terrain=0：无头软件渲染下真实高程会把帧率压到 1 FPS 以下，这里不测地形
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
const page = await browser.newPage({ viewport: { width: 720, height: 480 } })
const errs = []
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message))
page.on('console', (m) => {
  if (m.type() !== 'error') return
  const t = m.text()
  if (t.includes('429')) return
  errs.push('CONSOLE ' + t)
})

const dbg = () => page.evaluate(() => window.__droneDebug())
const sceneProp = (key) => page.evaluate((k) => window.__scene[k], key)

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90_000 })
await page.waitForFunction(() => window.__droneDebug && window.__droneDebug().ready, null, {
  timeout: 120_000,
})

// ---- 1. 面板选项：删掉两张空底图，加进 Google 3D ----
const labels = await page.$$eval('button', (els) => els.map((e) => (e.textContent || '').trim()))
ck('已移除「离线底图」选项', !labels.includes('离线底图'))
ck('已移除「无底图」选项', !labels.includes('无底图'))
ck('新增「Google 3D 实景」选项', labels.includes('Google 3D 实景'))

// ---- 2. 默认仍是 Esri：不允许把需要 key + 代理的底图设成默认 ----
let s = await dbg()
ck('默认底图仍为 Esri 卫星', s.scene.imagery === 'esri', s.scene.imagery)
ck('默认底图有影像层', s.scene.imageryLayers >= 1, `${s.scene.imageryLayers} 层`)

// ---- 3. 无 key 点击：必须回落，而不是白屏或卡死 ----
const googleBtn = page.locator('button', { hasText: 'Google 3D 实景' }).first()
await googleBtn.click()
await page
  .waitForFunction(() => window.__droneDebug().ui.mapNote.length > 0, null, { timeout: 20_000 })
  .catch(() => {})
s = await dbg()
ck('无 key 时自动回落 Esri', s.scene.imagery === 'esri', s.scene.imagery)
ck('面板给出可操作的原因', s.ui.mapNote.includes('VITE_GOOGLE_MAPS_KEY'), s.ui.mapNote)
ck('回落时影像层已恢复（地面不是空的）', s.scene.imageryLayers >= 1, `${s.scene.imageryLayers} 层`)
ck('没有残留的 Google tileset', (await sceneProp('googleTileset')) === null)
const buildingsOn = await sceneProp('buildingsOn')
ck('建筑开关未被卡住（失败时不该收起）', s.ui.buildings === true && buildingsOn === true)

// 降级后按钮不该停在 Google 上，否则用户会以为「已经切过去了」
ck('Google 按钮未高亮', !(await googleBtn.getAttribute('class'))?.includes('on'))

// ---- 4. 换回 Esri：上一次的失败提示要清掉 ----
await page.locator('button', { hasText: 'Esri 卫星' }).first().click()
await page.waitForTimeout(600)
s = await dbg()
ck('切回 Esri 后提示清除', s.ui.mapNote === '', `mapNote="${s.ui.mapNote}"`)

// ---- 5. 其余底图仍可用（天地图即便被限流也会回落，但不能崩） ----
await page.locator('button', { hasText: '天地图矢量' }).first().click()
await page.waitForTimeout(2500)
s = await dbg()
ck(
  '切到天地图矢量后底图仍有效',
  s.scene.imagery === 'tianditu-vec' ? s.scene.imageryLayers >= 1 : s.scene.imagery === 'esri',
  `${s.scene.imagery} · ${s.scene.imageryLayers} 层`,
)

ck('无页面脚本错误', errs.length === 0, errs.slice(0, 2).join(' | '))

await page.screenshot({ path: OUT + '/93_google3d_fallback.png' })

const passed = checks.filter((c) => c.ok).length
console.log(`\n${passed}/${checks.length} 通过`)
writeFileSync(
  OUT + '/report-google3d.json',
  JSON.stringify({ passed, total: checks.length, checks, errors: errs }, null, 2),
  'utf8',
)
await browser.close()
process.exit(passed === checks.length ? 0 : 1)
