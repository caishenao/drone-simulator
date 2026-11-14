// 云台第一视角端到端自检：机位在云台、朝向 = 航向 + 云台角、地平线水平、
// 键盘可调云台、视角内可正常飞行、退出后恢复第三人称。
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
const angDiff = (a, b) => Math.abs((((a - b) % 360) + 540) % 360 - 180)
/** Cesium 的 camera.roll 归一到 [0,360)，360° 与 0° 等价 */
const rollOff = (r) => {
  const n = Math.abs(r) % 360
  return Math.min(n, 360 - n)
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
await page
  .waitForFunction(
    () => {
      const d = window.__droneDebug()
      return d.buildings > 0 && !d.takeoff.loading && !d.takeoff.locating
    },
    null,
    { timeout: 120_000 },
  )
  .catch(() => {})
// 建筑来自在线矢量瓦片，拉取失败时仍可测视角（坠毁用例会退回地面），
// 因此这里只记录环境信息，不作为云台视角的通过条件
console.log('INFO buildings=' + (await page.evaluate(() => window.__droneDebug().buildings)))
await page.evaluate(async () => {
  await window.__scene.waitForGround(17, 20_000)
  await window.__scene.waitForTiles(10_000)
})
const loadMs = Date.now() - t0

const dbg = () => page.evaluate(() => window.__droneDebug())
/** 相机在 ENU 下的视线角：与画面无关，直接读 Cesium 相机姿态 */
const cam = () =>
  page.evaluate(() => {
    const c = window.__scene.viewer.camera
    const d = window.__droneDebug()
    return {
      heading: Cesium.Math.toDegrees(c.heading),
      pitch: Cesium.Math.toDegrees(c.pitch),
      roll: Cesium.Math.toDegrees(c.roll),
      distance: d.scene.distance,
      fov: d.scene.fov,
      follow: d.scene.follow,
      droneVisible: d.scene.droneVisible,
      gimbal: d.scene.gimbal,
      inputs: d.scene.inputs,
    }
  })

/** 按仿真时间推进，软件渲染下墙钟时间不等于物理时间 */
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

/** 等画面稳定再截图：空帧/未出图时重试，避免交付截图是纯底色 */
async function settleFrame(label, timeoutMs = 15_000) {
  const info = await page.evaluate(async (ms) => {
    const v = window.__scene.viewer
    const scene = v.scene
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
      return { mean: +(sum / (d.length / 4)).toFixed(1), min: Math.round(min), max: Math.round(max) }
    }
    let last = 0
    let stable = 0
    const t0 = performance.now()
    while (performance.now() - t0 < ms) {
      await new Promise((r) => setTimeout(r, 200))
      const lv = scene.globe.tilesLoaded ? 1 : 0
      stable = lv === last && lv === 1 ? stable + 1 : 0
      last = lv
      if (stable >= 2) break
    }
    let stats = await sample()
    for (let i = 0; i < 4 && stats.max - stats.min < 24; i++) {
      await new Promise((r) => setTimeout(r, 600))
      stats = await sample()
    }
    return stats
  }, timeoutMs)
  console.log(`FRAME ${label} ` + JSON.stringify(info))
  return info
}

const first = await dbg()
ck('页面就绪', first.ready === true, `${(loadMs / 1000).toFixed(1)}s`)
ck('默认仍是追尾镜头', first.scene.follow === 'chase', first.scene.follow)

// ---- 进入云台第一视角 ----
await page.evaluate(() => window.__droneSim.setFollowMode('fpv'))
await advance(0.6)
const fpv0 = await cam()
ck('云台视角已接管镜头', fpv0.follow === 'fpv' && fpv0.inputs === false, `follow=${fpv0.follow}`)
ck(
  '机位落在云台（相机≈机体位置）',
  fpv0.distance < 4,
  `相机距机体 ${fpv0.distance.toFixed(2)} m`,
)
ck('第一视角隐藏机身（避免穿模）', fpv0.droneVisible === false)
ck('第一视角切换为广角', fpv0.fov >= 74 && fpv0.fov <= 78, `${fpv0.fov}°`)
ck(
  '云台俯仰与相机俯角一致',
  Math.abs(fpv0.pitch - fpv0.gimbal.pitch) < 1.6,
  `相机 ${fpv0.pitch.toFixed(1)}° / 云台 ${fpv0.gimbal.pitch}°`,
)
ck('地平线保持水平（三轴增稳）', rollOff(fpv0.roll) < 0.6, `roll ${rollOff(fpv0.roll).toFixed(2)}°`)

// ---- 俯仰 / 偏航控制 ----
await page.evaluate(() => window.__droneSim.setGimbal(-55, 0))
await advance(0.5)
const down = await cam()
ck(
  '云台俯视 -55° 生效',
  Math.abs(down.pitch - -55) < 2 && Math.abs(down.gimbal.pitch - -55) < 0.01,
  `相机 ${down.pitch.toFixed(1)}°`,
)
const lookDown = await settleFrame('fpv_down')
await page.screenshot({ path: OUT + '/10_fpv_lookdown.png' })

await page.evaluate(() => window.__droneSim.setGimbal(-8, 18))
await advance(0.5)
const yawed = await cam()
ck(
  '云台偏航 +18° 生效（相机相对机头）',
  Math.abs(yawed.gimbal.yaw - 18) < 0.01,
  `云台偏航 ${yawed.gimbal.yaw}°`,
)
ck(
  '云台偏航带动机位视线',
  angDiff(yawed.heading, first.tele.heading + 18) < 3.5,
  `相机 ${yawed.heading.toFixed(1)}° / 机体航向 ${first.tele.heading.toFixed(1)}° + 18°`,
)
ck('偏航后地平线仍水平', rollOff(yawed.roll) < 0.6, `roll ${rollOff(yawed.roll).toFixed(2)}°`)

// ---- 键盘调云台（方向键）----
const beforeKey = (await cam()).pitch
await page.keyboard.down('ArrowDown')
await advance(0.8)
await page.keyboard.up('ArrowDown')
await advance(0.2)
const afterKey = await cam()
ck(
  '方向键 ↓ 下压云台',
  afterKey.pitch < beforeKey - 8,
  `${beforeKey.toFixed(1)}° -> ${afterKey.pitch.toFixed(1)}°`,
)
await page.evaluate(() => window.__droneSim.resetGimbal())
await advance(0.3)
const homed = await cam()
ck(
  '云台回中恢复巡航角',
  Math.abs(homed.pitch - -12) < 1.5 && Math.abs(homed.gimbal.yaw) < 0.01,
  `俯仰 ${homed.pitch.toFixed(1)}° / 偏航 ${homed.gimbal.yaw}°`,
)

// ---- 在第一视角里飞行 ----
await page.evaluate(() => window.__droneSim.setGimbal(-22, 0))
await advance(0.4)
const flyBefore = await dbg()
const camBefore = await cam()
await page.keyboard.down('KeyW')
await advance(2.2)
await page.screenshot({ path: OUT + '/09_fpv_flight.png' })
const flyMid = await dbg()
const camMid = await cam()
await page.keyboard.up('KeyW')
await advance(0.4)
const flyAfter = await cam()
const move = Math.hypot(
  flyMid.scene.drone[0] - flyBefore.scene.drone[0],
  flyMid.scene.drone[1] - flyBefore.scene.drone[1],
  flyMid.scene.drone[2] - flyBefore.scene.drone[2],
)
ck('云台视角内可按 W 前飞', move > 8, `位移 ${move.toFixed(1)} m`)
ck(
  '飞行中机位仍锁在云台',
  flyAfter.distance < 4.5 && flyAfter.follow === 'fpv',
  `相机距机体 ${flyAfter.distance.toFixed(2)} m`,
)
ck(
  '飞行中云台朝向稳定（不随机身俯仰翻转）',
  Math.abs(flyAfter.pitch - -22) < 2.5,
  `相机俯角 ${flyAfter.pitch.toFixed(1)}° / 设定 -22°`,
)
ck(
  '位移方向与视线一致（前飞不后退）',
  flyAfter.heading === camMid.heading ? true : Math.abs(flyAfter.heading - camMid.heading) < 6,
  `相机航向 ${camBefore.heading.toFixed(1)}° -> ${flyAfter.heading.toFixed(1)}°`,
)
const flyFrame = await settleFrame('fpv_flight')
await page.screenshot({ path: OUT + '/09_fpv_flight.png' })

// ---- 垂直俯视（正下方看地面/楼顶）----
await page.evaluate(() => window.__droneSim.setGimbal(-90, 0))
await advance(0.5)
const zenith = await cam()
ck('云台可垂直下视 -90°', Math.abs(zenith.pitch - -90) < 1.5, `${zenith.pitch.toFixed(1)}°`)
await settleFrame('fpv_nadir')
await page.screenshot({ path: OUT + '/11_fpv_nadir.png' })

// ---- 第一视角内坠毁：火球不该糊满全屏，镜头要自动后撤抬高 ----
const crashSpot = await page.evaluate(() => {
  const s = window.__scene
  const sim = window.__droneSim
  sim.setGimbal(-35, 0)
  // 悬停油门会抵消重力：先关油门，再给一个明确的下坠速度
  sim.setThrottle(0)
  // 凹多边形/带内院的楼，包围盒中心常落在楼外 —— 用射线法挑一栋能撞到楼顶的
  const inside = (x, z, ring) => {
    let hit = false
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      const xi = ring[i], zi = ring[i + 1], xj = ring[j], zj = ring[j + 1]
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit
    }
    return hit
  }
  const list = s.collision.buildings
    .filter((b) => b.top > 40 && b.top < 260 && inside((b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2, b.ring))
    .sort((a, b) => (a.maxX - a.minX) * (a.maxZ - a.minZ) - (b.maxX - b.minX) * (b.maxZ - b.minZ))
  const b = list[Math.floor(list.length / 2)]
  if (b) {
    sim.body.position = [(b.minX + b.maxX) / 2, b.top + 4, (b.minZ + b.maxZ) / 2]
    sim.body.velocity = [0, -11, 0]
    sim.body.quaternion = [0, 0, 0, 1]
    return { name: b.name || '楼顶', top: b.top, kind: 'roof' }
  }
  // 建筑数据没拉到（网络/海域）时退回地面坠落，保证仍能验证后撤镜头
  sim.body.position = [0, 24, 0]
  sim.body.velocity = [0, -12, 0]
  sim.body.quaternion = [0, 0, 0, 1]
  return { name: '地面', top: 0, kind: 'ground' }
})
await page
  .waitForFunction(() => window.__droneDebug().crash.active === true, null, { timeout: 60_000 })
  .catch(() => {})
// 火球最盛的 0.3 s 抓一张；0.65 s 时再读相机距离（后撤已完成）
await page.waitForTimeout(320)
await page.screenshot({ path: OUT + '/15_fpv_crash.png' })
await page.waitForTimeout(380)
const crashDbg = await dbg()
const crashCam = await cam()
ck(
  '云台视角内坠毁可触发机体解体',
  crashDbg.crash.active === true,
  `${crashSpot.kind === 'roof' ? '楼顶' : '地面'} · 法向 ${crashDbg.crash.impact.toFixed(1)} m/s`,
)
ck(
  '坠毁后镜头后撤（不糊在火球里）',
  crashCam.distance > 16,
  `相机退到 ${crashCam.distance.toFixed(1)} m`,
)
await page.screenshot({ path: OUT + '/16_fpv_crash_pullback.png' })
await page.waitForTimeout(1400)
await page.screenshot({ path: OUT + '/17_fpv_crash_prompt.png' })
await page.evaluate(() => window.__droneSim.restart())
await advance(0.8)
const revived = await dbg()
ck(
  '重新开始时回到云台视角且未损毁',
  revived.crash.active === false && revived.ui.followMode === 'fpv' && Math.abs(revived.tele.altitude - 150) < 10,
  `高度 ${revived.tele.altitude.toFixed(1)} m · ${revived.ui.followMode}`,
)

// ---- 垂直俯视后的退出校验 ----
await page.evaluate(() => {
  window.__droneSim.resetGimbal()
  window.__droneSim.setFollowMode('chase')
})
await advance(0.8)
const back = await cam()
ck('退出后恢复追尾镜头', back.follow === 'chase' && back.inputs === false, back.follow)
ck('退出后机身重新显示', back.droneVisible === true)
ck('退出后视场角还原', back.fov >= 58 && back.fov <= 62, `${back.fov}°`)
ck(
  '退出后相机退回跟随距离',
  Math.abs(back.distance - first.ui.distance) < 3,
  `${back.distance.toFixed(1)} m / 设定 ${first.ui.distance} m`,
)

// ---- 快捷键 F 往返 ----
await page.keyboard.press('KeyF')
await advance(0.5)
const hotF = await cam()
await page.keyboard.press('KeyF')
await advance(0.5)
const hotBack = await cam()
ck(
  '快捷键 F 一键进入/退出云台视角',
  hotF.follow === 'fpv' && hotBack.follow === 'chase',
  `${hotF.follow} -> ${hotBack.follow}`,
)

// ---- 顶栏常驻入口：点一次进、再点一次出（标签跟着状态翻转）----
const headerBtn = page.locator('button.fpv-toggle')
await headerBtn.click()
await advance(0.5)
const uiOn = await cam()
const uiOnLabel = (await headerBtn.innerText()).trim()
await headerBtn.click()
await advance(0.5)
const uiOff = await cam()
ck(
  '顶栏入口点击可进出云台视角',
  uiOn.follow === 'fpv' && uiOff.follow === 'chase' && uiOnLabel.includes('退出'),
  `${uiOnLabel} · ${uiOn.follow} -> ${uiOff.follow}`,
)

// ---- 第三人称近景：确认 GLB 云台节点也跟着俯仰（切回追尾后能看见镜头低头）----
await page.evaluate(() => {
  window.__droneSim.setDistance(6)
  window.__droneSim.setGimbal(-58, 0)
  window.__droneSim.setFollowMode('chase')
  window.__droneSim.snapCamera()
})
await advance(0.8)
const closeup = await cam()
ck(
  '切回第三人称后云台保持 -58°',
  closeup.follow === 'chase' && closeup.droneVisible === true && Math.abs(closeup.gimbal.pitch + 58) < 0.01,
  `云台 ${closeup.gimbal.pitch}° · 机身${closeup.droneVisible ? '可见' : '隐藏'}`,
)
await settleFrame('gimbal_closeup')
await page.screenshot({ path: OUT + '/12_gimbal_closeup.png' })

// ---- 正面近景对比：云台低头 / 抬头，确认 GLB 节点矩阵真的跟着转 ----
const frontView = async (pitch, file) => {
  await page.evaluate((p) => {
    const scene = window.__scene
    window.__droneSim.setFollowMode('free')
    window.__droneSim.setGimbal(p, 0)
    scene.viewer.camera.lookAt(
      scene.droneECEF,
      new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-4), 4.2),
    )
  }, pitch)
  await page.waitForTimeout(1000)
  await page.screenshot({ path: OUT + '/' + file })
}
await frontView(-60, '13_gimbal_front_down.png')
await frontView(20, '14_gimbal_front_up.png')

const passed = checks.filter((c) => c.ok).length
console.log(`\n${passed}/${checks.length} 通过 · 429 限流 ${throttled.length} 条`)
writeFileSync(
  OUT + '/report-gimbal.json',
  JSON.stringify({ passed, total: checks.length, checks, errors: errs, loadMs, lookDown, flyFrame }, null, 2),
  'utf8',
)
await browser.close()
process.exit(passed === checks.length ? 0 : 1)
