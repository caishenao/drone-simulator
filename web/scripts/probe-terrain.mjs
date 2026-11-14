// 临时诊断：确认地形是否真的接上、地形瓦片量、无头渲染帧率。
import { createRequire } from 'node:module'

const require = createRequire('C:/Users/31941/.workbuddy/binaries/node/workspace/package.json')
const { chromium } = require('playwright-core')

const CHROME = 'C:/Users/31941/AppData/Local/ms-playwright/chromium-1254/chrome-win64/chrome.exe'
const URL = 'http://127.0.0.1:5188/#/flight'

const headed = process.env.HEADED === '1'
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: !headed,
  args: headed ? [] : ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('console', (m) => {
  if (m.type() === 'error') console.log('CONSOLE-ERR', m.text().slice(0, 300))
})
page.on('requestfailed', (r) => {
  const u = r.url()
  if (u.includes('elevation3d') || u.includes('terrain')) console.log('TERRAIN-REQFAIL', u.slice(0, 120))
})
let terrainReq = 0
page.on('response', (r) => {
  if (r.url().includes('elevation3d.arcgis.com')) terrainReq += 1
})

const t0 = Date.now()
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90_000 })
await page.waitForFunction(() => window.__droneDebug && window.__droneDebug().ready, null, {
  timeout: 120_000,
})
console.log('ready ms =', Date.now() - t0)

const info = await page.evaluate(() => {
  const s = window.__scene
  const v = s.viewer
  const surface = v.scene.globe._surface
  return {
    terrainProvider: v.terrainProvider?.constructor?.name ?? 'none',
    isArcGis: v.terrainProvider instanceof window.Cesium.ArcGISTiledElevationTerrainProvider,
    isEllipsoid: v.terrainProvider instanceof window.Cesium.EllipsoidTerrainProvider,
    groundElevation: s.groundElevation,
    originHeight: s.originCartographic?.height,
    tilesToRender: surface?._tilesToRender?.length ?? -1,
    level: surface?._tilesToRender?.[0]?._level,
    imageryLayers: v.imageryLayers.length,
    buildings: s.buildingCount,
  }
})
console.log('INFO', JSON.stringify(info))

const fps = await page.evaluate(
  () =>
    new Promise((res) => {
      let n = 0
      const t = performance.now()
      const tick = () => {
        n += 1
        if (performance.now() - t < 4000) requestAnimationFrame(tick)
        else res(n / ((performance.now() - t) / 1000))
      }
      requestAnimationFrame(tick)
    }),
)
console.log('fps(terrain) =', fps.toFixed(2), 'terrain tiles =', terrainReq)

// 对照：同样场景切回椭球地形，帧率是否恢复 —— 用来确认「慢」是地形渲染本身
await page.evaluate(() => {
  window.__scene.viewer.terrainProvider = new window.Cesium.EllipsoidTerrainProvider()
})
await page.waitForTimeout(1500)
const fps2 = await page.evaluate(
  () =>
    new Promise((res) => {
      let n = 0
      const t = performance.now()
      const tick = () => {
        n += 1
        if (performance.now() - t < 4000) requestAnimationFrame(tick)
        else res(n / ((performance.now() - t) / 1000))
      }
      requestAnimationFrame(tick)
    }),
)
console.log('fps(ellipsoid) =', fps2.toFixed(2))

await page.screenshot({ path: 'shots/probe_terrain.png' })
await browser.close()
