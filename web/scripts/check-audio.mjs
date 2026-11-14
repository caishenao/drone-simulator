// 声音自检：音效引擎的建图、随转速/空速连续变化、静音与分层开关、坠毁爆炸声。
//
// 浏览器有一条硬规则：AudioContext 必须由用户手势唤醒，否则永远停在 suspended。
// 所以这里第一件事就是验证「没交互时不建图、交互后立刻 running」——
// 演示时最常见的坑是：代码写了声音，但用户点了半天没声音，因为没做手势解锁。
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
  args: [
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    // 无头环境没有真实声卡，这两项让 AudioContext 照常推进时间轴
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
  ],
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
const audio = () => page.evaluate(() => window.__droneSim.audio.debug())

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90_000 })
await page.waitForFunction(() => window.__droneDebug && window.__droneDebug().ready, null, {
  timeout: 120_000,
})

// 启动定位（IP 属地）是异步的：它回来后会重置场景与油门。
// 在它落地之前做飞行类断言必然是假失败，必须先等它结束。
await page.waitForFunction(
  () => {
    const d = window.__droneDebug()
    return d.takeoff && d.takeoff.locating === false && d.takeoff.note.length > 0
  },
  null,
  { timeout: 60_000 },
)
await page.waitForTimeout(800)

// ---- 1. 面板：声音分区与控件齐全 ----
const labels = await page.$$eval('button', (els) => els.map((e) => (e.textContent || '').trim()))
ck('面板有「声音开」总开关', labels.includes('声音开'), labels.filter((l) => l.includes('声')).join('/'))
ck('面板有电机声开关', labels.includes('电机'))
ck('面板有风噪开关', labels.includes('风噪'))
ck('面板有撞击音开关', labels.includes('撞击'))
ck('顶栏有独立的声音开关', (await page.$$('button.sound-toggle')).length === 1)

// ---- 2. 没交互前不得建图（自动播放策略）----
let a = await audio()
let s = await dbg()
ck('未交互时不创建音频上下文', a.state === 'none' && a.built === false, `state=${a.state}`)

// ---- 3. 一次点击后必须立刻 running ----
await page.mouse.click(24, 30)
await page
  .waitForFunction(() => window.__droneSim.audio.debug().state === 'running', null, { timeout: 15_000 })
  .catch(() => {})
a = await audio()
ck('点击后音频上下文已启动', a.state === 'running', `state=${a.state}`)
ck('音频图已建立', a.built === true)
ck('四个电机声部就位（拍频来源）', a.voices === 4, `${a.voices} 路`)

// ---- 4. 电机声随转速连续变化：悬停 6000 rpm → 桨叶通过频率 200 Hz ----
await page.waitForTimeout(900)
a = await audio()
ck('悬停时电机有声', a.motor > 0.01, `motor=${a.motor}`)
ck('基频与转速对应（约 200 Hz @ 6000 rpm）', Math.abs(a.freq - 200) < 26, `${a.freq} Hz`)

// 加油门 → 电机实际转速上升（真实飞行里验证）
// 条件等待：电机有转速上升时间常数，而无头软件渲染的仿真时间远慢于墙钟，
// 固定 sleep 1100 ms 在低帧率下可能只推进了零点几秒仿真时间
const rpmBefore = (await dbg()).tele.rpm
await page.evaluate(() => window.__droneSim.setThrottle(0.62))
const rpmUp = await page
  .waitForFunction(
    (before) => window.__droneDebug().tele.rpm > before + 400,
    rpmBefore,
    { timeout: 20_000 },
  )
  .then(() => true)
  .catch(() => false)
s = await dbg()
ck(
  '加油门后电机转速上升',
  rpmUp && s.tele.rpm > rpmBefore + 400,
  `${rpmBefore.toFixed(0)} → ${s.tele.rpm.toFixed(0)} rpm`,
)
ck('油门过程中未解体', s.crash.active === false)
await page.evaluate(() => window.__droneSim.hoverTrim())
await page.waitForTimeout(600)

// 转速 → 音高换算：直接给引擎一个已知转速，断言映射关系（不受飞行姿态干扰）
const mapped = await page.evaluate(() => {
  const a = window.__droneSim.audio
  const frame = (rpm) => ({
    rpms: [rpm, rpm, rpm, rpm],
    speed: 0,
    vertical: 0,
    throttle: 0.5,
    contact: false,
    crashed: false,
    fpv: false,
  })
  a.update(frame(9200))
  const hi = a.debug()
  a.update(frame(6000))
  const mid = a.debug()
  a.update(frame(3000))
  const lo = a.debug()
  return { hi, mid, lo }
})
ck('3000 rpm → 100 Hz（两叶桨 200 转/秒）', Math.abs(mapped.lo.freq - 100) < 1, `${mapped.lo.freq} Hz`)
ck('6000 rpm → 200 Hz', Math.abs(mapped.mid.freq - 200) < 1, `${mapped.mid.freq} Hz`)
ck('9200 rpm → 约 307 Hz', Math.abs(mapped.hi.freq - 306.7) < 1.5, `${mapped.hi.freq} Hz`)
ck('转速越高电机声越响', mapped.hi.motor > mapped.mid.motor && mapped.mid.motor > mapped.lo.motor,
  `${mapped.lo.motor} → ${mapped.mid.motor} → ${mapped.hi.motor}`)

// ---- 5. 分层开关：关掉电机声，总线电平必须归零 ----
await page.evaluate(() => window.__droneSim.setMotorSound(false))
await page.waitForTimeout(500)
a = await audio()
ck('关掉电机声后电机电平为 0', a.motor === 0, `motor=${a.motor}`)
await page.evaluate(() => window.__droneSim.setMotorSound(true))

// ---- 6. 风噪随空速上升 ----
// 6a. 映射关系：直接给引擎已知空速，断言风噪随速度单调上升（不受飞行姿态干扰）
const windMap = await page.evaluate(() => {
  const a = window.__droneSim.audio
  const frame = (speed) => ({
    rpms: [6000, 6000, 6000, 6000],
    speed,
    vertical: 0,
    throttle: 0.5,
    contact: false,
    crashed: false,
    fpv: false,
  })
  a.update(frame(0))
  const calm = a.debug()
  a.update(frame(13))
  const mid = a.debug()
  a.update(frame(26))
  const fast = a.debug()
  return { calm, mid, fast }
})
ck('静止时无风噪', windMap.calm.wind === 0, `wind=${windMap.calm.wind}`)
ck(
  '风噪随空速单调上升',
  windMap.fast.wind > windMap.mid.wind && windMap.mid.wind > windMap.calm.wind,
  `${windMap.calm.wind} → ${windMap.mid.wind} → ${windMap.fast.wind}`,
)

// 6b. 端到端：给机体一个真实速度，风噪应当出现在主输出里。
// 条件等待而非固定 sleep：风噪靠 8 Hz 遥测节流下发（0.12 s 仿真时间），
// 无头软件渲染只有几 FPS，真实 420 ms 可能还凑不满一次遥测推送
// 先把引擎帧复位成静止，否则 6a 的映射测试会把基线留在 26 m/s 上
await page.evaluate(() => {
  window.__droneSim.audio.update({
    rpms: [6000, 6000, 6000, 6000],
    speed: 0,
    vertical: 0,
    throttle: 0.5,
    contact: false,
    crashed: false,
    fpv: false,
  })
})
const windBefore = (await audio()).wind
await page.evaluate(() => {
  window.__droneSim.body.velocity = [26, 0, 0]
})
const windUp = await page
  .waitForFunction(() => window.__droneSim.audio.debug().wind > 0.01, null, { timeout: 15_000 })
  .then(() => true)
  .catch(() => false)
a = await audio()
ck('高速时风噪出现', windUp && a.wind > windBefore + 0.01, `${windBefore} → ${a.wind}`)
await page.evaluate(() => {
  window.__droneSim.body.velocity = [0, 0, 0]
})

// ---- 7. 静音：M 键切换，prefs.muted 跟着走 ----
await page.keyboard.press('KeyM')
await page.waitForTimeout(350)
s = await dbg()
a = await audio()
ck('M 键可静音', s.ui.sound === false && a.prefs.muted === true)
ck('静音后主输出电平为 0', a.master === 0, `master=${a.master}`)
await page.keyboard.press('KeyM')
await page.waitForTimeout(500)
s = await dbg()
a = await audio()
ck('再按 M 恢复声音', s.ui.sound === true && a.prefs.muted === false)
ck('恢复后主输出电平回到音量值', a.master > 0.5, `master=${a.master}`)
ck('恢复后电机声回来', a.motor > 0.01, `motor=${a.motor}`)

// ---- 7b. 真实波形：输出不是静音，桨叶通过频率上有足够能量 ----
const spec = await page.evaluate(() => {
  const an = window.__droneSim.audio.analyser
  if (!an) return null
  const bins = new Float32Array(an.frequencyBinCount)
  an.getFloatFrequencyData(bins)
  const hzOf = (i) => (i * an.context.sampleRate) / an.fftSize
  let peak = -Infinity
  let peakHz = 0
  let band = -Infinity
  for (let i = 1; i < bins.length; i++) {
    if (bins[i] > peak) {
      peak = bins[i]
      peakHz = hzOf(i)
    }
    // 桨叶通过频率 200 Hz 附近 ±25 Hz 的能量
    const h = hzOf(i)
    if (h >= 175 && h <= 225 && bins[i] > band) band = bins[i]
  }
  const td = new Float32Array(an.fftSize)
  an.getFloatTimeDomainData(td)
  let sum = 0
  for (const v of td) sum += v * v
  return {
    peakHz,
    peak,
    band,
    drop: peak - band,
    rms: Math.sqrt(sum / td.length),
    sampleRate: an.context.sampleRate,
  }
})
ck('主输出有分析节点', !!spec)
ck('输出不是静音（时域 RMS > 0）', !!spec && spec.rms > 0.0005, `rms=${spec?.rms.toFixed(5)}`)
ck(
  '桨叶通过频率 200 Hz 上有足够能量（距主峰 < 10 dB）',
  !!spec && spec.drop < 10,
  `主峰 ${spec?.peakHz.toFixed(0)} Hz，200 Hz 处低 ${spec?.drop.toFixed(1)} dB`,
)

// ---- 8. 音量滑杆 ----
await page.evaluate(() => window.__droneSim.setVolume(0.25))
await page.waitForTimeout(200)
a = await audio()
ck('音量可调', Math.abs(a.prefs.volume - 0.25) < 0.01, `volume=${a.prefs.volume}`)
await page.evaluate(() => window.__droneSim.setVolume(0.7))

// ---- 9. 坠毁：爆炸声必须响，且电机要立刻掐断 ----
const fxBefore = (await audio()).fx
await page.evaluate(() => {
  const sim = window.__droneSim
  sim.body.position = [0, 3, 0]
  sim.body.velocity = [0, -24, 0]
})
await page
  .waitForFunction(() => window.__droneDebug().crash.active === true, null, { timeout: 30_000 })
  .catch(() => {})
s = await dbg()
ck('高速撞地判定解体', s.crash.active === true, `target=${s.crash.target} impact=${s.crash.impact.toFixed(1)}`)
// 条件等待爆炸声与电机静音落定：这两项都由 8 Hz 遥测节流下发
await page
  .waitForFunction(() => window.__droneSim.audio.debug().fx > 0, null, { timeout: 15_000 })
  .catch(() => {})
await page
  .waitForFunction(() => window.__droneSim.audio.debug().motor === 0, null, { timeout: 15_000 })
  .catch(() => {})
a = await audio()
ck('解体时播放爆炸声', a.fx > fxBefore, `fx ${fxBefore} → ${a.fx}`)
ck('解体后电机立即静音', a.motor === 0, `motor=${a.motor}`)
ck('解体后转速归零', a.spin === 0, `spin=${a.spin}`)

// ---- 10. 复位后电机重新转起来 ----
// 用条件等待而不是固定 sleep：音频参数靠 8 Hz 遥测节流下发（0.12 s 仿真时间），
// 无头软件渲染只有几 FPS，这个间隔在无头环境会被拉长到 600 ms 左右，固定等待会踩到边界
await page.evaluate(() => window.__droneSim.reset())
const motorBack = await page
  .waitForFunction(() => window.__droneSim.audio.debug().motor > 0.01, null, { timeout: 15_000 })
  .then(() => true)
  .catch(() => false)
a = await audio()
ck('复位后电机声恢复', motorBack && a.motor > 0.01, `motor=${a.motor}`)
s = await dbg()
ck('复位后不再是解体状态', s.crash.active === false)

ck('无页面脚本错误', errs.length === 0, errs.slice(0, 2).join(' | '))

await page.screenshot({ path: OUT + '/98_audio.png' })

const passed = checks.filter((c) => c.ok).length
console.log(`\n${passed}/${checks.length} 通过`)
writeFileSync(
  OUT + '/report-audio.json',
  JSON.stringify({ passed, total: checks.length, checks, errors: errs }, null, 2),
  'utf8',
)
await browser.close()
process.exit(passed === checks.length ? 0 : 1)
