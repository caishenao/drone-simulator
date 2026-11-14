// Cesium 前端端到端自检：模型加载、飞行、跟随相机、图层切换、零报错。
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire('C:/Users/31941/.workbuddy/binaries/node/workspace/package.json')
const { chromium } = require('playwright-core')

const CHROME = 'C:/Users/31941/AppData/Local/ms-playwright/chromium-1254/chrome-win64/chrome.exe'
const URL = 'http://127.0.0.1:5188/?terrain=0#/flight'
// 关掉真实高程：swiftshader 软件渲染下地形会把帧率从 ~240 压到 ~0.5，
// advance() 这种按仿真时间推进的断言会全部超时。地形另有 check-terrain.mjs 专门验证。
// 相对脚本自身定位，项目整体搬迁后不必再改绝对路径
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
const fails = []
// 天地图对同一 key 有短时限流：429 是外部配额问题，单独统计，不算页面脚本错误
const throttled = []
page.on('pageerror', (e) => errs.push(`[#${checks.length}] PAGEERROR ` + e.message))
let dumped = false
page.on('console', (m) => {
  if (m.type() !== 'error') return
  const text = m.text()
  if (text.includes('429')) {
    throttled.push(text)
    return
  }
  errs.push(`[#${checks.length}] CONSOLE ` + text)
  // 渲染中断时立刻抓一次各 primitive 的包围球，定位是哪个几何把 NaN 带进来的
  if (!dumped && text.includes('Rendering has stopped')) {
    dumped = true
    page
      .evaluate(() => window.__scene.debugPrimitives())
      .then((info) => console.log('PRIM_DUMP ' + JSON.stringify(info)))
      .catch(() => {})
  }
})
page.on('requestfailed', (r) => fails.push(r.url()))
let tileOk = 0
page.on('response', (r) => {
  const u = r.url()
  if ((u.includes('tianditu.gov.cn') || u.includes('arcgisonline.com')) && r.status() === 200) tileOk += 1
})

const t0 = Date.now()
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90_000 })
await page.waitForFunction(() => window.__droneDebug && window.__droneDebug().ready, null, {
  timeout: 120_000,
})
const loadMs = Date.now() - t0
// 建筑来自在线矢量瓦片：等 IP 定位 + 瓦片解析 + 几何构建完成再断言
await page.waitForFunction(
  () => {
    const t = window.__droneDebug().takeoff
    return t && !t.loading && !t.locating
  },
  null,
  { timeout: 150_000 },
)
// 等地表影像细化到位再截图：软件渲染下首批瓦片到位需要数秒
const groundReady = await page.evaluate(async () => {
  const lv = await window.__scene.waitForGround(18, 20_000)
  await window.__scene.waitForTiles(12_000)
  return lv
})
await page.waitForTimeout(800)

const dbg = () => page.evaluate(() => window.__droneDebug())

/** 按「仿真时间」推进：软件渲染下帧率低，墙钟时间不等于物理时间 */
async function advance(seconds, maxWallMs = 30_000) {
  const startTime = (await dbg()).tele.time
  const startWall = Date.now()
  while (Date.now() - startWall < maxWallMs) {
    await page.waitForTimeout(120)
    const t = (await dbg()).tele.time
    if (t - startTime >= seconds) return t - startTime
  }
  return (await dbg()).tele.time - startTime
}

/**
 * 等画面真正稳定后再截图。
 * 软件渲染（SwiftShader）下，瓦片刚上传完那几帧很容易被截到「已清屏、未绘制」的空帧
 * （整张图纯深底），只等固定毫秒数并不保险。这里做三件事：
 *   ① 等当前视角瓦片层级 3 次采样不变 + tilesLoaded；
 *   ② 以 postRender 同步到连续两帧画完之后；
 *   ③ 在 postRender 回调里把 Cesium 画布缩绘到 96×60 的 2D canvas 采样灰阶，
 *      空帧自动重试，最终把统计值返回给断言用。
 */
async function settleFrame(label, timeoutMs = 20_000) {
  const info = await page.evaluate(async (ms) => {
    const v = window.__scene.viewer
    const scene = v.scene
    const level = () => {
      const t = scene.globe?._surface?._tilesToRender
      return t && t.length ? Math.max(...t.map((x) => x.level)) : 0
    }
    const t0 = performance.now()
    let last = level()
    let stable = 0
    while (performance.now() - t0 < ms) {
      await new Promise((r) => setTimeout(r, 200))
      const now = level()
      if (now === last && scene.globe.tilesLoaded) stable += 1
      else {
        stable = 0
        last = now
      }
      if (stable >= 3) break
    }

    const sample = async () => {
      await new Promise((res) => {
        let n = 0
        const off = scene.postRender.addEventListener(() => {
          if (++n >= 2) {
            off()
            res(null)
          }
        })
        scene.requestRender()
      })
      const c2 = document.createElement('canvas')
      c2.width = 96
      c2.height = 60
      const g = c2.getContext('2d')
      g.drawImage(v.canvas, 0, 0, 96, 60)
      const d = g.getImageData(0, 0, 96, 60).data
      let sum = 0
      let min = 255
      let max = 0
      for (let i = 0; i < d.length; i += 4) {
        const l = (d[i] + d[i + 1] + d[i + 2]) / 3
        sum += l
        if (l < min) min = l
        if (l > max) max = l
      }
      return {
        mean: +(sum / (d.length / 4)).toFixed(1),
        min: Math.round(min),
        max: Math.round(max),
      }
    }

    let stats = await sample()
    for (let i = 0; i < 3 && stats.max - stats.min < 24; i++) {
      await new Promise((r) => setTimeout(r, 500))
      stats = await sample()
    }

    const cam = v.camera
    const car = Cesium.Cartographic.fromCartesian(cam.positionWC)
    return {
      ...stats,
      level: last,
      tilesLoaded: scene.globe.tilesLoaded,
      lon: +Cesium.Math.toDegrees(car.longitude).toFixed(4),
      lat: +Cesium.Math.toDegrees(car.latitude).toFixed(4),
      h: Math.round(car.height),
      heading: Math.round(Cesium.Math.toDegrees(cam.heading)),
      pitch: Math.round(Cesium.Math.toDegrees(cam.pitch)),
    }
  }, timeoutMs)
  console.log(`FRAME ${label} ` + JSON.stringify(info))
  return info
}

const first = await dbg()
/** 当前起飞点经纬度：相机/楼体筛选都以此为准，不能写死城市 */
const origin = first.scene.origin
// 天地图只覆盖中国境内：境外起飞点必须自动落到 Esri，否则地面是白底「无影像」占位图
const tdtCovered = origin[0] >= 73 && origin[0] <= 135 && origin[1] >= 17 && origin[1] <= 54
if (!tdtCovered) {
  await page
    .waitForFunction(() => window.__droneDebug().scene.imagery === 'esri', null, { timeout: 20_000 })
    .catch(() => {})
  const cov = await dbg()
  ck(
    '境外起飞点自动切换为 Esri 全球影像',
    cov.scene.imagery === 'esri',
    `${origin[0].toFixed(4)}, ${origin[1].toFixed(4)} · ${cov.scene.imagery}`,
  )
}
const pageTitle = await page.title()
ck('页面名称为「无人机模拟器」', pageTitle === '无人机模拟器', pageTitle)

ck('页面就绪（场景 + 模型 + 建筑）', first.ready === true, `${(loadMs / 1000).toFixed(1)}s`)
ck('无人机 GLB 已挂到 Cesium 场景', first.scene.model === true)
ck('在线 3D 建筑数量', first.buildings >= 200, `${first.buildings} 栋 · ${first.takeoff.tiles} 张瓦片`)
ck(
  '建筑刚体碰撞体已建立',
  first.scene.collision.buildings >= 200,
  `${first.scene.collision.buildings} 个碰撞体`,
)
ck(
  '建筑用带法线光照的 Primitive 渲染',
  first.scene.buildingPrimitive === true,
  `primitive=${first.scene.buildingPrimitive}`,
)
const VALID_SRC = ['ip', 'gps', 'search', 'manual', 'preset']
ck(
  '起飞点已自动确定（默认 IP 属地）',
  VALID_SRC.includes(first.takeoff.place.source),
  `${first.takeoff.place.name} · 来源 ${first.takeoff.place.source}`,
)
ck(
  '场景原点与起飞点经纬度一致',
  Math.abs(first.scene.origin[0] - first.takeoff.place.lon) < 1e-6 &&
    Math.abs(first.scene.origin[1] - first.takeoff.place.lat) < 1e-6,
  `${first.scene.origin[0].toFixed(4)}, ${first.scene.origin[1].toFixed(4)}`,
)
ck(
  '空气流场默认开启',
  first.ui.airflow === true && first.scene.airflow.count >= 60,
  `${first.scene.airflow.count} 条流线`,
)
// 流线必须只裹在机体周围：按 W 前飞时若扩散过大/过长，会铺满屏幕，观感就是「画面在闪」
const streamReach = await page.evaluate(() => {
  const b = window.__droneSim.body.position
  const parts = window.__droneDebug().scene.airflow.sample
  const dists = parts.map((p) => Math.hypot(p.x - b[0], p.y - b[1], p.z - b[2]))
  const sizes = parts.map((p) => p.w)
  return { maxDist: Math.max(...dists), maxSize: Math.max(...sizes) }
})
ck(
  '空气流线不糊屏（范围与长度受控）',
  streamReach.maxDist < 8 && streamReach.maxSize < 3,
  `最远 ${streamReach.maxDist.toFixed(1)} m · 最长 ${streamReach.maxSize.toFixed(2)} m`,
)
ck(
  '底图图层已挂载（天地图影像 + 注记，或限流回退后的 Esri）',
  first.scene.imageryLayers >= 1 && (first.scene.imagery === 'esri' || first.scene.labelLayer),
  `${first.scene.imageryLayers} 层 · imagery=${first.scene.imagery}`,
)
ck(
  '地表卫星瓦片细化到 18 级',
  groundReady && first.scene.tileLevel >= 18,
  `最高渲染层级 ${first.scene.tileLevel} · 成功瓦片 ${tileOk} 张`,
)
ck('默认追尾镜头接管相机输入', first.scene.inputs === false, `follow=${first.scene.follow}`)
ck(
  '相机与机体距离≈设定跟随距离',
  Math.abs(first.scene.distance - first.ui.distance) < 3,
  `${first.scene.distance.toFixed(1)} m / 设定 ${first.ui.distance} m`,
)
await page.screenshot({ path: OUT + '/01_overview.png' })

// ---- 悬停稳定 ----
const h0 = (await dbg()).tele.altitude
const hoverSeconds = await advance(1.5)
const h1 = (await dbg()).tele.altitude
ck(
  '悬停油门高度稳定',
  Math.abs(h1 - h0) < 3,
  `${h0.toFixed(1)} -> ${h1.toFixed(1)} m / 仿真 ${hoverSeconds.toFixed(1)}s`,
)

// ---- 键盘前飞：机体与相机都应位移 ----
const before = await dbg()
await page.keyboard.down('KeyW')
await advance(1.8)
await page.keyboard.up('KeyW')
await advance(0.3)
const after = await dbg()
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const droneMove = dist3(before.scene.drone, after.scene.drone)
const camMove = dist3(before.scene.camera, after.scene.camera)
ck('按键产生真实位移', droneMove > 5, `机体移动 ${droneMove.toFixed(1)} m`)
ck('相机跟随机体移动', camMove > 4, `相机移动 ${camMove.toFixed(1)} m`)
ck(
  '前飞方向为机头方向（向北）',
  after.tele.lat > before.tele.lat + 1e-6,
  `纬度 ${before.tele.lat.toFixed(5)} -> ${after.tele.lat.toFixed(5)}`,
)
ck(
  '飞行中相机仍锁定机体',
  after.scene.distance < 60,
  `距离 ${after.scene.distance.toFixed(1)} m`,
)
ck('飞行轨迹已记录', after.scene.trail.points >= 3, `${after.scene.trail.points} 个点`)
await page.screenshot({ path: OUT + '/02_chase.png' })

// ---- 空气流场近景（前飞时流线应最明显） ----
await page.evaluate(() => window.__droneSim.setDistance(12))
await page.keyboard.down('KeyW')
await advance(1.2)
await page.screenshot({ path: OUT + '/05_airflow.png' })
await page.keyboard.up('KeyW')
await page.evaluate(() => window.__droneSim.setDistance(22))
await advance(0.4)

// ---- 油门上升 ----
const altBefore = (await dbg()).tele.altitude
await page.evaluate(() => window.__droneSim.setThrottle(1))
await advance(1.6)
const altAfter = (await dbg()).tele.altitude
await page.evaluate(() => window.__droneSim.setThrottle(0.455))
ck('满油门爬升', altAfter - altBefore > 4, `${altBefore.toFixed(1)} -> ${altAfter.toFixed(1)} m`)

// ---- 镜头模式 ----
await page.evaluate(() => window.__droneSim.setFollowMode('free'))
await page.waitForTimeout(400)
const freeDbg = await dbg()
ck('自由视角交回相机控制', freeDbg.scene.inputs === true && freeDbg.scene.follow === 'free')

await page.evaluate(() => window.__droneSim.setFollowMode('world'))
await page.waitForTimeout(500)
const worldDbg = await dbg()
ck(
  '固定方位模式重新接管',
  worldDbg.scene.inputs === false && worldDbg.scene.follow === 'world',
  `距离 ${worldDbg.scene.distance.toFixed(1)} m`,
)

// ---- 图层切换：天地图矢量 / 注记层 + 建筑显隐 + 轨迹清空 ----
const errsBefore = errs.length
await page.evaluate(() => window.__droneSim.setImagery('tianditu-vec'))
await page.waitForTimeout(1200)
await page.evaluate(() => window.__droneSim.setBuildings(false))
await page.waitForTimeout(400)
const hidden = await page.evaluate(() => window.__droneSim.ui.buildings)
await page.evaluate(() => window.__droneSim.setBuildings(true))
await page.evaluate(() => window.__droneSim.setImagery('tianditu'))
await page.waitForTimeout(1500)
const backToTdt = await dbg()
ck('天地图矢量图切换不报错', errs.length === errsBefore, `${errs.length - errsBefore} 条新错误`)
ck(
  '切回天地图影像（限流或境外时自动回退 Esri）',
  backToTdt.scene.imagery === 'tianditu'
    ? backToTdt.scene.imageryLayers === 2
    : backToTdt.scene.imagery === 'esri',
  `${backToTdt.scene.imageryLayers} 层 · ${backToTdt.scene.imagery}`,
)
ck('建筑显隐开关生效', hidden === false)

await page.evaluate(() => window.__droneSim.clearTrail())
await page.waitForTimeout(300)
const trailCleared = await page.evaluate(() => window.__droneSim.ui.trailPoints)
ck('清空轨迹生效', trailCleared === 0, `${trailCleared} 个点`)

// ---- 复位 ----
await page.evaluate(() => window.__droneSim.reset())
await page.evaluate(() => window.__scene.waitForGround(15, 12_000))
await page.waitForTimeout(600)
const reset = await dbg()
ck(
  '复位回到起始高度',
  Math.abs(reset.tele.altitude - 150) < 2 && Math.abs(reset.ui.throttle - 0.455) < 1e-6,
  `高度 ${reset.tele.altitude.toFixed(1)} m`,
)
await page.screenshot({ path: OUT + '/03_reset.png' })

// ---- 刚体碰撞：低速落在楼顶只弹开，不解体 ----
await page.evaluate(() => window.__droneSim.reset())
await advance(0.3)
const roofInfo = await page.evaluate(() => {
  const s = window.__scene
  const sim = window.__droneSim
  // 射线法：凹多边形/带内院的楼，包围盒中心常落在楼外，选到它就撞不到楼顶
  const inside = (x, z, ring) => {
    let hit = false
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      const xi = ring[i], zi = ring[i + 1], xj = ring[j], zj = ring[j + 1]
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit
    }
    return hit
  }
  const list = s.collision.buildings
    .filter((b) => b.top > 40 && b.top < 200 && inside((b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2, b.ring))
    .sort((a, b) => (a.maxX - a.minX) * (a.maxZ - a.minZ) - (b.maxX - b.minX) * (b.maxZ - b.minZ))
  const b = list[Math.floor(list.length / 2)]
  if (!b) return { missing: true, name: '无候选建筑', top: 0 }
  sim.body.position = [(b.minX + b.maxX) / 2, b.top + 2, (b.minZ + b.maxZ) / 2]
  sim.body.velocity = [0, -2, 0]
  sim.body.quaternion = [0, 0, 0, 1]
  return { name: b.name || '建筑', top: b.top }
})
if (roofInfo.missing) throw new Error('低速撞楼顶：无可用候选楼体（多为 Vite 热重载把页面重置，稍后重跑即可）')
await page.waitForTimeout(2600)
const soft = await dbg()
ck(
  '低速落在楼顶只弹开、不解体',
  soft.crash.active === false && soft.tele.altitude > roofInfo.top - 0.6,
  `${roofInfo.name} 顶 ${roofInfo.top.toFixed(0)} m · 当前 ${soft.tele.altitude.toFixed(1)} m`,
)
ck(
  '接触楼顶后仍可继续飞行',
  soft.scene.droneVisible === true && Math.abs(soft.tele.altitude - roofInfo.top) < 3,
  `悬停在楼顶上方 ${(soft.tele.altitude - roofInfo.top).toFixed(1)} m · 未解体`,
)

// ---- 高速撞击 + 爆炸 + 重新开始 ----
await page.evaluate(() => window.__droneSim.reset())
await advance(0.3)
const crashTarget = await page.evaluate(() => {
  const s = window.__scene
  const sim = window.__droneSim
  // 选一栋中等体量的高楼，把机体悬在楼顶上方 3 m 并给 9 m/s 下坠速度
  // 射线法：凹多边形/带内院的楼，包围盒中心常落在楼外，选到它就撞不到楼顶
  const inside = (x, z, ring) => {
    let hit = false
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      const xi = ring[i], zi = ring[i + 1], xj = ring[j], zj = ring[j + 1]
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit
    }
    return hit
  }
  const list = s.collision.buildings
    .filter((b) => b.top > 60 && b.top < 260 && inside((b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2, b.ring))
    .sort((a, b) => (a.maxX - a.minX) * (a.maxZ - a.minZ) - (b.maxX - b.minX) * (b.maxZ - b.minZ))
  const b = list[Math.floor(list.length / 2)]
  if (!b) return { missing: true, name: '无候选建筑', top: 0 }
  const cx = (b.minX + b.maxX) / 2
  const cz = (b.minZ + b.maxZ) / 2
  sim.body.position = [cx, b.top + 3, cz]
  sim.body.velocity = [0, -9, 0]
  sim.body.quaternion = [0, 0, 0, 1]
  return { name: b.name || '未知建筑', top: b.top }
})
if (crashTarget.missing) throw new Error('高速撞楼：无可用候选楼体（多为 Vite 热重载把页面重置，稍后重跑即可）')
// 软件渲染下帧率低，按「撞毁事件」等待而不是按墙钟时间
await page
  .waitForFunction(() => window.__droneDebug().crash.active === true, null, { timeout: 20_000 })
  .catch(() => {})
await page.waitForTimeout(150)
const crashDbg = await dbg()
ck(
  '高速撞击建筑触发机体解体',
  crashDbg.crash.active === true,
  `${crashTarget.name}（${crashTarget.top.toFixed(0)} m）· 法向 ${crashDbg.crash.impact.toFixed(1)} m/s`,
)
ck(
  '撞击瞬间生成爆炸特效',
  crashDbg.scene.explosion.active === true && crashDbg.scene.explosion.particles >= 30,
  `${crashDbg.scene.explosion.particles} 个粒子`,
)
ck('撞毁后机身已隐藏', crashDbg.scene.droneVisible === false)
ck('撞毁后飞行停止（速度归零）', Math.abs(crashDbg.tele.speed) < 0.01, `${crashDbg.tele.speed.toFixed(2)} m/s`)
ck('撞毁后弹出重飞提示', crashDbg.crash.active === true && crashDbg.crash.target.length > 0, crashDbg.crash.target)
// 死亡镜头 0.25 s 内退到位，此时火球正盛；再等就看余烬了
await page.waitForTimeout(320)
await page.screenshot({ path: OUT + '/06_crash.png' })
await page.waitForTimeout(1500)
await page.screenshot({ path: OUT + '/07_crash_smoke.png' })

await page.evaluate(() => window.__droneSim.restart())
await page.waitForTimeout(1200)
const restarted = await dbg()
ck(
  '重新开始回到起始点',
  restarted.crash.active === false && Math.abs(restarted.tele.altitude - 150) < 8,
  `高度 ${restarted.tele.altitude.toFixed(1)} m`,
)
ck('重新开始恢复机身显示', restarted.scene.droneVisible === true)
ck('重新开始清空爆炸粒子', restarted.scene.explosion.particles === 0)

// ---- 高空航拍图（交付用） ----
await page.evaluate((o) => {
  window.__droneSim.setFollowMode('free')
  window.__scene.viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(o[0], o[1], 620),
    // 必须传 HeadingPitchRoll 实例：给 {heading,pitch,roll} 字面量时 Cesium 会当成
    // {direction,up} 分支处理，相机方向变成朝外太空，画面全黑
    orientation: new Cesium.HeadingPitchRoll(
      Cesium.Math.toRadians(20),
      Cesium.Math.toRadians(-38),
      0,
    ),
  })
}, origin)
const aerialReady = await page.evaluate(async () => {
  const ok = await window.__scene.waitForGround(16, 20_000)
  await window.__scene.waitForTiles(12_000)
  return ok
})
await page.waitForTimeout(200)
const aerialFrame = await settleFrame('aerial')
await page.screenshot({ path: OUT + '/04_aerial.png' })
const cullBad = await page.evaluate(() => window.__cullBad ?? null)
if (cullBad) console.log('CULL_BAD ' + JSON.stringify(cullBad))
ck(
  '高空航拍视角成像',
  aerialReady && aerialFrame.h > 500 && aerialFrame.max - aerialFrame.min > 24,
  `层级 ${aerialFrame.level} · 机位 ${aerialFrame.h} m / 俯角 ${aerialFrame.pitch}° · 灰阶 ${aerialFrame.min}~${aerialFrame.max}`,
)

// ---- 渲染画面非空白 ----
const stats = await page.evaluate(async () => {
  const canvas = document.querySelector('canvas.cesium-widget-canvas') || document.querySelector('canvas')
  if (!canvas) return null
  return { width: canvas.width, height: canvas.height }
})
ck('WebGL 画布已创建', !!stats && stats.width > 100, stats ? `${stats.width}×${stats.height}` : '无 canvas')

const isTile = (u) => u.includes('tianditu.gov.cn') || u.includes('arcgisonline.com')
const tileFails = fails.filter(isTile)
const otherFails = fails.filter((u) => !isTile(u))
ck('无页面脚本错误', errs.length === 0, errs.slice(0, 3).join(' | '))
ck('无影像/脚本资源加载失败', otherFails.length === 0, otherFails.slice(0, 3).join(' | '))

// ---- 切换起飞点：原点搬移 + 建筑重新生成 ----
await page.evaluate(() => {
  const sim = window.__droneSim
  const bj = sim.presets.find((p) => p.name.indexOf('北京') === 0)
  return sim.setTakeoff(bj)
})
await page.waitForFunction(
  () => {
    const d = window.__droneDebug()
    return d.takeoff.place.name.indexOf('北京') === 0 && !d.takeoff.loading && !d.takeoff.locating
  },
  null,
  { timeout: 150_000 },
)
const moved = await dbg()
ck(
  '切换起飞点后场景原点搬移',
  Math.abs(moved.scene.origin[0] - 116.4602) < 1e-3 && Math.abs(moved.scene.origin[1] - 39.9026) < 1e-3,
  `${moved.scene.origin[0].toFixed(4)}, ${moved.scene.origin[1].toFixed(4)}`,
)
ck(
  '新起飞点重新生成建筑与碰撞体',
  moved.buildings > 40 && moved.scene.collision.buildings === moved.buildings,
  `${moved.buildings} 栋 / ${moved.scene.collision.buildings} 碰撞体 · ${moved.takeoff.tiles} 张瓦片`,
)
ck(
  '切换后机体回到新原点上方且未损毁',
  Math.abs(moved.tele.altitude - 150) < 12 && moved.crash.active === false,
  `高度 ${moved.tele.altitude.toFixed(1)} m`,
)
// 交付图：把镜头对准新城市里最高的那栋楼（国贸是中国尊 528 m）。
// 只按固定俯角平视会把超高层全部裁到画幅外，看起来只剩一片矮房
await page.evaluate(() => {
  const v = window.__scene.viewer
  const list = window.__scene.buildingsData || []
  const tall = list.reduce((a, b) => (b.height > (a?.height ?? 0) ? b : a), null)
  const o = window.__droneDebug().scene.origin
  let lon = o[0]
  let lat = o[1]
  if (tall) {
    let sx = 0
    let sz = 0
    const n = tall.ring.length / 2
    for (let i = 0; i < tall.ring.length; i += 2) {
      sx += tall.ring[i]
      sz += tall.ring[i + 1]
    }
    // 局部米制 → 经纬度（仅用于取景，不用作坐标真值）
    lon = o[0] + sx / n / (111320 * Math.cos((o[1] * Math.PI) / 180))
    lat = o[1] - sz / n / 110540
  }
  window.__droneSim.setFollowMode('free')
  v.camera.lookAt(
    Cesium.Cartesian3.fromDegrees(lon, lat, 260),
    new Cesium.HeadingPitchRange(
      Cesium.Math.toRadians(340),
      Cesium.Math.toRadians(-7),
      2400,
    ),
  )
  v.camera.lookAtTransform(Cesium.Matrix4.IDENTITY)
})
await page.evaluate(async () => {
  await window.__scene.waitForGround(17, 20_000)
  await window.__scene.waitForTiles(10_000)
})
const switchFrame = await settleFrame('switch')
await page.screenshot({ path: OUT + '/08_takeoff_switch.png' })
ck(
  '切换起飞点后城市重新成像',
  switchFrame.max - switchFrame.min > 24 && switchFrame.h > 150,
  `机位 ${switchFrame.h} m / 俯角 ${switchFrame.pitch}° · 灰阶 ${switchFrame.min}~${switchFrame.max}`,
)

const passed = checks.filter((c) => c.ok).length
console.log(
  `\n${passed}/${checks.length} 通过 · 影像瓦片请求失败 ${tileFails.length} 条 · 瓦片限流 429 ${throttled.length} 条`,
)
writeFileSync(
  OUT + '/report.json',
  JSON.stringify(
    {
      passed,
      total: checks.length,
      checks,
      errors: errs,
      throttled: throttled.slice(0, 3),
      requestFailures: { tiles: tileFails.slice(0, 5), other: otherFails.slice(0, 5) },
      loadMs,
    },
    null,
    2,
  ),
  'utf8',
)
await browser.close()
process.exit(passed === checks.length ? 0 : 1)
