// 建筑碰撞世界：把 OSM 轮廓转到场景局部米制坐标（x=东、y=上、z=南），
// 提供「机体球体 vs 楼体棱柱 / 楼顶平面」的刚体碰撞解算。
//
// 只做一次空间索引（均匀网格），每帧只检查机体所在的少数几栋楼。
// 解算直接写回刚体的 position / velocity —— 相当于给建筑与地面补上了
// 六自由度刚体缺失的「静态碰撞体」。
import type { DroneRigidBody } from './drone_physics.js'

export interface CollisionBuilding {
  name: string
  /** 轮廓环，扁平 [x0,z0,x1,z1,...]（局部米，闭合点已去掉） */
  ring: number[]
  minX: number
  maxX: number
  minZ: number
  maxZ: number
  /** 楼顶高度（米） */
  top: number
}

export interface CollisionHit {
  /** none=没碰到；bounce=低速擦碰（按刚体反弹）；crash=高速撞击（机体解体） */
  kind: 'none' | 'bounce' | 'crash'
  /** 撞到的对象名（楼名或「地面」） */
  target: string
  /** 沿法线的撞击速度（m/s） */
  impact: number
  normal: [number, number, number]
  /** 解算时推出的穿透深度（m） */
  depth: number
}

export interface CollisionOptions {
  /** 机体碰撞半径（米），随视觉缩放变化 */
  radius: number
  /** 楼顶停留时质心离顶面的高度（米） */
  roofRest: number
  /** 法向撞击速度超过该值即解体 */
  crashSpeed: number
  restitution: number
  friction: number
}

const NO_HIT: CollisionHit = {
  kind: 'none',
  target: '',
  impact: 0,
  normal: [0, 1, 0],
  depth: 0,
}

/** 射线法判断点是否在轮廓内 */
export function pointInRing(x: number, z: number, ring: number[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i]
    const zi = ring[i + 1]
    const xj = ring[j]
    const zj = ring[j + 1]
    if (zi > z !== zj > z) {
      const crossX = ((xj - xi) * (z - zi)) / (zj - zi) + xi
      if (x < crossX) inside = !inside
    }
  }
  return inside
}

/** 轮廓上离 (x,z) 最近的点 */
function nearestEdge(x: number, z: number, ring: number[]) {
  let bestD = Infinity
  let bx = 0
  let bz = 0
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const ax = ring[j]
    const az = ring[j + 1]
    const dx = ring[i] - ax
    const dz = ring[i + 1] - az
    const len2 = dx * dx + dz * dz
    let t = len2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const px = ax + dx * t
    const pz = az + dz * t
    const d = Math.hypot(x - px, z - pz)
    if (d < bestD) {
      bestD = d
      bx = px
      bz = pz
    }
  }
  return { dist: bestD, x: bx, z: bz }
}

export class CollisionWorld {
  readonly buildings: CollisionBuilding[] = []
  private cells = new Map<number, number[]>()
  private readonly cellSize = 100

  /** 加入一栋楼；ring 为局部米制轮廓（可含闭合重复点） */
  add(ring: number[], top: number, name = ''): void {
    const clean = closeRing(ring)
    if (clean.length < 6 || !(top > 0.5)) return
    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    for (let i = 0; i < clean.length; i += 2) {
      if (clean[i] < minX) minX = clean[i]
      if (clean[i] > maxX) maxX = clean[i]
      if (clean[i + 1] < minZ) minZ = clean[i + 1]
      if (clean[i + 1] > maxZ) maxZ = clean[i + 1]
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minZ)) return
    this.buildings.push({ name, ring: clean, minX, maxX, minZ, maxZ, top })
  }

  /** 清空全部碰撞体（切换起飞点时重建城市用） */
  clear(): void {
    this.buildings.length = 0
    this.cells.clear()
  }

  /** 建立均匀网格索引；返回楼栋数 */
  build(): number {
    this.cells.clear()
    const s = this.cellSize
    for (let i = 0; i < this.buildings.length; i++) {
      const b = this.buildings[i]
      const x0 = Math.floor(b.minX / s)
      const x1 = Math.floor(b.maxX / s)
      const z0 = Math.floor(b.minZ / s)
      const z1 = Math.floor(b.maxZ / s)
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          const key = cx * 100003 + cz
          const arr = this.cells.get(key)
          if (arr) arr.push(i)
          else this.cells.set(key, [i])
        }
      }
    }
    return this.buildings.length
  }

  /** 取可能相交的楼栋下标（含 1 格冗余，避免边界漏判） */
  query(x: number, z: number, r: number): number[] {
    if (this.cells.size === 0) return this.buildings.map((_, i) => i)
    const s = this.cellSize
    const out = new Set<number>()
    const x0 = Math.floor((x - r) / s)
    const x1 = Math.floor((x + r) / s)
    const z0 = Math.floor((z - r) / s)
    const z1 = Math.floor((z + r) / s)
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const arr = this.cells.get(cx * 100003 + cz)
        if (arr) for (const i of arr) out.add(i)
      }
    }
    return [...out]
  }
}

function closeRing(ring: number[]): number[] {
  if (ring.length < 6) return ring
  const n = ring.length
  if (ring[0] === ring[n - 2] && ring[1] === ring[n - 1]) return ring.slice(0, n - 2)
  return ring.slice()
}

interface Candidate {
  kind: 'bounce' | 'crash'
  target: string
  normal: [number, number, number]
  depth: number
}

/**
 * 解算一帧的建筑碰撞并写回刚体。
 * 只在机体球体与楼体相交时触发；楼顶按平台处理（可以降落）。
 * `from` 是上一帧位置：用于识别「一帧内穿透楼顶平面」的高速俯冲。
 */
export function resolveCollisions(
  body: DroneRigidBody,
  world: CollisionWorld,
  opt: CollisionOptions,
  from?: readonly number[],
): CollisionHit {
  if (world.buildings.length === 0) return NO_HIT
  const pos = body.position
  const v = body.velocity
  const r = opt.radius
  const prevY = from ? from[1] : pos[1]

  // 1) 楼顶平台：在轮廓内、质心低于「顶面 + 停留高度」→ 抬到顶面
  // 2) 楼体侧面：球心到轮廓边的水平距离 < 半径 → 沿法向推出
  let cand: Candidate | null = null
  const idx = world.query(pos[0], pos[2], r)

  for (const i of idx) {
    const b = world.buildings[i]
    if (pos[1] - opt.roofRest > b.top) continue // 整体在楼顶之上
    const inside = pointInRing(pos[0], pos[2], b.ring)

    if (inside) {
      // 楼顶：当前已在顶面附近，或上一帧还在楼顶之上（穿透判定）
      if (pos[1] >= b.top - 0.15 || prevY > b.top - 0.02) {
        // 已到顶面附近：按平台接触处理
        const pen = b.top + opt.roofRest - pos[1]
        if (pen > 0 && (!cand || pen > cand.depth)) {
          cand = { kind: 'bounce', target: b.name, normal: [0, 1, 0], depth: pen }
        }
        continue
      }
      // 深入楼体（高速穿墙）：沿最近轮廓边推出
      const e = nearestEdge(pos[0], pos[2], b.ring)
      const d = Math.max(e.dist, 1e-3)
      const n: [number, number, number] = [(e.x - pos[0]) / d, 0, (e.z - pos[2]) / d]
      const pen = e.dist + r
      if (!cand || pen > cand.depth) cand = { kind: 'bounce', target: b.name, normal: n, depth: pen }
      continue
    }

    const e = nearestEdge(pos[0], pos[2], b.ring)
    if (e.dist < r) {
      const d = Math.max(e.dist, 1e-3)
      const n: [number, number, number] = [(pos[0] - e.x) / d, 0, (pos[2] - e.z) / d]
      const pen = r - e.dist
      if (!cand || pen > cand.depth) cand = { kind: 'bounce', target: b.name, normal: n, depth: pen }
    }
  }

  if (!cand) return NO_HIT

  const n = cand.normal
  const vn = v[0] * n[0] + v[1] * n[1] + v[2] * n[2]
  const impact = Math.max(0, -vn)
  const crash = impact > opt.crashSpeed

  // 位置推出（沿法线）
  pos[0] += n[0] * cand.depth
  pos[1] += n[1] * cand.depth
  pos[2] += n[2] * cand.depth

  if (vn < 0) {
    // 法向反弹 + 切向摩擦：低速就是「撞墙弹开」，不会解体
    const bounce = crash ? 0.12 : opt.restitution
    const j = -(1 + bounce) * vn
    v[0] += j * n[0]
    v[1] += j * n[1]
    v[2] += j * n[2]
  }
  // 切向摩擦（只作用于水平分量）
  const k = crash ? 0.55 : opt.friction
  v[0] *= k
  v[2] *= k
  if (n[1] > 0.5) {
    // 落在楼顶：抑制滚转/俯仰，让机体停稳
    body.omega[0] *= 0.72
    body.omega[2] *= 0.72
    body.contact = true
  }

  return {
    kind: crash ? 'crash' : 'bounce',
    target: cand.target || '建筑',
    impact,
    normal: n,
    depth: cand.depth,
  }
}
