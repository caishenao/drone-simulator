// 多人快照：类型定义、量化编码与远端插值。
// 协议契约见 docs/multiplayer-plan.md 第 6 节——字段缩写压带宽，
// 数值保留 2~3 位小数（20Hz 下丢失的精度肉眼不可见）。

export interface Snapshot {
  /** 房间 ENU 位置（米，x 东 y 上 z 南） */
  p: [number, number, number]
  /** 经纬度/海拔（度 / 度 / 米），调试与跨原点扩展用 */
  g: [number, number, number]
  /** 姿态四元数（机体系 → ENU） */
  q: [number, number, number, number]
  /** ENU 速度（外推用） */
  v: [number, number, number]
  /** 云台俯仰 / 偏航（度） */
  gp: number
  gy: number
  /** 平均旋翼转速 rpm（带符号：负 = 反桨倒飞） */
  r: number
  /** 撞毁标记 */
  c: 0 | 1
  /** 发送方仿真时刻（秒），只用于调试排序，插值不依赖它 */
  t: number
  /** 机型 id */
  d: string
  /** 油门 */
  th: number
}

export interface MpPlayer {
  id: string
  name: string
  color: string
  droneTypeId: string
  crashed: boolean
  joinedAt: number
}

export interface MpChatMsg {
  id: string
  name: string
  color: string
  text: string
  ts: number
}

const round = (v: number, digits: number) => {
  const k = 10 ** digits
  return Math.round(v * k) / k
}

/**
 * 从物理层状态组一个快照。
 * lon/lat 换算与 pushTelemetry 的公式一致：经度除以 cos 纬度的米数、纬度除以固定米数。
 */
export function buildSnapshot(args: {
  position: readonly number[]
  quaternion: readonly number[]
  velocity: readonly number[]
  originLon: number
  originLat: number
  originElevation: number
  gimbalPitch: number
  gimbalYaw: number
  rpmSigned: number
  crashed: boolean
  time: number
  droneTypeId: string
  throttle: number
}): Snapshot {
  const [x, y, z] = args.position
  const lon = args.originLon + x / (111320 * Math.cos((args.originLat * Math.PI) / 180))
  const lat = args.originLat - z / 110540
  return {
    p: [round(x, 2), round(y, 2), round(z, 2)],
    g: [round(lon, 6), round(lat, 6), round(args.originElevation + y, 1)],
    q: [
      round(args.quaternion[0], 4),
      round(args.quaternion[1], 4),
      round(args.quaternion[2], 4),
      round(args.quaternion[3], 4),
    ],
    v: [
      round(args.velocity[0], 2),
      round(args.velocity[1], 2),
      round(args.velocity[2], 2),
    ],
    gp: round(args.gimbalPitch, 1),
    gy: round(args.gimbalYaw, 1),
    r: round(args.rpmSigned, 0),
    c: args.crashed ? 1 : 0,
    t: round(args.time, 2),
    d: args.droneTypeId,
    th: round(args.throttle, 2),
  }
}

// ————————————————————————————————————————————
// 快照消毒：快照是任意客户端构造的 JSON（第三方客户端 / 机器人），
// 字符串坐标、NaN、缺字段都不能直接进插值与渲染管线（NaN 会让 Cesium 剔除崩掉）。
// ————————————————————————————————————————————

const num = (v: unknown, fallback = 0): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** 把任意来源的快照载荷规范化成纯数字 Snapshot（字段缺失/非法取 0） */
export function sanitizeSnapshot(raw: unknown): Snapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const vec3 = (v: unknown): [number, number, number] => {
    const a = Array.isArray(v) ? v : []
    return [num(a[0]), num(a[1]), num(a[2])]
  }
  const q = Array.isArray(r.q) ? r.q : []
  const quat: [number, number, number, number] = [
    num(q[0]),
    num(q[1]),
    num(q[2]),
    num(q[3], 1),
  ]
  const n = Math.hypot(quat[0], quat[1], quat[2], quat[3])
  if (n < 1e-6) {
    // 全零四元数是无效姿态：退回单位四元数，别让渲染端收到奇异矩阵
    quat[0] = 0
    quat[1] = 0
    quat[2] = 0
    quat[3] = 1
  } else {
    quat[0] /= n
    quat[1] /= n
    quat[2] /= n
    quat[3] /= n
  }
  return {
    p: vec3(r.p),
    g: vec3(r.g),
    q: quat,
    v: vec3(r.v),
    gp: num(r.gp, -12),
    gy: num(r.gy, 0),
    r: num(r.r, 0),
    c: num(r.c) === 1 ? 1 : 0,
    t: num(r.t, 0),
    d: String(r.d ?? 'mini3pro').slice(0, 32) || 'mini3pro',
    th: Math.min(1, Math.max(-1, num(r.th, 0))),
  }
}

// ————————————————————————————————————————————
// 远端插值：渲染永远落在「现在 - 缓冲」处，在相邻两帧快照间插值。
// 时间戳用接收方本地单调时钟（快照到达时刻），不做全网时钟同步。
// ————————————————————————————————————————————

/** 插值缓冲（ms）：20Hz 快照间隔 50ms，120ms 约覆盖 2~3 帧，抖动余量充足 */
export const INTERP_DELAY_MS = 120
/** 缓冲耗尽时允许的线性外推上限（ms），再往后冻结（标记「信号弱」交给 UI） */
export const MAX_EXTRAPOLATE_MS = 200

export function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k
}

export function lerp3(
  a: readonly number[],
  b: readonly number[],
  k: number,
  out: number[],
): void {
  out[0] = lerp(a[0], b[0], k)
  out[1] = lerp(a[1], b[1], k)
  out[2] = lerp(a[2], b[2], k)
}

/** 四元数 slerp：相邻快照角度差小，走标准最短路径分支即可 */
export function slerpQuat(
  a: readonly number[],
  b: readonly number[],
  k: number,
  out: number[],
): void {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
  // 点积为负取另一条最短路径
  let b0 = b[0]
  let b1 = b[1]
  let b2 = b[2]
  let b3 = b[3]
  if (dot < 0) {
    dot = -dot
    b0 = -b0
    b1 = -b1
    b2 = -b2
    b3 = -b3
  }
  if (dot > 0.9995) {
    // 几乎共线：nlerp 的误差低于快照量化噪声
    out[0] = lerp(a[0], b0, k)
    out[1] = lerp(a[1], b1, k)
    out[2] = lerp(a[2], b2, k)
    out[3] = lerp(a[3], b3, k)
  } else {
    const theta = Math.acos(Math.min(1, dot))
    const s = Math.sin(theta)
    const wa = Math.sin((1 - k) * theta) / s
    const wb = Math.sin(k * theta) / s
    out[0] = a[0] * wa + b0 * wb
    out[1] = a[1] * wa + b1 * wb
    out[2] = a[2] * wa + b2 * wb
    out[3] = a[3] * wa + b3 * wb
  }
  const n = Math.hypot(out[0], out[1], out[2], out[3]) || 1
  out[0] /= n
  out[1] /= n
  out[2] /= n
  out[3] /= n
}

/** 缓冲中的一帧：本地接收时刻 + 快照 */
export interface TimedSnap {
  recvAt: number
  snap: Snapshot
}

/**
 * 在插值缓冲上取「renderAt 时刻」的位姿。
 * out 依次写入 pos[3] / quat[4] / vel[3]（外推时才填充）/ rpm / gimbalPitch / gimbalYaw / crashed / droneTypeId。
 * 返回值：0 = 区间内插值，1 = 末端外推，2 = 冻结（缓冲为空或外推超限）。
 */
export function sampleBuffer(
  buf: TimedSnap[],
  renderAt: number,
  out: {
    pos: number[]
    quat: number[]
    vel: number[]
    rpm: number
    gimbalPitch: number
    gimbalYaw: number
    crashed: boolean
    droneTypeId: string
  },
): 0 | 1 | 2 {
  if (buf.length === 0) return 2
  if (buf.length === 1) {
    const s = buf[0].snap
    lerp3(s.p, s.p, 0, out.pos)
    out.quat[0] = s.q[0]
    out.quat[1] = s.q[1]
    out.quat[2] = s.q[2]
    out.quat[3] = s.q[3]
    out.rpm = s.r
    out.gimbalPitch = s.gp
    out.gimbalYaw = s.gy
    out.crashed = s.c === 1
    out.droneTypeId = s.d
    return 2
  }
  const last = buf[buf.length - 1]
  const prev = buf[buf.length - 2]
  if (renderAt >= last.recvAt) {
    // 末端外推：p + v·dt，最多 MAX_EXTRAPOLATE_MS，再远就冻结在最后位置
    const dtSec = Math.min(MAX_EXTRAPOLATE_MS, renderAt - last.recvAt) / 1000
    out.pos[0] = last.snap.p[0] + last.snap.v[0] * dtSec
    out.pos[1] = last.snap.p[1] + last.snap.v[1] * dtSec
    out.pos[2] = last.snap.p[2] + last.snap.v[2] * dtSec
    out.quat[0] = last.snap.q[0]
    out.quat[1] = last.snap.q[1]
    out.quat[2] = last.snap.q[2]
    out.quat[3] = last.snap.q[3]
    out.rpm = last.snap.r
    out.gimbalPitch = last.snap.gp
    out.gimbalYaw = last.snap.gy
    out.crashed = last.snap.c === 1
    out.droneTypeId = last.snap.d
    return renderAt - last.recvAt > MAX_EXTRAPOLATE_MS ? 2 : 1
  }
  // 找到 renderAt 落入的相邻对（从尾向前扫：通常就落在最后两帧之间）
  let a = prev
  let b = last
  for (let i = buf.length - 2; i > 0; i--) {
    if (buf[i - 1].recvAt <= renderAt) {
      a = buf[i - 1]
      b = buf[i]
      break
    }
  }
  const span = Math.max(1, b.recvAt - a.recvAt)
  const k = Math.min(1, Math.max(0, (renderAt - a.recvAt) / span))
  lerp3(a.snap.p, b.snap.p, k, out.pos)
  slerpQuat(a.snap.q, b.snap.q, k, out.quat)
  lerp3(a.snap.v, b.snap.v, k, out.vel)
  out.rpm = lerp(a.snap.r, b.snap.r, k)
  out.gimbalPitch = lerp(a.snap.gp, b.snap.gp, k)
  out.gimbalYaw = lerp(a.snap.gy, b.snap.gy, k)
  // 撞毁与机型取较新一帧（离散状态不做插值）
  out.crashed = (k > 0.5 ? b.snap : a.snap).c === 1
  out.droneTypeId = b.snap.d
  return 0
}
