// 地形高度场：把 Cesium 的真实高程缓存成局部米制网格，供物理层做「撞山」判定。
//
// 为什么需要它
//   物理层的地面判定原本是常数平面（environment.ground_y_m = 0）。
//   地形渲染出来有起伏，机体却照样穿山而过 —— 视觉上飞机埋进山体，物理上毫无反应。
//   要判「撞山」，就必须有一份随水平位置变化的地形高度。
//
// 两条取数路径，配合使用
//   1) globe.getHeight()：同步、与画面上看到的地形完全一致（同一套瓦片插值）。
//      缺点是瓦片没加载到该点时返回 undefined。
//   2) 本类的高度场：异步预取（sampleTerrainMostDetailed 批量），
//      保证即使瓦片还没加载，也知道地形大致走向，不会把山谷误判成 y=0 的平面。
//   查询时优先 (1)，落空退 (2)，再落空退到最近的有效格点。
//
// 坐标约定：局部 x = 东、y = 上、z = 南，与场景其余部分一致。
// 高度一律是「相对场景原点地表」的米制偏移，可直接当局部 y 用。

/** 每度纬度约 111.32 km */
const M_PER_DEG = 111320

export interface TerrainFieldOptions {
  /** 网格半边长（米）。决定碰撞判定能覆盖多远的地形 */
  half?: number
  /** 格距（米）。越小越精细，采样点也越多（点数 = (2*half/cell + 1)²） */
  cell?: number
}

export interface TerrainPoint {
  lon: number
  lat: number
  /** 椭球高程（米） */
  height: number
}

/** 局部米制坐标 → 经纬度（局部平面近似；数百米范围内相对误差 < 0.1%） */
export function localToLonLat(
  lon0: number,
  lat0: number,
  x: number,
  z: number,
): { lon: number; lat: number } {
  const lat = lat0 - z / M_PER_DEG // z 轴指向南
  const lon = lon0 + x / (M_PER_DEG * Math.cos((lat0 * Math.PI) / 180))
  return { lon, lat }
}

export class TerrainField {
  private readonly half: number
  private readonly cell: number
  /** 每边格点数（奇数，中心格在 0,0） */
  private readonly n: number
  /** 生效中的高度场 */
  private heights: Float32Array
  private valid: Uint8Array
  /** 生效数据对应的局部中心（格点索引 → 局部坐标的换算基准） */
  private dataCx = 0
  private dataCz = 0
  /** 采样写入缓冲：双缓冲，保证采样期间旧数据仍可用 */
  private nextHeights: Float32Array
  private nextValid: Uint8Array
  /** 采样目标中心 */
  private cx = 0
  private cz = 0
  /** 采样代数：每次重采样 +1，迟到的旧结果直接丢弃 */
  private gen = 0
  private sampling = false

  constructor(opt: TerrainFieldOptions = {}) {
    this.half = opt.half ?? 600
    this.cell = opt.cell ?? 30
    this.n = Math.round((this.half * 2) / this.cell) + 1
    this.heights = new Float32Array(this.n * this.n)
    this.valid = new Uint8Array(this.n * this.n)
    this.nextHeights = new Float32Array(this.n * this.n)
    this.nextValid = new Uint8Array(this.n * this.n)
  }

  /** 网格是否已有可用数据 */
  get ready(): boolean {
    return this.countValid() > 0
  }

  /** 采样进行中（用于避免重复触发） */
  get busy(): boolean {
    return this.sampling
  }

  /** 已覆盖的中心区域半径（米） */
  get coverage(): number {
    return this.half
  }

  /**
   * 把采样目标对准到新的局部中心。
   * 不清空现有数据 —— 采样期间旧数据仍然有效（双缓冲，采样完成后才整体切换）。
   */
  recenter(x: number, z: number): void {
    this.cx = x
    this.cz = z
  }

  /** 当前采样目标中心（局部坐标） */
  get center(): { x: number; z: number } {
    return { x: this.cx, z: this.cz }
  }

  /**
   * 采样整个网格。provider 为 Cesium 地形提供者。
   * 返回是否成功写入数据。
   *
   * 为什么用固定 13 级而不是 mostDetailed：
   *   mostDetailed 会为每个点一路细分到最细瓦片，1600+ 个点会触发成百上千个请求，
   *   实测把场景初始化卡住几十秒。固定 13 级（瓦片覆盖约 4.9 km）只要 1~2 个请求，
   *   高程格网约 19 m —— 对「撞山」判定足够，且快两个数量级。
   */
  async sample(
    provider: unknown,
    lon0: number,
    lat0: number,
    originBase: number,
  ): Promise<boolean> {
    const gen = ++this.gen
    this.sampling = true
    const tx = this.cx
    const tz = this.cz
    try {
      const Cesium = window.Cesium
      const cartos: InstanceType<typeof Cesium.Cartographic>[] = []
      for (let j = 0; j < this.n; j++) {
        for (let i = 0; i < this.n; i++) {
          const x = tx - this.half + i * this.cell
          const z = tz - this.half + j * this.cell
          const ll = localToLonLat(lon0, lat0, x, z)
          cartos.push(Cesium.Cartographic.fromDegrees(ll.lon, ll.lat))
        }
      }
      const results = await Cesium.sampleTerrain(provider as never, 13, cartos as never)
      // 采样期间网格可能又移动过：这次结果已过期，丢弃
      if (gen !== this.gen) return false
      const values = new Float32Array(this.n * this.n)
      let ok = 0
      for (let i = 0; i < results.length; i++) {
        const h = results[i]?.height
        if (typeof h === 'number' && Number.isFinite(h)) {
          values[i] = h
          ok++
        }
      }
      if (ok < this.n * this.n * 0.5) {
        // 一半以上没数据：这个级别在本地不可用，退到最细级别再试一次
        const fine = await Cesium.sampleTerrainMostDetailed(provider as never, cartos as never)
        if (gen !== this.gen) return false
        for (let i = 0; i < fine.length; i++) {
          const h = fine[i]?.height
          if (typeof h === 'number' && Number.isFinite(h)) values[i] = h
        }
      }
      // 写进缓冲，确认有数据后才整体切换（双缓冲）
      this.nextValid.fill(0)
      let k = 0
      for (let j = 0; j < this.n; j++) {
        for (let i = 0; i < this.n; i++, k++) {
          const v = values[k]
          if (!Number.isFinite(v)) continue
          this.nextHeights[k] = v - originBase
          this.nextValid[k] = 1
        }
      }
      if (this.countValidIn(this.nextValid) === 0) return false
      const oldH = this.heights
      const oldV = this.valid
      this.heights = this.nextHeights
      this.valid = this.nextValid
      this.nextHeights = oldH
      this.nextValid = oldV
      this.dataCx = tx
      this.dataCz = tz
      return true
    } catch {
      return false
    } finally {
      if (gen === this.gen) this.sampling = false
    }
  }

  /**
   * 取某点的地形高度（相对原点地表，米）。
   * 网格外返回最近的有效格点值；完全没有数据时返回 0。
   */
  heightAt(x: number, z: number): number {
    const fx = (x - this.dataCx + this.half) / this.cell
    const fz = (z - this.dataCz + this.half) / this.cell
    if (fx < 0 || fz < 0 || fx > this.n - 1 || fz > this.n - 1) {
      const near = this.nearestValid(x, z)
      return near === null ? 0 : near
    }
    const i0 = Math.floor(fx)
    const j0 = Math.floor(fz)
    const i1 = Math.min(i0 + 1, this.n - 1)
    const j1 = Math.min(j0 + 1, this.n - 1)
    const tx = fx - i0
    const tz = fz - j0
    const h00 = this.pick(i0, j0)
    const h10 = this.pick(i1, j0)
    const h01 = this.pick(i0, j1)
    const h11 = this.pick(i1, j1)
    if (h00 === null && h10 === null && h01 === null && h11 === null) {
      const near = this.nearestValid(x, z)
      return near === null ? 0 : near
    }
    const a = h00 ?? h10 ?? h01 ?? h11 ?? 0
    const b = h10 ?? a
    const c = h01 ?? a
    const d = h11 ?? a
    const top = a + (b - a) * tx
    const bot = c + (d - c) * tx
    return top + (bot - top) * tz
  }

  /**
   * 地表法向（单位向量，y 分量为正，指向地表外侧）。
   * 由高度场中心差分求得。
   */
  normalAt(x: number, z: number): [number, number, number] {
    const d = this.cell
    const dhdx = (this.heightAt(x + d, z) - this.heightAt(x - d, z)) / (2 * d)
    const dhdz = (this.heightAt(x, z + d) - this.heightAt(x, z - d)) / (2 * d)
    const nx = -dhdx
    const ny = 1
    const nz = -dhdz
    const len = Math.hypot(nx, ny, nz) || 1
    return [nx / len, ny / len, nz / len]
  }

  /** 网格有效点数量 */
  countValid(): number {
    return this.countValidIn(this.valid)
  }

  private countValidIn(v: Uint8Array): number {
    let c = 0
    for (let i = 0; i < v.length; i++) if (v[i]) c++
    return c
  }

  /** 取格点值；无效则尝试相邻格点 */
  private pick(i: number, j: number): number | null {
    const k = j * this.n + i
    if (this.valid[k]) return this.heights[k]
    // 邻域回退：某一格缺失时用最近的可用格，避免插值出现黑洞
    for (const [di, dj] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [-1, -1],
      [1, -1],
      [-1, 1],
    ]) {
      const ii = i + di
      const jj = j + dj
      if (ii < 0 || jj < 0 || ii >= this.n || jj >= this.n) continue
      const kk = jj * this.n + ii
      if (this.valid[kk]) return this.heights[kk]
    }
    return null
  }

  /** 找离 (x,z) 最近的有效格点 */
  private nearestValid(x: number, z: number): number | null {
    let best = Infinity
    let val: number | null = null
    for (let j = 0; j < this.n; j++) {
      for (let i = 0; i < this.n; i++) {
        const k = j * this.n + i
        if (!this.valid[k]) continue
        const gx = this.dataCx - this.half + i * this.cell
        const gz = this.dataCz - this.half + j * this.cell
        const d = (gx - x) * (gx - x) + (gz - z) * (gz - z)
        if (d < best) {
          best = d
          val = this.heights[k]
        }
      }
    }
    return val
  }
}
