// 视觉特效：飞行时的空气流场（世界空间流线）+ 撞击爆炸（火球 / 碎片 / 冲击波 / 烟）。
// 全部用 BillboardCollection 实现：单个 draw call，逐帧改 position / width / color 即可。
// 位置统一用场景局部米制坐标（x=东、y=上、z=南），由调用方给出 localToEcef。
import type * as CesiumNS from 'cesium'

const Cesium = window.Cesium

export type LocalToEcef = (
  x: number,
  y: number,
  z: number,
  result: CesiumNS.Cartesian3,
) => CesiumNS.Cartesian3

/**
 * 流线贴图：深色描边 + 亮青白核心。
 * 必须是**正方形**图：Cesium 的 Billboard 在 width≠height（sizeInMeters 下）时
 * 会整体不渲染，所以流线长度只能靠贴图内部占比表达，角度靠 billboard.rotation。
 * 单色白线在城市（浅灰建筑 / 浅色地面）上几乎看不见，加一圈深色描边才能同时
 * 在亮背景和暗背景上读出「空气划过」的形状。
 */
function streakTexture(): string {
  const s = 256
  const c = document.createElement('canvas')
  c.width = s
  c.height = s
  const g = c.getContext('2d')!
  // 线长占 180/256 ≈ 0.70：留出 45° 旋转不被裁掉的余量（180×1.414 ≈ 254）
  const x0 = (s - 180) / 2
  const fade = (color: string, peak: number) => {
    const grad = g.createLinearGradient(x0, 0, x0 + 180, 0)
    grad.addColorStop(0, color.replace('ALPHA', '0'))
    grad.addColorStop(0.28, color.replace('ALPHA', String(peak)))
    grad.addColorStop(0.56, color.replace('ALPHA', String(peak)))
    grad.addColorStop(1, color.replace('ALPHA', '0'))
    return grad
  }
  // 深色描边
  g.fillStyle = fade('rgba(10,28,44,ALPHA)', 0.32)
  g.fillRect(x0, s / 2 - 7, 180, 14)
  // 亮核心
  g.fillStyle = fade('rgba(240,252,255,ALPHA)', 1)
  g.fillRect(x0, s / 2 - 3, 180, 6)
  // 垂直羽化：只在最外侧收边，避免硬边出现方框感
  const ver = g.createLinearGradient(0, 0, 0, s)
  ver.addColorStop(0, 'rgba(255,255,255,0)')
  ver.addColorStop(0.14, 'rgba(255,255,255,1)')
  ver.addColorStop(0.86, 'rgba(255,255,255,1)')
  ver.addColorStop(1, 'rgba(255,255,255,0)')
  g.globalCompositeOperation = 'destination-in'
  g.fillStyle = ver
  g.fillRect(0, 0, s, s)
  return c.toDataURL('image/png')
}

/** 径向光斑（火球 / 闪光 / 碎片） */
function glowTexture(): string {
  const s = 128
  const c = document.createElement('canvas')
  c.width = s
  c.height = s
  const g = c.getContext('2d')!
  const rad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
  rad.addColorStop(0, 'rgba(255,255,255,1)')
  rad.addColorStop(0.25, 'rgba(255,255,255,0.92)')
  rad.addColorStop(0.55, 'rgba(255,255,255,0.42)')
  rad.addColorStop(0.82, 'rgba(255,255,255,0.1)')
  rad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = rad
  g.beginPath()
  g.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2)
  g.fill()
  return c.toDataURL('image/png')
}

/** 冲击波圆环 */
function ringTexture(): string {
  const s = 128
  const c = document.createElement('canvas')
  c.width = s
  c.height = s
  const g = c.getContext('2d')!
  g.strokeStyle = 'rgba(255,255,255,0.95)'
  g.lineWidth = 7
  g.beginPath()
  g.arc(s / 2, s / 2, s / 2 - 8, 0, Math.PI * 2)
  g.stroke()
  // 外侧再压一层柔光
  g.filter = 'blur(3px)'
  g.stroke()
  return c.toDataURL('image/png')
}

interface AirParticle {
  bb: CesiumNS.Billboard
  x: number
  y: number
  z: number
  /** 湍流相位，悬停时也有缓慢的空气流动 */
  phase: number
  size: number
  /** 绕机体斜掠的方位偏转（弧度），避免所有流线都沿视线方向投影成短线 */
  bias: number
  /** 绕流抬升（弧度），模拟气流翻过机体上方 */
  rise: number
  /** 淡入进度 0→1：重生位置是瞬移的，直接显形会闪 */
  fade: number
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/** 飞行时从机体周围掠过的空气流线 */
export class AirflowField {
  private collection: CesiumNS.BillboardCollection
  private parts: AirParticle[] = []
  private tex = ''
  private tmpA = new Cesium.Cartesian3()
  private tmpB = new Cesium.Cartesian3()
  private visible = true
  /** 粒子分布半径：只裹住机体周围一小圈，不占据相机与机体之间的视线 */
  private static readonly R = 3.2
  private static readonly RY = 1.7
  private static readonly KILL = 7

  constructor(
    private scene: CesiumNS.Scene,
    private toEcef: LocalToEcef,
    count = 64,
  ) {
    this.collection = new Cesium.BillboardCollection({ scene })
    this.tex = streakTexture()
    for (let i = 0; i < count; i++) {
      const bb = this.collection.add({
        position: Cesium.Cartesian3.ZERO,
        image: this.tex,
        width: 2,
        height: 2,
        sizeInMeters: true,
        color: Cesium.Color.WHITE.withAlpha(0),
        disableDepthTestDistance: 0,
      })
      this.parts.push({
        bb,
        x: 0,
        y: 0,
        z: 0,
        phase: Math.random() * Math.PI * 2,
        size: 0.7 + Math.random() * 0.7,
        bias: (Math.random() * 2 - 1) * 0.62,
        rise: (Math.random() * 2 - 1) * 0.24,
        fade: 0,
      })
    }
  }

  get primitive(): CesiumNS.BillboardCollection {
    return this.collection
  }

  get count(): number {
    return this.parts.length
  }

  /** 自检用：抽样几条流线的世界位置与屏幕表现，判断是否真的画在视野里 */
  sample(): { x: number; y: number; z: number; w: number; h: number; rot: number; a: number; show: boolean }[] {
    return this.parts.slice(0, 6).map((p) => ({
      x: Math.round(p.x * 10) / 10,
      y: Math.round(p.y * 10) / 10,
      z: Math.round(p.z * 10) / 10,
      w: Math.round((p.bb.width ?? 0) * 100) / 100,
      h: Math.round((p.bb.height ?? 0) * 100) / 100,
      rot: Math.round(p.bb.rotation * 100) / 100,
      a: Math.round(p.bb.color.alpha * 100) / 100,
      show: p.bb.show,
    }))
  }

  setVisible(v: boolean): void {
    this.visible = v
    this.collection.show = v
  }

  /** 把粒子撒到机体周围（首次 / 复位后调用） */
  seed(drone: readonly number[]): void {
    for (const p of this.parts) this.respawn(p, drone, [0, 0, 0], true)
    for (const p of this.parts) {
      // 首次布场直接显形，否则复位后要等半秒才看得到气流
      p.fade = 1
      p.bb.position = this.toEcef(p.x, p.y, p.z, this.tmpA)
    }
  }

  /**
   * @param drone    机体位置（局部米）
   * @param velocity 机体速度（局部米/秒）
   * @param wind     风速（局部米/秒）
   * @param camera   相机位置（局部米，可选）：贴到镜头前的流线淡出，避免糊屏
   */
  update(
    dt: number,
    drone: readonly number[],
    velocity: readonly number[],
    wind: readonly number[],
    camera?: readonly number[],
  ): void {
    if (!this.visible || dt <= 0) return
    // 刚体解算若抖出 NaN，流线位置会变成 NaN 并污染 BillboardCollection 的包围球，
    // 之后 Cesium 的可见性剔除会 new Array(NaN) 停掉整个渲染循环
    if (!Number.isFinite(drone[0] + drone[1] + drone[2])) return
    if (!Number.isFinite(velocity[0] + velocity[1] + velocity[2])) return
    if (!Number.isFinite(wind[0] + wind[1] + wind[2])) return
    const speed = Math.hypot(velocity[0], velocity[1], velocity[2])
    // 空气相对机体的流动方向（世界系）：静止空气 + 风，减去机体自身速度
    const fx = wind[0] - velocity[0]
    const fy = wind[1] - velocity[1]
    const fz = wind[2] - velocity[2]
    const fLen = Math.hypot(fx, fy, fz) || 1
    const ux = fx / fLen
    const uy = fy / fLen
    const uz = fz / fLen

    for (const p of this.parts) {
      // 湍流：悬停时也有一点缓慢漂移，不至于完全静止
      const t = performance.now() * 0.00035 + p.phase
      p.x += (wind[0] + Math.sin(t) * 0.35) * dt
      p.y += (wind[1] + Math.cos(t * 1.7) * 0.12) * dt
      p.z += (wind[2] + Math.cos(t * 0.8) * 0.35) * dt
      const dx = p.x - drone[0]
      const dy = p.y - drone[1]
      const dz = p.z - drone[2]
      if (dx * dx + dy * dy + dz * dz > AirflowField.KILL * AirflowField.KILL) {
        this.respawn(p, drone, velocity)
      }
    }

    // 速度越快，流线略长略亮；但必须始终是「机身边缘的气流感」。
    // 之前半径 6.8 m + 长度上限 3.4 m，前飞时整屏都是斜白线，看上去就是画面在闪。
    const alpha = 0.07 + Math.min(0.1, speed * 0.007)
    const len = Math.min(1.7, 0.6 + speed * 0.06)

    for (const p of this.parts) {
      // 重生是瞬移：0.3 s 内淡入，避免凭空出现在屏幕上造成的闪烁
      p.fade = Math.min(1, p.fade + dt / 0.3)
      const ox = p.x - drone[0]
      const oy = p.y - drone[1]
      const oz = p.z - drone[2]
      const dist = Math.hypot(ox, oy, oz)
      // 接近存活边界时淡出，重生前的最后一帧不会「啪」地消失
      const edge = 1 - clamp01((dist - AirflowField.R * 1.25) / (AirflowField.KILL - AirflowField.R * 1.25))
      let near = 1
      let shrink = 1
      if (camera) {
        const cd = Math.hypot(p.x - camera[0], p.y - camera[1], p.z - camera[2])
        near = clamp01((cd - 6) / 6)
        // 贴到镜头前时按距离收缩，防止一条流线糊满视野
        if (cd < 12) shrink = Math.max(0.3, cd / 12)
      }
      const a = this.toEcef(p.x, p.y, p.z, this.tmpA)
      p.bb.position = a
      // 逐条求屏幕角度，并让每条流线绕机体斜掠：把主气流方向绕 Y 轴偏转 bias、
      // 再抬起 rise。若全部沿同一方向，追尾视角下会投影成极短的线段叠成一团白雾。
      const cb = Math.cos(p.bias)
      const sb = Math.sin(p.bias)
      const dx = ux * cb + uz * sb
      const dz = uz * cb - ux * sb
      const dy = uy + p.rise
      const b = this.toEcef(p.x + dx * 3, p.y + dy * 3, p.z + dz * 3, this.tmpB)
      const pa = Cesium.SceneTransforms.worldToWindowCoordinates(this.scene, a)
      const pb = Cesium.SceneTransforms.worldToWindowCoordinates(this.scene, b)
      if (pa && pb) {
        const ddx = pb.x - pa.x
        const ddy = pb.y - pa.y
        if (ddx * ddx + ddy * ddy > 2) p.bb.rotation = -Math.atan2(ddy, ddx)
      }
      // 贴图内线长占 0.70，所以 billboard 边长要放大 1/0.70 才能得到期望的视觉长度
      const size = (len * p.size * shrink) / 0.703
      p.bb.width = size
      p.bb.height = size
      p.bb.color = Cesium.Color.WHITE.withAlpha(alpha * p.fade * edge * near * (0.6 + p.size * 0.4))
    }
  }

  private respawn(p: AirParticle, drone: readonly number[], velocity: readonly number[], anywhere = false): void {
    const speed = Math.hypot(velocity[0], velocity[1], velocity[2])
    const R = AirflowField.R
    // 上游偏移：新流线落在机体前进方向的前方，飞过去时刚好从身边掠过。
    // 必须小于 KILL - R，否则粒子刚出生就越界、每帧反复重生，看起来就是画面在闪。
    let ax = 0
    let az = 0
    if (!anywhere && speed > 0.8) {
      const lead = Math.min(R * 0.7, speed * 0.3)
      ax = (velocity[0] / speed) * lead
      az = (velocity[2] / speed) * lead
    }
    p.x = drone[0] + ax + (Math.random() * 2 - 1) * R
    p.y = drone[1] + (Math.random() * 2 - 1) * AirflowField.RY
    p.z = drone[2] + az + (Math.random() * 2 - 1) * R
    p.fade = 0
  }
}

type FxKind = 'flash' | 'fire' | 'debris' | 'smoke' | 'ring'

interface FxParticle {
  bb: CesiumNS.Billboard
  kind: FxKind
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  life: number
  age: number
  size0: number
  size1: number
  drag: number
  gravity: number
  alpha: number
  hot: number
}

const easeOut = (t: number) => 1 - (1 - t) * (1 - t)

/** 撞击爆炸：闪光 + 火球 + 碎片 + 冲击波 + 烟 */
export class ExplosionFx {
  readonly additive: CesiumNS.BillboardCollection
  readonly soft: CesiumNS.BillboardCollection
  private parts: FxParticle[] = []
  private glow = ''
  private ring = ''
  private tmp = new Cesium.Cartesian3()
  private scratch = new Cesium.Color()
  private elapsed = 0
  private active = false
  /** 供相机抖动用 */
  power = 0

  constructor(
    scene: CesiumNS.Scene,
    private toEcef: LocalToEcef,
  ) {
    // Cesium 的 BillboardCollection 只支持 OPAQUE / TRANSLUCENT 三档，
    // 没有叠加混合档位，这里靠「高亮贴图 + alpha」近似叠加发光
    this.additive = new Cesium.BillboardCollection({ scene })
    this.soft = new Cesium.BillboardCollection({ scene })
    this.glow = glowTexture()
    this.ring = ringTexture()
  }

  get isActive(): boolean {
    return this.active
  }

  get particleCount(): number {
    return this.parts.length
  }

  /** 在局部米制坐标处引爆；strength 1≈常规撞击，>1 更猛烈 */
  detonate(at: readonly number[], strength = 1): void {
    this.reset()
    this.active = true
    this.power = Math.min(1.8, 0.7 + strength * 0.6)
    const s = Math.min(2, 0.85 + strength * 0.25)

    // 闪光：极短、极亮（别做太大，否则近距离看像一块发光圆盘）
    this.spawn('flash', at, [0, 0, 0], 0.24, s * 2.4, s * 6.4, 0, 0, 1, 1)

    // 火球：多层橙色球，向上飘；大小差到两倍、位置分散，叠出不规则火团（同心会糊成一个圆盘）
    for (let i = 0; i < 9; i++) {
      const dir = randUnit()
      this.spawn(
        'fire',
        [at[0] + dir[0] * 1.8, at[1] + dir[1] * 1.3, at[2] + dir[2] * 1.8],
        [dir[0] * (2.4 + Math.random() * 3), dir[1] * 1.8 + 1.8, dir[2] * (2.4 + Math.random() * 3)],
        0.56 + Math.random() * 0.42,
        s * (0.5 + Math.random() * 0.5),
        s * (1.5 + Math.random() * 2.4),
        1.8,
        1.6,
        0.5,
        1,
      )
      // 错开各颗火球的燃烧阶段，否则十颗同时处于「全白」期会糊成一个发光圆盘
      const last = this.parts[this.parts.length - 1]
      last.age = last.life * Math.random() * 0.45
    }

    // 火舌：向外炸开的小火团，短命，负责把轮廓打碎
    for (let i = 0; i < 7; i++) {
      const dir = randUnit()
      this.spawn(
        'fire',
        [at[0] + dir[0] * 2.6, at[1] + dir[1] * 1.6, at[2] + dir[2] * 2.6],
        [dir[0] * (5 + Math.random() * 4), dir[1] * 3 + 2.4, dir[2] * (5 + Math.random() * 4)],
        0.34 + Math.random() * 0.18,
        s * 0.5,
        s * (1.1 + Math.random() * 0.7),
        2.4,
        2.2,
        0.62,
        1,
      )
    }

    // 碎片：带重力的高速火星
    for (let i = 0; i < 44; i++) {
      const dir = randUnit()
      const sp = 7 + Math.random() * 16
      this.spawn(
        'debris',
        [at[0], at[1], at[2]],
        [dir[0] * sp, dir[1] * sp * 0.8 + 4, dir[2] * sp],
        1.2 + Math.random() * 1.2,
        s * 0.55,
        s * 0.3,
        0.5,
        -9.4,
        1,
        0.85,
      )
    }

    // 冲击波：一圈快速扩张的细环（别做太大，否则像肥皂泡）
    this.spawn('ring', at, [0, 0, 0], 0.62, s * 1.4, s * 7.5, 0, 0, 0.62, 1)

    // 烟：慢、大、久
    for (let i = 0; i < 10; i++) {
      const dir = randUnit()
      this.spawn(
        'smoke',
        [at[0] + dir[0] * 0.8, at[1] + dir[1] * 0.6, at[2] + dir[2] * 0.8],
        [dir[0] * 1.4, 1.1 + Math.random() * 1.6, dir[2] * 1.4],
        2.6 + Math.random() * 1.6,
        s * 1.3,
        s * (6 + Math.random() * 3.5),
        1.1,
        0.16,
        0.72,
        1,
      )
    }
  }

  /** 低速擦碰：少量灰白碎屑，不改变机体状态（刚体碰撞的视觉反馈） */
  impact(at: readonly number[], strength = 1): void {
    this.active = true
    this.power = Math.max(this.power, Math.min(0.4, strength * 0.35))
    const n = Math.round(4 + Math.min(9, strength * 5))
    for (let i = 0; i < n; i++) {
      const dir = randUnit()
      const sp = 2.2 + Math.random() * 4
      this.spawn(
        'debris',
        at,
        [dir[0] * sp, dir[1] * sp + 1.2, dir[2] * sp],
        0.32 + Math.random() * 0.3,
        0.2,
        0.07,
        1.4,
        -7.5,
        0.8,
        1,
      )
    }
  }

  reset(): void {
    this.additive.removeAll()
    this.soft.removeAll()
    this.parts = []
    this.active = false
    this.power = 0
    this.elapsed = 0
  }

  update(dt: number): void {
    if (!this.active) {
      if (this.power > 0) this.power = Math.max(0, this.power - dt * 2.6)
      return
    }
    this.elapsed += dt
    let alive = 0
    for (const p of this.parts) {
      p.age += dt
      const t = Math.min(1, p.age / p.life)
      if (t >= 1) {
        p.bb.show = false
        continue
      }
      alive++
      const damp = Math.max(0, 1 - p.drag * dt)
      p.vx *= damp
      p.vz *= damp
      p.vy = p.vy * damp + p.gravity * dt
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.z += p.vz * dt
      p.bb.position = this.toEcef(p.x, p.y, p.z, this.tmp)
      const size = p.size0 + (p.size1 - p.size0) * easeOut(t)
      p.bb.width = size
      p.bb.height = size

      let a = p.alpha
      if (p.kind === 'flash') a *= 1 - t
      else if (p.kind === 'fire') a *= Math.pow(1 - t, 1.05)
      else if (p.kind === 'debris') a *= 1 - t * t
      else if (p.kind === 'smoke') a *= Math.min(1, t * 3.2) * Math.pow(1 - t, 0.9)
      else if (p.kind === 'ring') a *= Math.pow(1 - t, 2)

      // 颜色：火球由白黄 → 橙 → 暗红；烟由深灰转淡
      let r = 1
      let g = 1
      let b = 1
      if (p.kind === 'fire' || p.kind === 'flash') {
        // 始终比背景亮：先白黄，再转橙，最后偏红，避免在浅色屋面上糊成暗斑
        r = 1
        g = 0.52 + 0.48 * Math.max(0, 1 - t * 2.1)
        b = 0.14 + 0.76 * Math.max(0, 1 - t * 3.8)
      } else if (p.kind === 'debris') {
        r = 1
        g = 0.78 - 0.5 * t
        b = 0.42 - 0.36 * t
      } else if (p.kind === 'smoke') {
        const v = 0.16 + 0.22 * t
        r = v
        g = v * 0.96
        b = v * 0.92
      } else {
        r = 0.72
        g = 0.92
        b = 1
      }
      this.scratch.red = r * p.hot
      this.scratch.green = g * p.hot
      this.scratch.blue = b * p.hot
      this.scratch.alpha = Math.max(0, Math.min(1, a))
      p.bb.color = this.scratch
    }
    if (alive === 0) {
      this.active = false
      this.additive.removeAll()
      this.soft.removeAll()
      this.parts = []
    }
    this.power = Math.max(0, this.power - dt * 1.9)
  }

  private spawn(
    kind: FxKind,
    at: readonly number[],
    vel: [number, number, number],
    life: number,
    size0: number,
    size1: number,
    drag: number,
    gravity: number,
    alpha: number,
    hot: number,
  ): void {
    const target = kind === 'smoke' ? this.soft : this.additive
    const bb = target.add({
      position: Cesium.Cartesian3.ZERO,
      image: kind === 'ring' ? this.ring : this.glow,
      width: size0,
      height: size0,
      sizeInMeters: true,
      color: Cesium.Color.WHITE,
      disableDepthTestDistance: 0,
    })
    this.parts.push({
      bb,
      kind,
      x: at[0],
      y: at[1],
      z: at[2],
      vx: vel[0],
      vy: vel[1],
      vz: vel[2],
      life,
      age: 0,
      size0,
      size1,
      drag,
      gravity,
      alpha,
      hot,
    })
  }
}

function randUnit(): [number, number, number] {
  const u = Math.random() * 2 - 1
  const th = Math.random() * Math.PI * 2
  const r = Math.sqrt(1 - u * u)
  return [r * Math.cos(th), u, r * Math.sin(th)]
}
