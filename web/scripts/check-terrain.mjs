// 真实高程自检：地形是否真的接上、原点是否落在地表、山区与平原的高程差是否成立。
//
// 单独一份是因为 swiftshader 软件渲染下地形会把帧率从 ~240 压到 ~0.5，
// 跑不进 check-cesium.mjs 那套「按仿真时间推进」的飞行回归里。
// 这里只做少量与地形强相关的断言，并且尽量用 waitForFunction 而不是固定等待。
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire('C:/Users/31941/.workbuddy/binaries/node/workspace/package.json')
const { chromium } = require('playwright-core')

const CHROME = 'C:/Users/31941/AppData/Local/ms-playwright/chromium-1254/chrome-win64/chrome.exe'
// 小视口：软件渲染下地形开销主要在顶点与着色器，但像素量减半也能省不少
const URL = 'http://127.0.0.1:5188/#/flight'
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
  // 天地图 key 限流是外部配额问题，与地形无关
  if (t.includes('429')) return
  errs.push('CONSOLE ' + t)
})

let terrainTiles = 0
page.on('response', (r) => {
  if (r.url().includes('elevation3d.arcgis.com/arcgis/rest') && r.status() === 200) terrainTiles += 1
})

const dbg = () => page.evaluate(() => window.__droneDebug())
const probe = () =>
  page.evaluate(() => {
    const s = window.__scene
    const v = s.viewer
    const surface = v.scene.globe._surface
    return {
      isArcGis: v.terrainProvider instanceof window.Cesium.ArcGISTiledElevationTerrainProvider,
      isEllipsoid: v.terrainProvider instanceof window.Cesium.EllipsoidTerrainProvider,
      ground: s.groundElevation,
      originH: s.originCartographic.height,
      level: surface?._tilesToRender?.[0]?._level ?? -1,
      tiles: surface?._tilesToRender?.length ?? -1,
    }
  })

const t0 = Date.now()
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90_000 })
await page.waitForFunction(() => window.__droneDebug && window.__droneDebug().ready, null, {
  timeout: 120_000,
})
const loadMs = Date.now() - t0

// ---- 1. 地形真的挂上了 ----
let p = await probe()
ck('地形 provider 为 ArcGIS 全球高程', p.isArcGis && !p.isEllipsoid, `arcgis=${p.isArcGis}`)
ck('起飞点高程已采样（新加坡 ≈ 33 m）', p.ground > 5 && p.ground < 80, `${p.ground.toFixed(1)} m`)
ck(
  '场景原点落在地表（origin 高度 == 采样高程）',
  Math.abs(p.originH - p.ground) < 0.5,
  `origin ${p.originH.toFixed(2)} m / ground ${p.ground.toFixed(2)} m`,
)
ck('地形瓦片已参与渲染', p.tiles > 0 && p.level >= 6, `${p.tiles} 块 · 最高 ${p.level} 级`)

// 机体应当仍在「原点地面上方 150 m」，而不是被地形抬走或埋掉
const first = await dbg()
ck(
  '机体仍停在原点上方 150 m（地形不改变局部高度）',
  Math.abs(first.tele.altitude - 150) < 2,
  `高度 ${first.tele.altitude.toFixed(1)} m`,
)

/** 手动摆机位：追尾相机会每帧覆盖相机，先切自由视角再 setView */
async function look(lon, lat, backDeg, height, pitchDeg) {
  await page.evaluate(
    ([lo, la, back, h, pitch]) => {
      window.__droneSim.setFollowMode('free')
      const C = window.Cesium
      window.__scene.viewer.camera.setView({
        destination: C.Cartesian3.fromDegrees(lo, la + back, h),
        orientation: { heading: 0, pitch: C.Math.toRadians(pitch), roll: 0 },
      })
    },
    [lon, lat, backDeg, height, pitchDeg],
  )
}

await look(103.848, 1.2805, 0.012, 900, -32)
await page.waitForTimeout(6000)
await page.screenshot({ path: OUT + '/90_terrain_city.png' })

// 截图前收起右侧面板，否则起飞点面板会盖住大半个画面
const collapse = page.locator('button', { hasText: '收起面板' }).first()
if (await collapse.count()) await collapse.click({ timeout: 3000 }).catch(() => {})

// ---- 2. 换到高原：高程必须跟着换 ----
// 拉萨 91.11E / 29.65N，市区海拔约 3650 m
await page.evaluate(() => window.__scene.setOrigin(91.11, 29.65))
await page
  .waitForFunction(() => window.__scene.groundElevation > 2000, null, { timeout: 60_000 })
  .catch(() => {})
p = await probe()
ck('切到拉萨后高程升到高原量级', p.ground > 3000 && p.ground < 4200, `${p.ground.toFixed(0)} m`)
ck(
  '原点随高程重新定位',
  Math.abs(p.originH - p.ground) < 0.5,
  `origin ${p.originH.toFixed(2)} m`,
)

// ---- 3. 换到山地：玉龙雪山一带应有数千米高差 ----
await page.evaluate(() => window.__scene.setOrigin(100.18, 27.1))
await page
  .waitForFunction(() => window.__scene.groundElevation > 2500, null, { timeout: 60_000 })
  .catch(() => {})
p = await probe()
ck('切到玉龙雪山后高程为高山量级', p.ground > 2500, `${p.ground.toFixed(0)} m`)

// 山区截图：等一批地形瓦片到位再把机位拉到山前平视，才能看出山脊与山谷的遮挡关系
await page
  .waitForFunction(() => (window.__scene.viewer.scene.globe._surface?._tilesToRender?.length ?? 0) > 0, null, {
    timeout: 60_000,
  })
  .catch(() => {})
await look(100.18, 27.1, -0.07, p.ground + 2600, -14)
await page.waitForTimeout(20_000)
await page.screenshot({ path: OUT + '/91_terrain_mountain.png' })

// ---- 4. 地形瓦片请求确实成功过 ----
ck('地形瓦片请求成功', terrainTiles > 0, `${terrainTiles} 片`)

// ---- 5. 关掉地形时不报错（自检与降级路径） ----
ck('无页面脚本错误', errs.length === 0, errs.slice(0, 2).join(' | '))

const passed = checks.filter((c) => c.ok).length
console.log(`\n${passed}/${checks.length} 通过 · 地形瓦片 ${terrainTiles} 片 · 加载 ${(loadMs / 1000).toFixed(1)}s`)
writeFileSync(
  OUT + '/report-terrain.json',
  JSON.stringify({ passed, total: checks.length, checks, errors: errs, loadMs }, null, 2),
  'utf8',
)
await browser.close()
process.exit(passed === checks.length ? 0 : 1)
