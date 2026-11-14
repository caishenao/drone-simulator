// 远端玩家机体：Cesium GLB 实例 + 快照插值 + 名字标签 + 撞毁表现。
//
// 渲染路径与本地机体一致：模型矩阵用 CesiumScene.composeDroneMatrix 组装
// （房间成员都搬过同一个起飞原点，快照 ENU 就是本场景 ENU，不需要二次换算）。
// 插值策略见 docs/multiplayer-plan.md 第 4 节：本地时钟 + 120ms 缓冲 + 短程外推。
//
// Cesium 走 window.Cesium（UMD 全局，与 CesiumScene 同款），类型来自 npm 包——
// 千万不要 import 'cesium' 的运行时，否则整个 ESM 构建会被拉进 Vite 包体。
import type * as CesiumNS from 'cesium'
import { getDroneType } from '../config/droneTypes'
import type { CesiumScene } from '../cesium/CesiumScene'
import type { MpPlayer, Snapshot } from './snapshot'
import { INTERP_DELAY_MS, sampleBuffer, sanitizeSnapshot, type TimedSnap } from './snapshot'

const Cesium = window.Cesium

const MODEL_URL = '/models/drone_mini3pro.glb'

// 旋翼节点每帧都要「基准矩阵 × 自转矩阵」：scratch 提出来，8 人 60fps 也不产生 GC 压力
const rotorRot = new Cesium.Matrix3()
const rotorLocal = new Cesium.Matrix4()

/** 单个远端玩家 */
class RemoteDrone {
  readonly id: string
  name: string
  color: string
  /** 最近收到的快照时刻（ms，performance.now）——超时「信号弱」判定用 */
  lastSeen = 0
  private scene: CesiumScene
  private model: CesiumNS.Model | null = null
  private loading = false
  private rotorBound = false
  private rotors: { node: CesiumNS.ModelNode; base: CesiumNS.Matrix4; dir: number; phase: number }[] = []
  private rotorAngle = 0
  private buffer: TimedSnap[] = []
  private matrix = new Cesium.Matrix4()
  private ecef = new Cesium.Cartesian3()
  private label: CesiumNS.Entity | null = null
  private labelPos = new Cesium.Cartesian3()
  /** 已对当前一段撞毁播过爆炸：c:0（重飞）后复位 */
  private crashShown = false
  private renderOut = {
    pos: [0, 0, 0] as number[],
    quat: [0, 0, 0, 1] as number[],
    vel: [0, 0, 0] as number[],
    rpm: 0,
    gimbalPitch: -12,
    gimbalYaw: 0,
    crashed: false,
    droneTypeId: 'mini3pro',
  }

  constructor(scene: CesiumScene, player: MpPlayer) {
    this.scene = scene
    this.id = player.id
    this.name = player.name
    this.color = player.color
    this.ensureModel()
    this.ensureLabel()
  }

  /** 同一 GLB URL 被 Cesium 缓存，第 N 个玩家只付解析之外的开销 */
  private ensureModel(): void {
    if (this.model || this.loading) return
    this.loading = true
    void Cesium.Model.fromGltfAsync({
      url: MODEL_URL,
      modelMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY),
      scale: getDroneType(this.renderOut.droneTypeId).droneScale,
      minimumPixelSize: 18,
      upAxis: Cesium.Axis.Y,
      forwardAxis: Cesium.Axis.X,
      allowPicking: false,
    })
      .then((model) => {
        model.shadows = Cesium.ShadowMode.DISABLED
        this.scene.viewer.scene.primitives.add(model)
        this.model = model
      })
      .catch((err) => {
        // 模型加载失败不致命：标签仍在，能知道这里有一名玩家
        console.warn('[mp] 远端机体模型加载失败', err)
      })
      .finally(() => {
        this.loading = false
      })
  }

  private ensureLabel(): void {
    if (this.label) return
    const color = Cesium.Color.fromCssColorString(this.color)
    // position 用 CallbackPositionProperty 读同一个 labelPos 实例：每帧原地改写即可生效。
    // 不能传裸 Cartesian3 —— Entity 会包成 ConstantProperty，getValue 返回的是克隆，
    // 原地修改根本传不进去（标签会永远钉在场景原点）
    this.label = this.scene.viewer.entities.add({
      position: new Cesium.CallbackPositionProperty(() => this.labelPos, false),
      point: {
        pixelSize: 6,
        color,
        outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: this.name,
        font: '600 12px system-ui, sans-serif',
        fillColor: Cesium.Color.fromCssColorString('#eaf6ff'),
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString('#0a1c2a').withAlpha(0.72),
        backgroundPadding: new Cesium.Cartesian2(7, 4),
        style: Cesium.LabelStyle.FILL,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -10),
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 3000),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    })
  }

  /** 收到快照：消毒 → 入缓冲（限长），撞毁沿处理 */
  apply(rawSnap: Snapshot, now: number): void {
    const snap = sanitizeSnapshot(rawSnap)
    if (!snap) return
    this.lastSeen = now
    this.buffer.push({ recvAt: now, snap })
    // 缓冲只需覆盖「延迟 + 外推」窗口：1.5s 绰绰有余
    if (this.buffer.length > 60) this.buffer.splice(0, this.buffer.length - 60)
    // 撞毁标记直接落 renderOut：渲染管线在此之前可能已被 NaN 防护拦下，标签状态不能等它
    this.renderOut.crashed = snap.c === 1
    if (snap.c === 1 && !this.crashShown) {
      this.crashShown = true
      // 在对方最后一次上报的位置原地引爆（强度按速度略加权）
      const speed = Math.hypot(snap.v[0], snap.v[1], snap.v[2])
      this.scene.detonate(snap.p, Math.min(1.8, 0.8 + speed / 14))
    } else if (snap.c === 0) {
      this.crashShown = false
    }
    if (this.model) this.model.show = snap.c !== 1
    this.refreshLabel()
  }

  /** 只更新玩家元数据（重连换色 / 改名等） */
  updateMeta(player: MpPlayer): void {
    this.name = player.name
    this.color = player.color
    this.refreshLabel()
  }

  private refreshLabel(): void {
    if (!this.label) return
    const crashed = this.renderOut.crashed
    // entity 上的属性是 Property 对象：创建后更新要走 ConstantProperty，不能直接赋原始值
    const text = (crashed ? `${this.name} · 已撞毁` : this.name) + (this.stale ? ' · 信号弱' : '')
    this.label.label!.text = new Cesium.ConstantProperty(text)
    this.label.point!.color = new Cesium.ConstantProperty(
      crashed ? Cesium.Color.GREY : Cesium.Color.fromCssColorString(this.color),
    )
  }

  private stale = false

  /** 每帧推进：插值 → 模型矩阵 → 旋翼 → 标签。返回 false = 尚无有效数据 */
  render(now: number, dt: number): boolean {
    // 「信号弱」：3s 没有新快照（对端卡死 / 掉线），机体冻结在最后位置、标签降级提示
    const wasStale = this.stale
    this.stale = now - this.lastSeen > 3000 && this.lastSeen > 0
    if (this.stale !== wasStale) this.refreshLabel()
    const kind = sampleBuffer(this.buffer, now - INTERP_DELAY_MS, this.renderOut)
    if (kind === 2 && this.buffer.length === 0) return false
    const [x, y, z] = this.renderOut.pos
    if (!Number.isFinite(x + y + z)) return false
    if (this.model) {
      // 撞毁的机体不渲染（爆炸已播），但保留标签
      this.model.show = !this.renderOut.crashed
      this.scene.composeDroneMatrix(this.renderOut.pos, this.renderOut.quat, this.matrix)
      // 机型缩放跟玩家自己的机型走（换机型的证据就是后续快照的 d 字段）
      this.model.scale = getDroneType(this.renderOut.droneTypeId).droneScale
      this.model.modelMatrix = this.matrix
      Cesium.Matrix4.getTranslation(this.matrix, this.ecef)
      this.updateRotors(dt)
    } else {
      // 模型未就绪：标签先按插值位置直算，别挂在原点
      this.scene.localToEcef(x, y, z, this.ecef)
    }
    this.labelPos.x = this.ecef.x
    this.labelPos.y = this.ecef.y
    this.labelPos.z = this.ecef.z
    return true
  }

  /** 旋翼自转：与 CesiumScene.updateRotorSpin 同款（绕电机轴、相位错开、负 rpm 反转） */
  private updateRotors(dt: number): void {
    if (!this.model) return
    if (!this.rotorBound) {
      const spec: [string, number][] = [
        ['Rotor_FL', 1],
        ['Rotor_FR', -1],
        ['Rotor_RL', -1],
        ['Rotor_RR', 1],
      ]
      const found: RemoteDrone['rotors'] = []
      for (const [name, dir] of spec) {
        const node = this.model.getNode(name)
        if (!node) return // 场景图未就绪：下一帧再绑
        found.push({ node, base: Cesium.Matrix4.clone(node.matrix), dir, phase: found.length * 1.7 })
      }
      this.rotors = found
      this.rotorBound = found.length === 4
    }
    if (this.rotors.length === 0 || dt <= 0) return
    const rpm = this.renderOut.rpm
    const dir = rpm < 0 ? -1 : 1
    const revPerSec = Math.min(11, Math.abs(rpm) / 780)
    this.rotorAngle = (this.rotorAngle + dir * revPerSec * dt * Math.PI * 2) % (Math.PI * 2)
    for (const r of this.rotors) {
      Cesium.Matrix3.fromRotationY(this.rotorAngle * r.dir + r.phase, rotorRot)
      Cesium.Matrix4.fromRotationTranslation(rotorRot, Cesium.Cartesian3.ZERO, rotorLocal)
      // 注意：必须整体赋值 node.matrix，改元素或原地写回都不会触发 Cesium 重算
      r.node.matrix = Cesium.Matrix4.multiply(r.base, rotorLocal, new Cesium.Matrix4())
    }
  }

  /** 移出场景（退出房间 / 玩家离开） */
  dispose(): void {
    if (this.model) {
      this.scene.viewer.scene.primitives.remove(this.model)
      this.model = null
    }
    if (this.label) {
      this.scene.viewer.entities.remove(this.label)
      this.label = null
    }
    this.buffer.length = 0
  }
}

export class RemoteDrones {
  private scene: CesiumScene
  private drones = new Map<string, RemoteDrone>()
  /** 本机玩家 id：名单里剔除自己，否则会给自己造一个停在场景原点的「幽灵机体」 */
  private selfId: string

  constructor(scene: CesiumScene, selfId: string) {
    this.scene = scene
    this.selfId = selfId
  }

  /** 花名册对齐：进入 / 重连后整表重建（新增建、离开删、元数据更新）。自己被排除 */
  syncRoster(players: MpPlayer[]): void {
    const now = performance.now()
    const seen = new Set(players.map((p) => p.id))
    for (const p of players) {
      if (p.id === this.selfId) continue
      const d = this.drones.get(p.id)
      if (d) d.updateMeta(p)
      else {
        const drone = new RemoteDrone(this.scene, p)
        this.drones.set(p.id, drone)
        // 没有快照的玩家渲染不出位置：render() 返回 false，等第一帧快照到位
        drone.render(now, 0)
      }
    }
    for (const [id, d] of this.drones) {
      if (!seen.has(id)) {
        d.dispose()
        this.drones.delete(id)
      }
    }
  }

  playerJoined(player: MpPlayer): void {
    if (player.id === this.selfId) return
    const existing = this.drones.get(player.id)
    if (existing) {
      existing.updateMeta(player)
      return
    }
    const drone = new RemoteDrone(this.scene, player)
    this.drones.set(player.id, drone)
    drone.render(performance.now(), 0)
  }

  playerLeft(id: string): void {
    this.drones.get(id)?.dispose()
    this.drones.delete(id)
  }

  applySnapshot(id: string, snap: Snapshot): void {
    if (id === this.selfId) return
    this.drones.get(id)?.apply(snap, performance.now())
  }

  /** 每帧推进全部远端机体（sim.tick 里调用） */
  render(dt: number): void {
    const now = performance.now()
    for (const d of this.drones.values()) d.render(now, dt)
  }

  disposeAll(): void {
    for (const d of this.drones.values()) d.dispose()
    this.drones.clear()
  }

  get count(): number {
    return this.drones.size
  }
}
