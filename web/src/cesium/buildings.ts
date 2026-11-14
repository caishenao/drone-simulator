// 建筑体块数据：从 OpenFreeMap 的 OSM 矢量瓦片（MVT）解析真实建筑轮廓与高度。
//
// 为什么不用本地 GeoJSON：起飞点可以由用户任意选（默认 IP 属地），
// 建筑必须能围绕任意坐标实时生成。矢量瓦片按需取图、带 LOD、免 key，
// 比 Overpass 稳定得多（Overpass 首次查询常要 30 s 以上，且频繁 502）。
//
// 瓦片里的 `render_height` 是 OpenMapTiles 预计算好的真实高度（米），
// 直接拿来拉伸即可，不需要自己按楼层数换算。

import { VectorTile } from '@mapbox/vector-tile'
import { PbfReader } from 'pbf'

/** 一块建筑：局部米制轮廓（x=东，z=南）+ 真实高度 */
export interface BuildingFootprint {
  /** 扁平环 [x0,z0,x1,z1,...]，已去掉闭合重复点 */
  ring: number[]
  /** 楼顶高度（米，相对地面） */
  height: number
  /** 楼底高度（米）；多数为 0，架空/裙房上的塔楼会大于 0 */
  minHeight: number
  name: string
  /** 瓦片里带的配色（很少见），没有就按高度分档 */
  colour?: string
}

export interface BuildingTileResult {
  list: BuildingFootprint[]
  /** 实际请求的瓦片数 */
  tiles: number
  /** 瓦片服务地址（调试用） */
  source: string
}

const TILEJSON = 'https://tiles.openfreemap.org/planet'
/** 建筑轮廓用 14 级：单块约 2.4 km，正好覆盖飞行范围；15 级目前返回空瓦片 */
const TILE_Z = 14
const EARTH_M_PER_DEG_LAT = 110_540
const EARTH_M_PER_DEG_LON = 111_320

let tileTemplate: string | null = null
let tileTemplateAt = 0
/** tilejson 的日期化路径在 6 小时内稳定，持久化后刷新页面不必再等一次解析 */
const TPL_CACHE_KEY = 'drone.buildings.tile-template.v1'
const TPL_TTL_MS = 6 * 3600_000

function readCachedTemplate(): string | null {
  try {
    const raw = localStorage.getItem(TPL_CACHE_KEY)
    if (!raw) return null
    const { tpl, at } = JSON.parse(raw) as { tpl?: unknown; at?: unknown }
    if (typeof tpl !== 'string' || !tpl.includes('{z}')) return null
    if (typeof at !== 'number' || Date.now() - at > TPL_TTL_MS) return null
    return tpl
  } catch {
    // 隐私模式 / 存储被禁用时直接走网络
    return null
  }
}

function writeCachedTemplate(tpl: string): void {
  try {
    localStorage.setItem(TPL_CACHE_KEY, JSON.stringify({ tpl, at: Date.now() }))
  } catch {
    // 存不下就算了，内存里的 tileTemplate 仍然有效
  }
}

/** 取瓦片模板：tilejson 里有带日期前缀的真实路径，写死会随数据更新失效 */
async function resolveTileTemplate(): Promise<string> {
  const now = Date.now()
  if (tileTemplate && now - tileTemplateAt < TPL_TTL_MS) return tileTemplate

  const cached = readCachedTemplate()
  if (cached) {
    tileTemplate = cached
    tileTemplateAt = now
    return cached
  }

  // 重试 3 次：tilejson 偶尔要 15 s+，单次失败就退到「无日期」路径，
  // 而那个路径返回 HTTP 200、0 字节 —— 建筑会安静地变成 0 栋，没有任何报错
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // 公网 tilejson 在部分网络下要 15 s+，只等 6 s 会退到「无日期」路径 —— 那个地址返回 200 却是 0 字节
      const res = await fetch(TILEJSON, { signal: AbortSignal.timeout(20_000) })
      const j = (await res.json()) as { tiles?: string[] }
      const t = j.tiles?.[0]
      if (t && t.includes('{z}')) {
        tileTemplate = t
        tileTemplateAt = now
        writeCachedTemplate(t)
        return t
      }
    } catch {
      // 网络不通或超时，换下一次重试
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)))
  }
  tileTemplate = `https://tiles.openfreemap.org/planet/{z}/{x}/{y}.pbf`
  tileTemplateAt = now
  return tileTemplate
}

function lonToTileX(lon: number, n: number): number {
  return ((lon + 180) / 360) * n
}

function latToTileY(lat: number, n: number): number {
  const r = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n
}

/** 瓦片内像素坐标 → 经纬度（Web Mercator） */
function tileToLonLat(tx: number, ty: number, px: number, py: number, extent: number, n: number): [number, number] {
  const wx = (tx + px / extent) / n
  const wy = (ty + py / extent) / n
  const lon = wx * 360 - 180
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * wy))) * 180) / Math.PI
  return [lon, lat]
}

/** 鞋带公式求面积（局部米制，绝对值为平方米） */
function ringArea(ring: number[]): number {
  let a = 0
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    a += ring[j] * ring[i + 1] - ring[i] * ring[j + 1]
  }
  return Math.abs(a) / 2
}

/** 去掉闭合重复点，返回扁平数组 */
function dedupeRing(pts: { x: number; y: number }[]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = []
  for (const p of pts) {
    const last = out[out.length - 1]
    // 瓦片精度是 1/4096，相邻点常常只差一两个单位；挤在一起会在三角剖分时退化成零面积
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1.6) out.push(p)
  }
  if (out.length > 1) {
    const a = out[0]
    const b = out[out.length - 1]
    if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-9) out.pop()
  }
  return out
}

/**
 * 拉取以 (lon, lat) 为圆心、半径 radiusM 内的建筑。
 * 半径不要超过 1500 m：再大瓦片数会成倍增长，且远景建筑本来就看不见。
 */
export async function fetchBuildings(
  lon: number,
  lat: number,
  radiusM = 950,
): Promise<BuildingTileResult> {
  const template = await resolveTileTemplate()
  const n = 2 ** TILE_Z
  const cosLat = Math.cos((lat * Math.PI) / 180)
  const dLat = radiusM / EARTH_M_PER_DEG_LAT
  const dLon = radiusM / (EARTH_M_PER_DEG_LON * Math.max(0.2, cosLat))

  const x0 = Math.floor(lonToTileX(lon - dLon, n))
  const x1 = Math.floor(lonToTileX(lon + dLon, n))
  const y0 = Math.floor(latToTileY(lat + dLat, n))
  const y1 = Math.floor(latToTileY(lat - dLat, n))

  const coords: [number, number][] = []
  for (let tx = x0; tx <= x1; tx++) {
    for (let ty = y0; ty <= y1; ty++) coords.push([tx, ty])
  }
  // 极端情况（高纬度或大半径）限制在 9 块，避免一次拉太多
  const picked = coords.slice(0, 9)

  const list: BuildingFootprint[] = []
  let okTiles = 0

  await Promise.all(
    picked.map(async ([tx, ty]) => {
      const url = template
        .replace('{z}', String(TILE_Z))
        .replace('{x}', String(tx))
        .replace('{y}', String(ty))
      let buf: Uint8Array | null = null
      // 单块瓦片失败要重试：公网偶发超时/空响应，直接丢掉会让建筑凭空少一片，
      // 极端情况下整片区域变成 0 栋，看起来像「没有建筑」而不是「网络失败」
      for (let attempt = 0; attempt < 3 && !buf; attempt++) {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(9000) })
          if (!res.ok) continue
          const b = new Uint8Array(await res.arrayBuffer())
          if (b.byteLength) buf = b
        } catch {
          // 超时或网络错误，换下一次重试
        }
        if (!buf && attempt < 2) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
      }
      if (!buf) return
      okTiles++

      let tile: VectorTile
      try {
        tile = new VectorTile(new PbfReader(buf))
      } catch {
        return
      }
      const layer = tile.layers.building
      if (!layer) return
      const extent = layer.extent || 4096

      for (let i = 0; i < layer.length; i++) {
        const f = layer.feature(i)
        if (f.type !== 3) continue
        const props = f.properties as Record<string, unknown>
        if (props.hide_3d === true) continue

        const rawGeom = f.loadGeometry()
        if (!rawGeom.length) continue
        // 多环时取面积最大的外环（内院、裙房碎片都丢掉）
        let best: { x: number; y: number }[] = []
        let bestArea = 0
        for (const part of rawGeom) {
          const clean = dedupeRing(part)
          if (clean.length < 3) continue
          let a = 0
          for (let k = 0, m = clean.length - 1; k < clean.length; m = k, k++) {
            a += clean[m].x * clean[k].y - clean[k].x * clean[m].y
          }
          if (Math.abs(a) > bestArea) {
            bestArea = Math.abs(a)
            best = clean
          }
        }
        if (best.length < 3) continue

        // 转局部米制（x=东，z=南）
        const ring: number[] = []
        for (const p of best) {
          const [plon, plat] = tileToLonLat(tx, ty, p.x, p.y, extent, n)
          const mx = (plon - lon) * EARTH_M_PER_DEG_LON * cosLat
          const mz = -(plat - lat) * EARTH_M_PER_DEG_LAT
          ring.push(mx, mz)
        }
        const area = ringArea(ring)
        if (area < 12 || area > 400_000) continue
        // 细长/退化轮廓会算出 NaN 包围球，进而让 Cesium 的可见性剔除数组长度变成 NaN
        let minX = Infinity
        let maxX = -Infinity
        let minZ = Infinity
        let maxZ = -Infinity
        for (let k = 0; k < ring.length; k += 2) {
          if (ring[k] < minX) minX = ring[k]
          if (ring[k] > maxX) maxX = ring[k]
          if (ring[k + 1] < minZ) minZ = ring[k + 1]
          if (ring[k + 1] > maxZ) maxZ = ring[k + 1]
        }
        if (!(maxX - minX > 1) || !(maxZ - minZ > 1)) continue

        // 高度：render_height 已是米；缺失时按类型给个保守值
        const kind = String(props.building ?? 'yes')
        let height = Number(props.render_height)
        if (!Number.isFinite(height) || height <= 0) {
          height = kind === 'apartments' || kind === 'residential' ? 21 : 9
        }
        if (height > 640) height = 640
        if (height < 2.2) continue
        const minHeight = Math.max(0, Number(props.render_min_height) || 0)

        list.push({
          ring,
          height,
          minHeight: Math.min(minHeight, height - 1),
          name: String(props['name:zh'] ?? props.name ?? ''),
          colour: typeof props.colour === 'string' ? props.colour : undefined,
        })
      }
    }),
  )

  return { list, tiles: okTiles, source: template }
}
