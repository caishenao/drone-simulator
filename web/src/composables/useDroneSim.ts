// 飞行仿真 composable：把六自由度刚体、键盘输入、Cesium 场景和遥测串起来。
import { onBeforeUnmount, reactive, shallowRef } from 'vue'
import { DroneRigidBody, attitudeAngles } from '../drone/drone_physics.js'
import { resolveCollisions } from '../drone/collision'
import { DroneAudio } from '../audio/DroneAudio'
import type { CesiumScene, FollowMode, ImageryKind } from '../cesium/CesiumScene'
import { getDroneType, toPhysicsProfile } from '../config/droneTypes'
import {
  PRESET_CITIES,
  loadSavedTakeoff,
  locateByBrowser,
  locateByIp,
  reverseName,
  saveTakeoff,
  searchPlace,
  type Place,
} from '../geo/locate'
import {
  MultiplayerClient,
  DEFAULT_MP_URL,
  type MpOrigin,
  type MpStatus,
} from '../net/MultiplayerClient'
import { RemoteDrones } from '../net/RemoteDrones'
import { buildSnapshot, type MpChatMsg, type MpPlayer } from '../net/snapshot'

export interface TelemetryView {
  altitude: number
  /** 真实海拔（米）= 原点地形高程 + 相对高度 */
  elevation: number
  speed: number
  vertical: number
  pitch: number
  roll: number
  yaw: number
  heading: number
  rpm: number
  thrust: number
  contact: boolean
  clearance: number
  lon: number
  lat: number
  fps: number
  time: number
  /** 机身上方向与世界上方向点积：< 0 就是倒飞 */
  upDot: number
  inverted: boolean
  /** 当前油门（3D 模式下可为负） */
  throttle: number
}

export interface SimUi {
  throttle: number
  stabilize: boolean
  /** 3D 双向油门：负油门产生反向推力，倒飞靠它托住机身 */
  threeD: boolean
  /** 一键翻滚动作进行中 */
  flipping: boolean
  wind: boolean
  followMode: FollowMode
  distance: number
  /** 云台俯仰 / 偏航（度）；俯仰 -90..30，偏航 -90..90（相对机头） */
  gimbalPitch: number
  gimbalYaw: number
  imagery: ImageryKind
  /** 底图相关的一次性提示（如 Google 3D 不可用已回落），显示在底图按钮下方 */
  mapNote: string
  buildings: boolean
  droneScale: number
  /** 轨迹显示 / 记录开关与已记录点数 */
  trail: boolean
  trailRecording: boolean
  trailPoints: number
  /** 轨迹颜色（十六进制）与线宽（像素） */
  trailColor: string
  trailWidth: number
  /** 当前机型 id（见 config/droneTypes.ts） */
  droneTypeId: string
  /** 空气流场显隐 */
  airflow: boolean
  /** 屏幕内遥测 HUD 显隐 */
  hud: boolean
  /** 地图点选取点模式：点击地球任意位置设为起飞点 */
  picking: boolean
  /** 声音总开关（M）/ 音量 0..1 */
  sound: boolean
  volume: number
  /** 分层开关：电机、风噪、撞击与提示音 */
  motorSound: boolean
  windSound: boolean
  fxSound: boolean
  /** 地形碰撞：关掉后退回常数平面（老行为），机体可以飞进山体 */
  terrainCollision: boolean
  /** 虚拟摇杆显隐（触屏设备默认开，桌面端可手动开） */
  touchControls: boolean
  /** 侧栏面板显隐（手机端默认收起为抽屉） */
  panelOpen: boolean
}

export interface CrashState {
  active: boolean
  /** 爆炸播放约 1.1s 后再弹提示，避免遮挡火光 */
  prompt: boolean
  /** 撞击对象：「地面」或楼名 */
  target: string
  /** 法向撞击速度 m/s */
  impact: number
  /** 撞击时刻（仿真时间） */
  time: number
}

/** 起飞点状态 */
export interface TakeoffState {
  place: Place
  /** 建筑数据加载中 */
  loading: boolean
  /** 加载到的建筑栋数 */
  buildings: number
  /** 实际请求的瓦片数 */
  tiles: number
  /** 加载失败原因（非致命，仍可飞行） */
  error: string
  /** IP / 浏览器定位进行中 */
  locating: boolean
  /** 定位来源说明，展示在面板上 */
  note: string
}

/** 多人联机状态（MultiplayerPanel 直接渲染这份）。全球单一空域：无房间概念 */
export interface MpState {
  status: MpStatus
  /** 服务器地址（首次 join 后锁定） */
  url: string
  selfId: string
  /** 起飞前弹框输入的无人机 ID（服务器确认后回写） */
  selfName: string
  selfColor: string
  players: MpPlayer[]
  chat: MpChatMsg[]
  /** 服务器拒绝 / 超时等一次性错误，展示在面板上 */
  error: string
  /** 连接过程提示（连接中 / 已重连…） */
  note: string
  joining: boolean
  /** 空域起飞原点（进入时由服务器下发，全服统一） */
  worldOrigin: { lon: number; lat: number; placeName: string } | null
}

const START: [number, number, number] = [0, 150, 0]
/** 建筑加载半径：900 m 足够覆盖整段飞行，再大瓦片数和几何量都不划算 */
const BUILDING_RADIUS = 950
const DEFAULT_PLACE: Place = PRESET_CITIES[0]
const KEY_THROTTLE_RATE = 0.55
/** 云台角度调节速率（度/秒） */
const GIMBAL_RATE = 55
/** 云台归位俯仰：略微下压，前飞时能同时看到航向与地面 */
const GIMBAL_HOME_PITCH = -12
/** 超过该法向速度撞上建筑/地面即判定机体解体 */
const CRASH_SPEED = 5

export function useDroneSim() {
  const body = new DroneRigidBody()
  const audio = new DroneAudio()
  const scene = shallowRef<CesiumScene | null>(null)
  const tele = reactive<TelemetryView>({
    altitude: START[1],
    elevation: START[1],
    speed: 0,
    vertical: 0,
    pitch: 0,
    roll: 0,
    yaw: 0,
    heading: 0,
    rpm: 0,
    thrust: 0,
    contact: false,
    clearance: 0,
    lon: 0,
    lat: 0,
    fps: 60,
    time: 0,
    upDot: 1,
    inverted: false,
    throttle: body.hoverThrottle,
  })
  const ui = reactive<SimUi>({
    throttle: body.hoverThrottle,
    stabilize: true,
    threeD: false,
    flipping: false,
    wind: false,
    followMode: 'chase',
    distance: 22,
    gimbalPitch: GIMBAL_HOME_PITCH,
    gimbalYaw: 0,
    imagery: 'esri',
    mapNote: '',
    buildings: true,
    droneScale: 8,
    trail: true,
    trailRecording: true,
    trailPoints: 0,
    trailColor: '#5ad1ff',
    trailWidth: 2.4,
    droneTypeId: 'mini3pro',
    airflow: true,
    hud: true,
    picking: false,
    sound: true,
    volume: 0.7,
    motorSound: true,
    windSound: true,
    fxSound: true,
    terrainCollision: true,
    touchControls: false,
    panelOpen: true,
  })
  // 触屏设备：摇杆默认显示、面板默认收起（摇杆是主操控，面板按需展开）
  const coarsePointer =
    typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches
  if (coarsePointer) {
    ui.touchControls = true
    ui.panelOpen = false
  }
  /**
   * 虚拟摇杆写入的触控输入（TouchControls 组件绑定这份）：各分量 -1..1。
   * pitch/roll/yaw 是姿态杆量（松手回中）；throttle 是油门变化率（按住持续加减速）。
   */
  const touchInput = reactive({ pitch: 0, roll: 0, yaw: 0, throttle: 0 })
  const crash = reactive<CrashState>({ active: false, prompt: false, target: '', impact: 0, time: 0 })
  const takeoff = reactive<TakeoffState>({
    place: { ...DEFAULT_PLACE },
    loading: false,
    buildings: 0,
    tiles: 0,
    error: '',
    locating: false,
    note: '',
  })
  // ————————————————————————————————————————————
  // 多人联机：客户端封装 + 远端机体管理器 + 面板状态
  // 协议与架构见 docs/multiplayer-plan.md。
  // ————————————————————————————————————————————
  const mp = reactive<MpState>({
    status: 'idle',
    url: DEFAULT_MP_URL,
    selfId: '',
    selfName: '',
    selfColor: '#5ad1ff',
    players: [],
    chat: [],
    error: '',
    note: '',
    joining: false,
    worldOrigin: null,
  })
  /**
   * 联机会话完全就绪（搬完场景原点、远端机体建好）才为 true。
   * 起飞点切换的锁定与快照发布都以它为准 —— join 应答先行返回时
   * status 已是 joined，但场景还没搬完，此时不能锁也不能发。
   */
  let mpReady = false
  /** 撞毁快照已发：撞毁后位置不再上报，只补发一次 c:1（重飞时复位） */
  let mpCrashSent = false
  /**
   * 快照发布定时器（20Hz，独立于 rAF）。
   * 物理环跑在 rAF 上，标签页后台化时 rAF 停摆 → 若发布挂靠它，服务器 15s 收不到
   * mp:state 就会把人踢出空域。独立定时器保证「切走标签页 ≠ 掉线」，
   * 代价是后台期间快照内容冻结在最后物理状态（回来时 rAF 恢复，内容立刻跟上）。
   */
  let mpPublishTimer = 0
  /** 空域内其他玩家 id → 名称（离开提示用） */
  const mpNames = new Map<string, string>()
  const client = new MultiplayerClient({
    onJoined: (self, origin, roster) => {
      mp.status = 'joined'
      mp.selfId = self.id
      mp.selfName = self.name
      mp.selfColor = self.color
      mp.worldOrigin = origin
      mp.players = [...roster]
      mp.note = ''
      // 断线重连也走这里：名单整表对齐（新增建、离开删）。剔除自己由 RemoteDrones 负责
      remote?.syncRoster(mp.players)
      for (const p of mp.players) mpNames.set(p.id, p.name)
      mpChatSystem(`${self.name} 已进入全球空域（${roster.length} 人在线）`)
    },
    onPlayerJoined: (player) => {
      mpNames.set(player.id, player.name)
      const i = mp.players.findIndex((p) => p.id === player.id)
      if (i >= 0) mp.players.splice(i, 1, player)
      else mp.players.push(player)
      remote?.playerJoined(player)
      mpChatSystem(`${player.name} 进入空域`)
    },
    onPlayerLeft: (id, reason) => {
      const name = mpNames.get(id) ?? '一名玩家'
      mpNames.delete(id)
      mp.players = mp.players.filter((p) => p.id !== id)
      remote?.playerLeft(id)
      mpChatSystem(`${name} 退出了空域${reason === 'timeout' ? '（超时）' : ''}`)
    },
    onSnap: (id, snap) => {
      remote?.applySnapshot(id, snap)
      // 撞毁状态随快照直达：同步进名单（服务器不单独广播名单变更，重飞时 c:0 自动翻回）
      const p = mp.players.find((x) => x.id === id)
      if (p) p.crashed = snap.c === 1
    },    onChat: (msg) => {
      mp.chat.push(msg)
      if (mp.chat.length > 100) mp.chat.splice(0, mp.chat.length - 100)
    },
    onError: (code, message) => {
      mp.error = message
      // 服务器判定本机超时：会话已作废，清干净面板与远端机体
      if (code === 'timeout') void mpLeave(true)
    },
    onTransport: (state) => {
      if (state === 'disconnected' && mpReady) {
        mp.status = 'reconnecting'
        mp.note = '连接中断，正在重连…'
        // socket.io 自动重连成功后 server 会重发 mp:joined，onJoined 里清掉这句提示
      }
    },
  })
  let remote: RemoteDrones | null = null

  /** 系统提示走聊天流（进出空域等），颜色留空表示非玩家发言 */
  function mpChatSystem(text: string): void {
    mp.chat.push({ id: 'sys', name: '', color: '', text, ts: Date.now() })
    if (mp.chat.length > 100) mp.chat.splice(0, mp.chat.length - 100)
  }
  let crashed = false
  /** 擦碰碎屑的节流：贴墙滑行时不要每帧都迸火星 */
  let impactClock = 0
  /**
   * 一键翻滚：按滚转角速率积分到目标角度。
   * 用「实际角速度积分」而不是「按时间开环」，否则速率环爬升/饱和会让机身停在半圈上。
   */
  let flip: { target: number; swept: number; elapsed: number; invertThrottle: boolean } | null = null
  /**
   * 倒飞「接住」窗口：翻完 180° 时机身还在下坠，用垂速 P 控制把反向油门收到悬停值。
   * 只在一键倒飞后短暂生效（约 2s），随后油门就停在反向悬停点，用户可继续手调。
   */
  let catchClock = 0

  const keys = new Set<string>()
  let raf = 0
  let last = 0
  let fpsAcc = 0
  let fpsFrames = 0
  let teleClock = 0
  let windTimer = 0
  let attached = false

  body.reset({ position: START })

  function onKeyDown(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement | null)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    // 用户已经开始操作 → 启动时的自动定位不该再把场景换走
    userActed = true
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault()
    // 点选模式是「一击即走」的临时状态：Esc 取消，避免用户不知道自己在选点
    if (e.code === 'Escape' && ui.picking) {
      cancelPick()
      return
    }
    if (!keys.has(e.code)) {
      if (e.code === 'KeyC') cycleCamera()
      if (e.code === 'KeyF') toggleFpv()
      if (e.code === 'KeyX') resetGimbal()
      if (e.code === 'KeyV') snapCamera()
      if (e.code === 'KeyR') reset()
      if (e.code === 'KeyG') gust()
      if (e.code === 'KeyI') impulse()
      if (e.code === 'KeyT') setTrailVisible(!ui.trail)
      if (e.code === 'KeyZ') setThreeD(!ui.threeD)
      if (e.code === 'KeyK') roll360()
      if (e.code === 'KeyL') invertFlight()
      if (e.code === 'KeyH') setHud(!ui.hud)
      if (e.code === 'KeyM') toggleSound()
    }
    keys.add(e.code)
  }

  function onKeyUp(e: KeyboardEvent) {
    keys.delete(e.code)
  }

  function onBlur() {
    keys.clear()
  }

  function feedControls(dt: number) {
    let pitch = 0
    let roll = 0
    let yaw = 0
    if (keys.has('KeyW')) pitch -= 1
    if (keys.has('KeyS')) pitch += 1
    if (keys.has('KeyA')) roll -= 1
    if (keys.has('KeyD')) roll += 1
    if (keys.has('KeyQ')) yaw -= 1
    if (keys.has('KeyE')) yaw += 1

    // 虚拟摇杆与键盘叠加合成：同一时刻只用一套输入时互不干扰
    pitch += touchInput.pitch
    roll += touchInput.roll
    yaw += touchInput.yaw
    pitch = Math.min(1, Math.max(-1, pitch))
    roll = Math.min(1, Math.max(-1, roll))
    yaw = Math.min(1, Math.max(-1, yaw))
    if (touchInput.throttle !== 0) {
      setThrottle(ui.throttle + KEY_THROTTLE_RATE * touchInput.throttle * dt)
    }

    if (keys.has('Space')) setThrottle(ui.throttle + KEY_THROTTLE_RATE * dt)
    if (keys.has('ShiftLeft') || keys.has('ShiftRight')) {
      setThrottle(ui.throttle - KEY_THROTTLE_RATE * dt)
    }

    // 一键翻滚期间接管滚转：按实际角速度积分，接近目标角时按剩余角度收杆，
    // 否则满杆滚到 180° 再松手，机身会多滚 15° 左右（速率环刹车需要距离）
    let flipRoll = 0
    if (flip) {
      // 正滚杆产生负向机体 Z 角速度，所以扫过角度取 -ωz 的积分（可正可负，超了能倒回来）
      flip.swept += -body.omega[2] * dt
      flip.elapsed += dt
      const remain = flip.target - flip.swept
      const settled = remain < 0.05 && Math.abs(body.omega[2]) < 0.45
      if (settled || flip.elapsed > 8) finishFlip()
      else flipRoll = Math.max(-1, Math.min(1, remain / 0.55))
    }

    // 倒飞接住：垂速 P 控制 → 反向油门。倒置时负油门产生向上推力，
    // 目标油门 = -[mg - k·vy] / Tmax，vy 收敛到 0 时正好落在反向悬停点。
    if (catchClock > 0) {
      catchClock -= dt
      // 用当前机型的质量与推力上限：写死默认机型的话，换成重载机接不住下坠
      const needUp =
        body.p.body.mass_kg * (body.p.environment.gravity_mps2 - 2.4 * body.velocity[1])
      setThrottle(-needUp / body.p.rotor.max_thrust_total_n)
      if (catchClock <= 0) setThrottle(-body.hoverThrottle)
    }

    body.setControls({ throttle: ui.throttle, pitch, roll: flipRoll || roll, yaw })
  }

  /** 起飞翻滚：先松开增稳（自稳会把滚转顶回来），手动模式才有全滚转权限 */
  function startFlip(targetRad: number, invertThrottle = false): boolean {
    if (crashed || flip) return false
    flip = { target: targetRad, swept: 0, elapsed: 0, invertThrottle }
    ui.flipping = true
    body.setStabilize(false)
    audio.blip(invertThrottle ? 1180 : 1240, 0.09, 0.05)
    return true
  }

  function finishFlip() {
    if (!flip) return
    const f = flip
    flip = null
    ui.flipping = false
    if (f.invertThrottle) {
      // 停在倒飞姿态：必须留在手动模式，否则增稳立刻把机身翻回来
      ui.stabilize = false
      body.setStabilize(false)
      setThreeD(true)
      // 翻完先给满反向油门把下坠接住，再交给垂速控制收敛到反向悬停
      ui.throttle = -1
      catchClock = 2.2
    } else {
      body.setStabilize(ui.stabilize)
    }
  }

  /** K：360° 横滚（一键翻滚），结束后回到原飞行模式 */
  function roll360(): boolean {
    return startFlip(Math.PI * 2)
  }

  /** L：滚转 180° 进入倒飞，并把油门配到反向悬停值 */
  function invertFlight(): boolean {
    return startFlip(Math.PI, true)
  }

  /** 悬停配平：按当前正飞/倒飞把油门放到对应悬停值（倒飞会自动打开 3D 油门） */
  function hoverTrim() {
    const inv = body.telemetry.inverted
    if (inv && !ui.threeD) setThreeD(true)
    setThrottle((inv ? -1 : 1) * body.hoverThrottle)
  }

  /** 方向键调云台：↑↓ 俯仰、←→ 环视（相对机头），与机体姿态解耦，任何镜头下都生效 */
  function feedGimbal(dt: number) {
    let dp = 0
    let dy = 0
    if (keys.has('ArrowUp')) dp += 1
    if (keys.has('ArrowDown')) dp -= 1
    if (keys.has('ArrowLeft')) dy -= 1
    if (keys.has('ArrowRight')) dy += 1
    if (dp === 0 && dy === 0) return
    setGimbal(ui.gimbalPitch + dp * GIMBAL_RATE * dt, ui.gimbalYaw + dy * GIMBAL_RATE * dt)
  }

  function pushTelemetry() {
    const t = body.telemetry
    const angle = attitudeAngles(t.quaternion)
    const origin = scene.value?.originCartographic
    const lon = origin
      ? (origin.longitude * 180) / Math.PI + body.position[0] / (111320 * Math.cos(origin.latitude))
      : 0
    const lat = origin ? (origin.latitude * 180) / Math.PI - body.position[2] / 110540 : 0

    const fps = fpsFrames / Math.max(fpsAcc, 1e-6)
    tele.altitude = t.position[1]
    // 真实海拔 = 场景原点的高程 + 机体相对高度。接上全球高程后这个值才有意义：
    // 同一个 150 m，在拉萨是 3800 m，在玉龙雪山是 5400 m
    tele.elevation = (scene.value?.groundElevation ?? 0) + t.position[1]
    tele.speed = t.speed_mps
    tele.vertical = t.velocity[1]
    tele.pitch = t.pitch_deg
    tele.roll = t.roll_deg
    tele.yaw = (angle.yaw * 180) / Math.PI
    tele.heading = ((-angle.yaw * 180) / Math.PI + 360) % 360
    tele.rpm = t.rpms.reduce((s, x) => s + x, 0) / 4
    tele.thrust = t.thrust_total_n
    tele.contact = t.contact
    tele.clearance = body.groundClearance()
    tele.lon = lon
    tele.lat = lat
    tele.time = t.time
    tele.fps = fps
    tele.upDot = t.up_y
    tele.inverted = t.inverted
    tele.throttle = ui.throttle
    ui.trailPoints = scene.value?.trailStats.points ?? 0

    // 声音：8 Hz 的遥测节流正好是音频参数更新的合适频率。
    // 传四个电机的原始转速而不是平均值，失谐带来的拍频才是四旋翼的听感来源。
    audio.update({
      rpms: crashed ? [0, 0, 0, 0] : body.rpms,
      speed: t.speed_mps,
      vertical: t.velocity[1],
      throttle: ui.throttle,
      contact: t.contact,
      crashed,
      fpv: ui.followMode === 'fpv',
    })

    fpsAcc = 0
    fpsFrames = 0
    teleClock = 0
  }

  /** 组当前机体状态快照（20Hz 上报 / 撞毁补发共用）。带符号 rpm 与 pushTelemetry 同款算法 */
  function mpSnapshot(crashed: boolean) {
    const s = scene.value
    const thrustAvg = body.thrusts.reduce((sum, x) => sum + x, 0)
    const rpmSigned = (body.rpms.reduce((sum, x) => sum + x, 0) / 4) * (thrustAvg < 0 ? -1 : 1)
    return buildSnapshot({
      position: body.position,
      quaternion: body.quaternion,
      velocity: body.velocity,
      originLon: s?.config.lon ?? 0,
      originLat: s?.config.lat ?? 0,
      originElevation: s?.groundElevation ?? 0,
      gimbalPitch: ui.gimbalPitch,
      gimbalYaw: ui.gimbalYaw,
      rpmSigned,
      crashed,
      time: body.time,
      droneTypeId: ui.droneTypeId,
      throttle: ui.throttle,
    })
  }

  function tick(now: number) {
    raf = requestAnimationFrame(tick)
    const dt = Math.min(0.05, Math.max(0.0005, (now - last) / 1000))
    last = now

    if (!crashed) {
      // 风场：阵风优先，其次持续侧风开关
      if (windTimer > 0) {
        windTimer -= dt
        if (windTimer <= 0) body.setWind(ui.wind ? [0.35, 0, -0.2] : [0, 0, 0])
      } else if (ui.wind) {
        body.setWind([0.35, 0, -0.2])
      }
      if (impactClock > 0) impactClock -= dt

      feedControls(dt)
      feedGimbal(dt)
      const prev: [number, number, number] = [body.position[0], body.position[1], body.position[2]]
      body.step(dt)

      // 建筑刚体碰撞：低速弹开、高速解体
      if (ui.buildings && scene.value) {
        const hit = resolveCollisions(body, scene.value.collision, {
          radius: Math.max(0.5, 0.14 * ui.droneScale),
          roofRest: 0.05 + 0.035 * ui.droneScale,
          crashSpeed: CRASH_SPEED,
          restitution: 0.42,
          friction: 0.74,
        }, prev)
        if (hit.kind === 'crash') triggerCrash(hit.target, hit.impact)
        else if (hit.kind === 'bounce' && hit.impact > 1.2 && impactClock <= 0) {
          impactClock = 0.28
          audio.bump(Math.min(1, hit.impact / CRASH_SPEED))
          scene.value.impact(body.position, Math.min(1, hit.impact / CRASH_SPEED))
        }
      }
      // 地面刚体：触地瞬间的下坠速度由物理层锁存（反弹会把 contact 清掉）
      // 开着真实高程时这多半是「撞山」，提示词要区分开；没有地形时地面就是平面，说「地面」
      if (!crashed && body.groundImpact > CRASH_SPEED) {
        triggerCrash(scene.value?.hasTerrain ? '山体' : '地面', body.groundImpact)
      } else if (!crashed && body.groundImpact > 0.6 && impactClock <= 0) {
        // 正常落地也要有「咚」的一声，否则轻着陆是完全静音的，反而不真实
        impactClock = 0.28
        audio.bump(Math.min(0.7, body.groundImpact / CRASH_SPEED))
      }

      if (!crashed) {
        const angle = attitudeAngles(body.quaternion)
        const thrustAvg = body.thrusts.reduce((s, x) => s + x, 0)
        // 负推力 = 电机反转：把符号带进场景，桨叶跟着反向转
        const rpmSigned =
          (body.rpms.reduce((s, x) => s + x, 0) / 4) * (thrustAvg < 0 ? -1 : 1)
        scene.value?.updateDrone(
          body.position,
          body.quaternion,
          angle.yaw,
          dt,
          rpmSigned,
          body.velocity,
          body.wind,
        )
      }
    }
    // 坠毁后物理停止，但爆炸/抖动继续推进
    scene.value?.updateEffects(dt)

    // 多人：远端机体每帧插值推进。本地快照发布不在这里——
    // rAF 在标签页后台化时会停摆，挂靠它会被服务器的 15s 静默判定踢出（mpPublishTimer 负责）
    remote?.render(dt)

    fpsAcc += dt
    fpsFrames++
    teleClock += dt
    if (teleClock >= 0.12) pushTelemetry()
  }

  /** 机体解体：冻结物理、隐藏机身、原地引爆 */
  function triggerCrash(target: string, impact: number) {
    if (crashed) return
    crashed = true
    crash.active = true
    crash.prompt = false
    crash.target = target
    crash.impact = impact
    crash.time = body.time
    // 停止飞行：速度和角速度全部归零，后续 tick 不再推进物理
    body.velocity = [0, 0, 0]
    body.omega = [0, 0, 0]
    body.contact = false
    flip = null
    catchClock = 0
    ui.flipping = false
    scene.value?.detonate(body.position, Math.min(2.2, 0.9 + impact / 12))
    // 爆炸声按撞击速度加权：轻撞是「砰」，满速俯冲是「轰」
    audio.explode(0.7 + impact / 9)
    scene.value?.setDroneVisible(false)
    // 机体已解体，空气流线随即消失（否则会留在半空中飘）
    scene.value?.setAirflowVisible(false)
    scene.value?.setTrailRecording(false)
    ui.trailRecording = false
    keys.clear()
    ui.throttle = 0
    tele.speed = 0
    tele.vertical = 0
    tele.rpm = 0
    tele.contact = false
    // 先让爆炸演完，再弹重飞提示
    window.setTimeout(() => {
      if (crashed) crash.prompt = true
    }, 1100)
  }

  /**
   * 把地形碰撞接到物理层。
   *
   * 地面高度与地表法向都由场景层提供（Cesium 真实高程）。
   * 关掉开关就退回常数平面 —— 那是改造前的行为：机体可以飞进山体。
   */
  function applyTerrainBinding(): void {
    const s = scene.value
    body.setCollisionRadius(Math.max(0.5, 0.14 * ui.droneScale))
    if (!s || !ui.terrainCollision) {
      body.groundProvider = null
      body.groundNormalProvider = null
      return
    }
    body.groundProvider = (x, z) => s.groundHeightAt(x, z)
    body.groundNormalProvider = (x, z) => s.groundNormalAt(x, z)
  }

  /** 地形碰撞开关 */
  function setTerrainCollision(on: boolean): void {
    ui.terrainCollision = on
    scene.value?.setTerrainCollision(on)
    applyTerrainBinding()
  }

  function attach(next: CesiumScene) {
    attachScene(next)
    startFlight({ bootstrap: true })
  }

  /**
   * 只把场景接进来，不启动物理循环。
   *
   * 配置页需要场景（地球、底图、高程）但不要物理：此时还没有确定起飞点，
   * 自动定位会直接把场景搬到用户没选的地方。
   */
  function attachScene(next: CesiumScene) {
    scene.value = next
    // 底图不可用（天地图限流 / Google 3D 无 key、无网络）时自动回退，
    // 按钮状态跟着切过去 —— 底图不能「静默失败」，否则用户会以为是自己点错了
    next.onImageryFallback = (kind, reason) => {
      ui.imagery = kind
      ui.mapNote = reason ? `Google 3D 实景不可用（${reason}），已回落 Esri 卫星` : ''
    }
    // 切到 Google 实景时场景会自动收起本地 OSM 体块（否则素色方块从实景楼里穿出来），
    // 退出时再还原，面板上的「OSM 建筑」按钮要跟着走
    next.onBuildingsSync = (show) => {
      ui.buildings = show
    }
    next.setFollowMode(ui.followMode)
    next.setFollowDistance(ui.distance)
    next.setGimbal(ui.gimbalPitch, ui.gimbalYaw)
    next.setDroneScale(ui.droneScale)
    next.setTrailVisible(ui.trail)
    next.setTrailRecording(ui.trailRecording)
    next.setTrailColor(ui.trailColor)
    next.setTrailWidth(ui.trailWidth)
    next.setAirflowVisible(ui.airflow)
    // 地形碰撞：把场景层的真实高程接进物理层
    next.setTerrainCollision(ui.terrainCollision)
    applyTerrainBinding()
    // 浏览器要求 AudioContext 由用户手势唤醒：这里只挂一次性监听，
    // 真正的建图发生在第一次点击画布或按任意键时
    audio.arm()
    syncAudio()
  }

  /**
   * 启动飞行物理循环。
   * bootstrap=true 时按「上次起飞点 → IP 属地 → 默认点」自动落位（直接进入飞行页时用）；
   * 配置页 → 飞行的路径不传 bootstrap —— 起飞点是用户自己选的。
   */
  function startFlight(opts: { bootstrap?: boolean } = {}) {
    if (attached) return
    attached = true
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    last = performance.now()
    if (!raf) raf = requestAnimationFrame(tick)
    if (opts.bootstrap) void bootstrapTakeoff()
  }

  /** 停掉物理循环（回到配置页时用）：键盘监听与动画帧都要收干净 */
  function stopFlight() {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    attached = false
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
    window.removeEventListener('blur', onBlur)
    keys.clear()
    // 回配置页 / 首页就是要换起飞点：自动退出空域（空域统一了起飞点，方案第 5 节）
    if (mpReady || client.status !== 'idle') void mpLeave(true)
  }

  function detach() {
    stopFlight()
    client.dispose()
    remote?.disposeAll()
    remote = null
    audio.dispose()
    scene.value = null
  }

  /** 面板上的声音开关 → 音频引擎。总开关只压 master，不销毁上下文，切回来是瞬时的 */
  function syncAudio() {
    audio.configure({
      muted: !ui.sound,
      volume: ui.volume,
      motors: ui.motorSound,
      wind: ui.windSound,
      fx: ui.fxSound,
    })
  }

  function setSound(on: boolean) {
    ui.sound = on
    syncAudio()
    if (on) {
      // 用户可能是在静音状态下的第一次交互，这里补一次解锁
      void audio.unlock()
      audio.blip(760, 0.07, 0.045)
    }
  }

  function toggleSound() {
    setSound(!ui.sound)
  }

  function setVolume(v: number) {
    ui.volume = Math.min(1, Math.max(0, v))
    syncAudio()
  }

  function setMotorSound(on: boolean) {
    ui.motorSound = on
    syncAudio()
  }

  function setWindSound(on: boolean) {
    ui.windSound = on
    syncAudio()
  }

  function setFxSound(on: boolean) {
    ui.fxSound = on
    syncAudio()
  }

  /** 切换请求序号：连点不同城市时只认最后一次，避免旧结果覆盖新场景 */
  let takeoffSeq = 0
  /** 用户是否已主动选过起飞点：启动时的 IP 定位慢一步回来时，别再顶掉用户的选择 */
  let userChoseTakeoff = false
  /** 用户是否已经实际操作过（动了油门 / 按过键）：启动时的自动定位不该打断飞行 */
  let userActed = false

  /**
   * 切换起飞点：搬场景原点 → 重新拉周边建筑 → 复位刚体与相机。
   * 建筑加载失败不影响飞行（地面仍是刚体），只把原因显示在面板上。
   */
  async function setTakeoff(
    place: Place,
    opts: { remember?: boolean; auto?: boolean; keepCamera?: boolean } = {},
  ): Promise<boolean> {
    // 联机中锁定起飞点：空域统一了原点，换点会破坏全服坐标系
    // （mpJoin 自己的搬点发生在 mpReady 置位之前，不受此锁影响）
    if (mpLocked()) {
      takeoff.note = '联机中已锁定起飞点，退出空域后才能更换'
      audio.blip(420, 0.09, 0.05)
      return false
    }
    // 非自动（用户搜索 / 点地图 / 点 GPS）的切点要把启动时的 IP 定位结果作废：
    // locateByIp 要几秒，这期间用户自己选了地点，不能让迟到的 IP 结果把它顶掉
    if (!opts.auto) userChoseTakeoff = true
    const s = scene.value
    takeoff.place = { ...place }
    takeoff.error = ''
    // IP / 浏览器定位的说明由调用方写入；搜索与预设在这里补一句，避免残留上一个地点的提示
    if (place.source === 'search') takeoff.note = `已定位到「${place.name}」`
    else if (place.source === 'preset') takeoff.note = `已切换到预设城市「${place.name}」`
    if (!s) return false
    const seq = ++takeoffSeq
    takeoff.loading = true
    // 配置页已经预览过同一点时不必重搬原点：
    // setOrigin 会重采高程、灌高度场、清建筑与轨迹，几秒起步，而画面本来就在那儿。
    const sameSpot =
      Math.abs(place.lon - s.config.lon) < 1e-7 && Math.abs(place.lat - s.config.lat) < 1e-7
    if (!sameSpot) {
      // 先采样该点的真实高程再搬原点：山区起飞要落在地表，不能停在椭球面
      // seq 一起传下去：并发切场景时，采样慢的旧请求不能覆盖新场景
      const applied = await s.setOrigin(place.lon, place.lat, undefined, seq, {
        keepCamera: opts.keepCamera,
      })
      // 有更新的请求在跑：它负责 loading 状态，这里直接放弃
      if (seq !== takeoffSeq) return false
      if (!applied) {
        takeoff.loading = false
        return false
      }
    }
    // 天地图只覆盖中国境内：换个境外起飞点后要重新判断底图，否则地面是白底占位图
    s.recheckImagery()
    // 先让上一帧的渲染命令提交：同一帧里 remove 旧 Primitive 又 add 新的，
    // Cesium 的批处理表会残留已销毁的几何，随后在可见性剔除里崩掉
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const r = await s.loadBuildingsAt(place.lon, place.lat, BUILDING_RADIUS)
    if (seq !== takeoffSeq) return false
    takeoff.loading = false
    takeoff.loading = false
    takeoff.buildings = r.count
    takeoff.tiles = r.tiles
    if (r.error) takeoff.error = r.error
    if (opts.remember !== false) saveTakeoff(place)

    // 刚体回新原点上方；先写一次位姿再对相机，否则相机会先跳到旧坐标再被拉回
    reset({ keepThrottle: true, keepCamera: opts.keepCamera })
    s.updateDrone(body.position, body.quaternion, 0)
    if (!opts.keepCamera) s.snapCamera(0)
    return !r.error
  }

  // ————————————————————————————————————————————
  // 配置页：起飞点预览（只搬场景，不起飞、不加载建筑）
  // ————————————————————————————————————————————

  /**
   * 预览一个起飞点：场景原点搬过去、给出俯视全景、标出落点。
   * 配置页只负责「选点」，真正的起飞准备（加载建筑、复位刚体、接管镜头）
   * 放在点「开始飞行」时由 setTakeoff + flyIntoFlight 完成。
   */
  async function previewPlace(place: Place): Promise<boolean> {
    const s = scene.value
    if (!s) return false
    // 联机中配置页也不许换点（换点即重新预览，退出空域才有效）
    if (mpLocked()) return false
    const seq = ++takeoffSeq
    // 与 setTakeoff 同样的短路：已经在这一点上，就不用重采样地形
    const sameSpot =
      Math.abs(place.lon - s.config.lon) < 1e-7 && Math.abs(place.lat - s.config.lat) < 1e-7
    if (!sameSpot) {
      const applied = await s.setOrigin(place.lon, place.lat, undefined, seq, { keepCamera: true })
      if (!applied || seq !== takeoffSeq) return false
    }
    takeoff.place = { ...place }
    takeoff.error = ''
    // 机体摆到地表做占位预览（不启动物理，位置由场景层直接写）
    s.placeDroneAtGround()
    s.setPreviewMarker(place.lon, place.lat, place.name)
    s.previewCamera(place.lon, place.lat)
    return true
  }

  /** 配置页地图点选：逆地理编码取名后预览该点 */
  async function pickPreview(lon: number, lat: number): Promise<boolean> {
    takeoff.locating = true
    takeoff.note = '正在解析所选地点…'
    const name = await reverseName(lon, lat)
    takeoff.locating = false
    const place: Place = {
      lon,
      lat,
      name: name || `${lat.toFixed(3)}°, ${lon.toFixed(3)}°`,
      detail: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
      source: 'manual',
    }
    takeoff.note = `已选点：${place.name}`
    return previewPlace(place)
  }

  /** 配置页：按 IP 属地预览（不加载建筑） */
  async function previewByIp(): Promise<boolean> {
    takeoff.locating = true
    takeoff.note = '正在按 IP 属地定位…'
    const ip = await locateByIp()
    takeoff.locating = false
    if (!ip) {
      takeoff.note = 'IP 定位失败（网络或接口不可用）'
      return false
    }
    takeoff.note = `已按 IP 属地定位${ip.detail ? '：' + ip.detail : ''}`
    return previewPlace(ip)
  }

  /** 配置页：浏览器精确定位 */
  async function previewByGps(): Promise<boolean> {
    takeoff.locating = true
    takeoff.note = '正在请求浏览器定位…'
    const p = await locateByBrowser()
    takeoff.locating = false
    if (!p) {
      takeoff.note = '浏览器定位不可用（未授权或非安全上下文）'
      return false
    }
    takeoff.note = `已用浏览器定位${p.detail ? `（${p.detail}）` : ''}`
    return previewPlace(p)
  }

  /** 首次进入：上次选点 → IP 属地 → 内置默认点（北京国贸） */
  async function bootstrapTakeoff(): Promise<void> {
    // 用户已经开始操作（动了油门 / 按了键）→ 别动场景，否则飞行会被硬生生打断
    if (userActed) {
      takeoff.note = '已开始操作，保持当前场景'
      return
    }
    const saved = loadSavedTakeoff()
    if (saved) {
      takeoff.note = '沿用上次起飞点'
      await setTakeoff(saved, { remember: false, auto: true })
      return
    }
    takeoff.locating = true
    takeoff.note = '正在按 IP 属地定位…'
    const ip = await locateByIp()
    takeoff.locating = false
    // 定位这几秒里用户可能已经自己选了地点，那就别再拿 IP 结果盖掉
    if (userChoseTakeoff) return
    // 用户已经开始操作（动了油门 / 按了键）→ 别把场景换走，否则飞行会被硬生生打断
    if (userActed) {
      takeoff.note = '已开始操作，保持当前场景'
      return
    }
    if (ip) {
      takeoff.note = `已按 IP 属地定位${ip.detail ? `：${ip.detail}` : ''}`
      await setTakeoff(ip, { auto: true })
      return
    }
    takeoff.note = 'IP 定位不可用，使用默认起飞点'
    await setTakeoff(DEFAULT_PLACE, { remember: false, auto: true })
  }

  /** 手动触发 IP 定位 */
  async function locateIp(): Promise<boolean> {
    takeoff.locating = true
    takeoff.note = '正在按 IP 属地定位…'
    const ip = await locateByIp()
    takeoff.locating = false
    if (!ip) {
      takeoff.note = 'IP 定位失败（网络或接口不可用）'
      return false
    }
    takeoff.note = `已按 IP 属地定位${ip.detail ? `：${ip.detail}` : ''}`
    return setTakeoff(ip)
  }

  /** 浏览器精确定位（需授权） */
  async function locateGps(): Promise<boolean> {
    takeoff.locating = true
    takeoff.note = '正在请求浏览器定位…'
    const p = await locateByBrowser()
    takeoff.locating = false
    if (!p) {
      takeoff.note = '浏览器定位不可用（未授权或非安全上下文）'
      return false
    }
    takeoff.note = `已用浏览器定位${p.detail ? `（${p.detail}）` : ''}`
    return setTakeoff(p)
  }

  /** 地名搜索，返回候选列表由面板渲染 */
  function findPlaces(query: string): Promise<Place[]> {
    return searchPlace(query)
  }

  /** 屏幕内遥测 HUD 显隐 */
  function setHud(on: boolean): void {
    ui.hud = on
  }

  /** 虚拟摇杆显隐（手机端默认开，桌面端可从顶栏手动开） */
  function setTouchControls(on: boolean): void {
    ui.touchControls = on
  }

  /** 侧栏面板显隐（手机端收起后是一枚顶栏按钮） */
  function setPanelOpen(on: boolean): void {
    ui.panelOpen = on
  }

  /** 点选前把镜头切成自由：否则追尾相机每帧重算，用户拖不动地图找位置 */
  let pickPrevMode: FollowMode | null = null

  function restorePickMode(): void {
    if (!pickPrevMode) return
    const mode = pickPrevMode
    pickPrevMode = null
    setFollowMode(mode)
  }

  /** 地图点选：再点一次按钮或按 Esc 取消 */
  function startPick(): void {
    if (mpLocked()) {
      takeoff.note = '联机中已锁定起飞点，退出空域后才能更换'
      return
    }
    if (ui.picking) {
      cancelPick()
      return
    }
    ui.picking = true
    takeoff.note = '拖动 / 缩放地图找到位置，点击设为起飞点（Esc 取消）'
    if (ui.followMode !== 'free') {
      pickPrevMode = ui.followMode
      setFollowMode('free')
    }
    scene.value?.setPickMode(true)
  }

  function cancelPick(): void {
    ui.picking = false
    scene.value?.setPickMode(false)
    restorePickMode()
    if (takeoff.note.startsWith('拖动')) takeoff.note = ''
  }

  /** 地图点选 / 坐标输入落地：先逆地理编码取名，再照常搬场景 */
  async function pickTakeoff(
    lon: number,
    lat: number,
    note = '已把起飞点设为地图所选位置',
  ): Promise<boolean> {
    ui.picking = false
    scene.value?.setPickMode(false)
    restorePickMode()
    takeoff.locating = true
    takeoff.note = '正在解析所选地点…'
    const name = await reverseName(lon, lat)
    takeoff.locating = false
    const place: Place = {
      lon,
      lat,
      name: name || `${lat.toFixed(3)}°N, ${lon.toFixed(3)}°E`,
      detail: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
      source: 'manual',
    }
    takeoff.note = note
    return setTakeoff(place)
  }

  // ————————————————————————————————————————————
  // 多人联机：进入 / 退出 / 聊天（全球单一空域）
  // ————————————————————————————————————————————

  /** 空域进入流程绑定的 pagehide：关闭页面 / 刷新时立即向服务器告别 */
  let mpPagehideBound = false

  /**
   * 进入全球空域（唯一空域，无房间概念）。流程：
   * 1. 连接服务器，以无人机名称加入（服务器全局查重，重名拒绝）；
   * 2. 首个玩家把起飞前地图选好的点作为空域原点提交，后来者同步服务器返回的原点；
   * 3. 确认后把场景原点对齐到空域原点（全服共享一套 ENU 坐标，方案第 5 节）；
   * 4. 建远端机体管理器，会话就绪（mpReady）。
   */
  async function mpJoin(name: string, url?: string, origin?: MpOrigin): Promise<boolean> {
    const s = scene.value
    if (!s) return false
    if (mp.joining) return false
    mp.error = ''
    mp.joining = true
    mp.note = '连接服务器…'
    client.connect(url || mp.url || DEFAULT_MP_URL)
    mp.url = url || mp.url || DEFAULT_MP_URL
    try {
      // ack 自带 self/origin/players：不依赖 mp:joined 事件的到达时序（两包可能分批）
      const result = await client.join({ name, droneTypeId: ui.droneTypeId, origin })
      if (!result) {
        // 拒绝原因已由 onError 写进 mp.error（重名 / 空域满）
        mp.joining = false
        mp.note = ''
        return false
      }
      mp.worldOrigin = result.origin
      // 搬场景到空域原点。已在同一点时 setTakeoff 短路（sameSpot），瞬间完成
      const moved = await setTakeoff(
        {
          lon: result.origin.lon,
          lat: result.origin.lat,
          name: result.origin.placeName || '空域起飞点',
          detail: '全球空域统一起飞点',
          source: 'manual',
        },
        { remember: false },
      )
      if (!moved) {
        // 空域原点搬不过去（禁飞区等）：会话没意义，直接退出
        mp.error = '无法移动到空域起飞点，已退出'
        await mpLeave(true)
        mp.joining = false
        return false
      }
      if (!remote) remote = new RemoteDrones(s, mp.selfId)
      remote.syncRoster(mp.players)
      mpReady = true
      mpCrashSent = false
      mp.joining = false
      mp.note = ''
      mpChatSystem('会话就绪，空域内其他玩家的机体将出现在同一片天地里')
      // 20Hz 发布：撞毁只补发一次 c:1，重飞后自动恢复正常上报
      if (!mpPublishTimer) {
        mpPublishTimer = window.setInterval(() => {
          if (!mpReady || client.status !== 'joined') return
          if (crashed) {
            if (!mpCrashSent) {
              mpCrashSent = true
              client.publish(mpSnapshot(true))
            }
          } else {
            mpCrashSent = false
            client.publish(mpSnapshot(false))
          }
        }, 50)
      }
      // 连接即在场：关闭页面 / 刷新时立刻向服务器告别（socket 随页面关闭也会断开，这里是双保险）
      if (!mpPagehideBound) {
        mpPagehideBound = true
        window.addEventListener('pagehide', () => {
          if (client.connected) client.leave()
        })
      }
      audio.blip(880, 0.08, 0.045)
      return true
    } catch (err) {
      mp.error = `进入失败：${err instanceof Error ? err.message : String(err)}`
      mp.joining = false
      mp.note = ''
      return false
    }
  }

  /** 退出空域。silent=true 时不清错误字段（服务器踢人路径要用它展示原因） */
  async function mpLeave(silent = false): Promise<void> {
    const wasJoined = mpReady || client.status === 'joined'
    client.leave()
    remote?.disposeAll()
    mpReady = false
    mpCrashSent = false
    if (mpPublishTimer) {
      window.clearInterval(mpPublishTimer)
      mpPublishTimer = 0
    }
    mp.status = 'idle'
    mp.selfId = ''
    mp.selfName = ''
    mp.players = []
    mp.worldOrigin = null
    mp.note = ''
    if (!silent) mp.error = ''
    if (wasJoined && !silent) mpChatSystem('已退出空域')
  }

  /** 空域内发言（广播含自己：服务器会回发，界面不需要本地回显） */
  function mpSendChat(text: string): void {
    const t = text.trim()
    if (t) client.chat(t.slice(0, 200))
  }

  /** 联机中锁定起飞点切换：空域统一了原点，换点会破坏全服坐标系 */
  function mpLocked(): boolean {
    return mpReady
  }

  onBeforeUnmount(detach)

  /**
   * 复位到起始点。
   * keepThrottle：切换起飞点时用 true —— 场景是换了，但用户的油门设定不该被悄悄改掉
   * （旧场景里可能正在倒飞，负油门在新场景同样有效）。
   * keepCamera：配置页 → 飞行的过渡时用 true —— 镜头要自己飞到追尾位姿，
   * 不能在这里就被瞬移过去。
   */
  function reset(opts: { keepThrottle?: boolean; keepCamera?: boolean } = {}) {
    crashed = false
    crash.active = false
    crash.prompt = false
    crash.target = ''
    crash.impact = 0
    flip = null
    catchClock = 0
    ui.flipping = false
    // 撞毁快照已随坠毁发过 c:1：复位后重新开始正常上报（远端据此恢复渲染）
    mpCrashSent = false
    body.reset({ position: START })
    body.setStabilize(ui.stabilize)
    body.setThreeD(ui.threeD)
    body.setWind([0, 0, 0])
    applyTerrainBinding()
    windTimer = 0
    if (!opts.keepThrottle) ui.throttle = body.hoverThrottle
    setGimbal(GIMBAL_HOME_PITCH, 0)
    ui.trailRecording = true
    scene.value?.resetEffects()
    scene.value?.setDroneVisible(true)
    scene.value?.setAirflowVisible(ui.airflow)
    scene.value?.clearTrail()
    scene.value?.setTrailRecording(true)
    ui.trailPoints = 0
    if (!opts.keepCamera) scene.value?.snapCamera(0)
    audio.reset()
    audio.blip(520, 0.1, 0.04)
  }

  /** 撞击后从起始点重新开始 */
  function restart() {
    reset()
  }

  function setAirflow(on: boolean) {
    ui.airflow = on
    scene.value?.setAirflowVisible(on)
  }

  function gust() {
    body.setWind([0.55, 0.05, -0.35])
    windTimer = 0.9
  }

  function impulse() {
    body.applyImpulse([0.18, 0.05, -0.14], [0.11, 0.02, -0.09])
  }

  function cycleCamera() {
    const order: FollowMode[] = ['chase', 'world', 'fpv', 'free']
    ui.followMode = order[(order.indexOf(ui.followMode) + 1) % order.length]
    scene.value?.setFollowMode(ui.followMode)
    if (ui.followMode !== 'free') scene.value?.snapCamera(tele.yaw * (Math.PI / 180))
    audio.blip(720, 0.05, 0.04)
  }

  /** F 键：云台第一视角 ↔ 追尾，一键往返 */
  function toggleFpv() {
    setFollowMode(ui.followMode === 'fpv' ? 'chase' : 'fpv')
  }

  /**
   * 切换镜头模式。
   * apply=false：只改界面状态，不动场景（配置页选初始镜头时用 ——
   *   场景此刻是自由视角，贸然切到追尾会让镜头瞬移，过渡动画就白做了）。
   * snap=false：切模式后不立刻归位。
   */
  function setFollowMode(
    mode: FollowMode,
    opts: { snap?: boolean; apply?: boolean } = {},
  ): void {
    ui.followMode = mode
    if (opts.apply !== false) scene.value?.setFollowMode(mode)
    if (opts.snap !== false && mode !== 'free') {
      scene.value?.snapCamera(tele.yaw * (Math.PI / 180))
    }
    audio.blip(mode === 'fpv' ? 980 : 720, 0.05, 0.04)
  }

  /** 云台角度（度）：俯仰 -90（垂直下视）..30（仰视），偏航 -90..90（相对机头） */
  function setGimbal(pitch: number, yaw: number = ui.gimbalYaw) {
    if (Number.isFinite(pitch)) ui.gimbalPitch = Math.min(30, Math.max(-90, pitch))
    if (Number.isFinite(yaw)) ui.gimbalYaw = Math.min(90, Math.max(-90, yaw))
    scene.value?.setGimbal(ui.gimbalPitch, ui.gimbalYaw)
  }

  /** 云台回中：俯仰回到巡航角、偏航对正机头 */
  function resetGimbal() {
    setGimbal(GIMBAL_HOME_PITCH, 0)
  }

  function snapCamera() {
    scene.value?.snapCamera(tele.yaw * (Math.PI / 180))
  }

  function setDistance(v: number) {
    ui.distance = v
    scene.value?.setFollowDistance(v)
  }

  function zoomBy(deltaY: number) {
    if (ui.followMode === 'free') return
    const next = Math.min(220, Math.max(3, ui.distance * (1 + deltaY * 0.0012)))
    setDistance(next)
  }

  function setThrottle(v: number) {
    // 3D 模式才允许负油门；普通模式仍夹在 0..1，避免一开倒飞就掉高
    const lo = ui.threeD ? -1 : 0
    ui.throttle = Math.min(1, Math.max(lo, v))
    // 用户已经动过油门 → 启动时的自动定位不该再把场景换走
    if (Math.abs(ui.throttle - body.hoverThrottle) > 0.005) userActed = true
  }

  function setThreeD(on: boolean) {
    ui.threeD = on
    body.setThreeD(on)
    if (!on) catchClock = 0
    if (!on && ui.throttle < 0) ui.throttle = body.hoverThrottle
    audio.blip(on ? 1040 : 620, 0.06, 0.045)
  }

  function setStabilize(on: boolean) {
    ui.stabilize = on
    body.setStabilize(on)
    if (on) catchClock = 0
    // 倒扣时切回增稳会先把机身翻正，此时反向油门会把机子往地面推，先归到正向悬停
    if (on && ui.throttle < 0) ui.throttle = body.hoverThrottle
    audio.blip(on ? 880 : 560, 0.06, 0.045)
  }

  async function setImagery(kind: ImageryKind) {
    ui.imagery = kind
    // 上一次的回落原因只在当时有意义，换底图就清掉
    ui.mapNote = ''
    await scene.value?.setImagery(kind)
  }

  function setBuildings(show: boolean) {
    ui.buildings = show
    scene.value?.setBuildingsVisible(show)
  }

  function setDroneScale(scale: number) {
    ui.droneScale = scale
    scene.value?.setDroneScale(scale)
    // 碰撞半径与视觉缩放同步：机体在画面上多大，就能提前多远撞上山壁
    body.setCollisionRadius(Math.max(0.5, 0.14 * scale))
  }

  /**
   * 切换机型（配置页的「无人机类型」）。
   * 质量 / 惯量 / 推力 / 角速率一起换，油门刻度按新机型重算 ——
   * 沿用旧机型的悬停油门，重载机一进场就往下掉。
   */
  function setDroneType(id: string): void {
    const d = getDroneType(id)
    ui.droneTypeId = d.id
    body.applyProfile(toPhysicsProfile(d))
    body.reset({ position: START })
    ui.throttle = body.hoverThrottle
    setDroneScale(d.droneScale)
  }

  // —— 飞行轨迹 ——
  function setTrailVisible(visible: boolean) {
    ui.trail = visible
    scene.value?.setTrailVisible(visible)
  }

  /** 轨迹颜色（十六进制） */
  function setTrailColor(hex: string) {
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return
    ui.trailColor = hex
    scene.value?.setTrailColor(hex)
  }

  /** 轨迹线宽（像素） */
  function setTrailWidth(width: number) {
    ui.trailWidth = Math.min(8, Math.max(1, width))
    scene.value?.setTrailWidth(ui.trailWidth)
  }

  function setTrailRecording(recording: boolean) {
    ui.trailRecording = recording
    scene.value?.setTrailRecording(recording)
  }

  function clearTrail() {
    scene.value?.clearTrail()
    ui.trailPoints = 0
  }

  function setWind(on: boolean) {
    ui.wind = on
    if (!on) {
      body.setWind([0, 0, 0])
      windTimer = 0
    }
  }

  return {
    tele,
    ui,
    crash,
    takeoff,
    body,
    attach,
    attachScene,
    startFlight,
    stopFlight,
    detach,
    reset,
    restart,
    setTakeoff,
    previewPlace,
    pickPreview,
    previewByIp,
    previewByGps,
    locateIp,
    locateGps,
    findPlaces,
    setHud,
    startPick,
    cancelPick,
    pickTakeoff,
    presets: PRESET_CITIES,
    gust,
    impulse,
    cycleCamera,
    toggleFpv,
    setFollowMode,
    setGimbal,
    resetGimbal,
    gimbalHome: { pitch: GIMBAL_HOME_PITCH, yaw: 0 },
    snapCamera,
    setDistance,
    zoomBy,
    setThrottle,
    setStabilize,
    setThreeD,
    roll360,
    invertFlight,
    hoverTrim,
    setImagery,
    setBuildings,
    setDroneScale,
    setDroneType,
    setWind,
    setAirflow,
    setTerrainCollision,
    setTrailVisible,
    setTrailRecording,
    setTrailColor,
    setTrailWidth,
    clearTrail,
    setSound,
    toggleSound,
    setVolume,
    setMotorSound,
    setWindSound,
    setFxSound,
    audio,
    // —— 多人联机 ——
    mp,
    /** 调试/自检用：远端机体管理器（联机中才有内容） */
    get mpRemote() {
      return remote
    },
    mpJoin,
    mpLeave,
    mpSendChat,
    // —— 移动端触控 ——
    touchInput,
    setTouchControls,
    setPanelOpen,
    startPosition: START,
    get hoverThrottle() {
      return body.hoverThrottle
    },
    crashSpeed: CRASH_SPEED,
  }
}

export type DroneSim = ReturnType<typeof useDroneSim>
