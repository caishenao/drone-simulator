// 从 OpenStreetMap Overpass 抓取北京国贸一带的建筑轮廓与高度，输出 GeoJSON。
// 只在需要刷新数据时手动执行：npm run buildings
// 结果落到 public/data/buildings.geojson，页面运行时不再依赖外网。
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

// 范围：国贸 CBD（含中国尊、国贸三期、央视方向）
const BBOX = { south: 39.9025, west: 116.4495, north: 39.9155, east: 116.4735 }
const ENDPOINTS = [
  'https://z.overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
]

const query = `[out:json][timeout:120];
way["building"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
out geom;`

function parseHeight(tags) {
  const num = (v) => {
    if (v == null) return NaN
    const m = String(v).replace(',', '.').match(/-?\d+(\.\d+)?/)
    return m ? Number(m[0]) : NaN
  }
  const h = num(tags.height)
  if (Number.isFinite(h) && h > 2) return h
  const levels = num(tags['building:levels'])
  if (Number.isFinite(levels) && levels >= 1) return levels * 3.3 + 2
  return null
}

const DEFAULT_HEIGHT = { house: 7, garage: 4, garage_boxes: 4, shed: 3.5, roof: 4, hut: 3 }

async function fetchOverpass() {
  let lastErr
  for (const url of ENDPOINTS) {
    const t0 = Date.now()
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'drone-cesium-demo/1.0 (3d asset demo)',
        },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(150_000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      console.log(`[buildings] ${new URL(url).host} 返回 ${json.elements?.length ?? 0} 条，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
      return json
    } catch (err) {
      lastErr = err
      console.warn(`[buildings] ${new URL(url).host} 失败：${err.message}`)
    }
  }
  throw lastErr
}

const data = await fetchOverpass()
const features = []
let withHeight = 0
let withLevels = 0

for (const el of data.elements ?? []) {
  const geom = el.geometry
  if (!Array.isArray(geom) || geom.length < 4) continue
  // Overpass 的 way 首尾点重复，转 GeoJSON 时去掉闭合点（Cesium 会自动闭合）
  const ring = geom.map((p) => [Number(p.lon.toFixed(7)), Number(p.lat.toFixed(7))])
  const first = ring[0]
  const last = ring[ring.length - 1]
  if (first[0] === last[0] && first[1] === last[1]) ring.pop()
  if (ring.length < 3) continue

  const tags = el.tags ?? {}
  const h = parseHeight(tags)
  if (tags.height) withHeight++
  else if (tags['building:levels']) withLevels++
  const height = h ?? DEFAULT_HEIGHT[tags.building] ?? 12

  features.push({
    type: 'Feature',
    id: `way/${el.id}`,
    properties: {
      name: tags.name ?? '',
      height: Number(height.toFixed(1)),
      levels: tags['building:levels'] ? Number(tags['building:levels']) : null,
      kind: tags.building ?? 'yes',
      source: 'OpenStreetMap',
    },
    geometry: { type: 'Polygon', coordinates: [ring] },
  })
}

features.sort((a, b) => b.properties.height - a.properties.height)

const out = {
  type: 'FeatureCollection',
  name: 'Beijing CBD buildings (OSM)',
  crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
  metadata: {
    source: 'OpenStreetMap / Overpass API',
    license: 'ODbL 1.0 © OpenStreetMap contributors',
    bbox: [BBOX.west, BBOX.south, BBOX.east, BBOX.north],
    fetchedAt: new Date().toISOString(),
    features: features.length,
    withHeightTag: withHeight,
    withLevelsTag: withLevels,
  },
  features,
}

const dst = join(root, 'public', 'data', 'buildings.geojson')
mkdirSync(dirname(dst), { recursive: true })
writeFileSync(dst, JSON.stringify(out), 'utf8')

const heights = features.map((f) => f.properties.height)
console.log(
  `[buildings] 写入 ${features.length} 栋 -> public/data/buildings.geojson ` +
    `(height 标签 ${withHeight} / levels 标签 ${withLevels}，最高 ${Math.max(...heights).toFixed(0)} m)`,
)
