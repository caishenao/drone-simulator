// 起飞点定位：IP 属地 / 浏览器定位 / 地名搜索 / 逆地理编码。
//
// 默认起飞点 = 用户 IP 所在地。IP 归属依赖出口 IP，挂代理时可能落到机房所在地，
// 所以每个结果都带 source，UI 上明确标注来源，并允许用户随时改。

export interface Place {
  lon: number
  lat: number
  name: string
  /** 定位来源：ip=IP 属地，gps=浏览器定位，search=地名搜索，manual=手动坐标/地图点选，preset=内置城市 */
  source: 'ip' | 'gps' | 'search' | 'manual' | 'preset'
  /** 省 / 国家等次级描述 */
  detail?: string
  /** 地点类型（城市 / 山峰 / 湖泊…），搜索结果用来区分同名地点 */
  kind?: string
}

/** 内置城市：搜索服务不可用时的兜底，也方便快速切换 */
export const PRESET_CITIES: Place[] = [
  { name: '北京 · 国贸', lon: 116.4602, lat: 39.9026, source: 'preset', detail: '北京市朝阳区' },
  { name: '上海 · 陆家嘴', lon: 121.5057, lat: 31.2453, source: 'preset', detail: '上海市浦东新区' },
  { name: '广州 · 珠江新城', lon: 113.3245, lat: 23.1195, source: 'preset', detail: '广东省广州市' },
  { name: '深圳 · 福田', lon: 114.0579, lat: 22.5431, source: 'preset', detail: '广东省深圳市' },
  { name: '郑州 · 二七广场', lon: 113.6654, lat: 34.7579, source: 'preset', detail: '河南省郑州市' },
  { name: '成都 · 天府广场', lon: 104.0658, lat: 30.6574, source: 'preset', detail: '四川省成都市' },
  { name: '西安 · 钟楼', lon: 108.947, lat: 34.2611, source: 'preset', detail: '陕西省西安市' },
  { name: '杭州 · 武林广场', lon: 120.1635, lat: 30.2741, source: 'preset', detail: '浙江省杭州市' },
]

/** 网络请求统一超时，避免弱网时页面一直卡在「定位中」 */
function timeout(ms: number): AbortSignal {
  return typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
    ? AbortSignal.timeout(ms)
    : new AbortController().signal
}

async function getJson(url: string, ms = 7000): Promise<unknown> {
  const res = await fetch(url, { signal: timeout(ms), headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

function valid(lon: unknown, lat: unknown): boolean {
  return (
    typeof lon === 'number' &&
    typeof lat === 'number' &&
    Number.isFinite(lon) &&
    Number.isFinite(lat) &&
    Math.abs(lon) <= 180 &&
    Math.abs(lat) <= 85
  )
}

/**
 * 按 IP 属地定位。串行试三个服务：任一成功即返回。
 * 都用免费无 key 的公开接口，失败只是拿不到默认点，不影响手动选点。
 */
export async function locateByIp(): Promise<Place | null> {
  const sources: {
    url: string
    pick: (j: Record<string, unknown>) => Place | null
  }[] = [
    {
      url: 'https://ipwho.is/',
      pick: (j) => {
        if (j.success === false) return null
        const lon = Number(j.longitude)
        const lat = Number(j.latitude)
        if (!valid(lon, lat)) return null
        const city = String(j.city ?? '')
        const region = String(j.region ?? '')
        const country = String(j.country ?? '')
        return {
          lon,
          lat,
          name: city || region || country || 'IP 所在地',
          detail: [region, country].filter(Boolean).join(' · '),
          source: 'ip',
        }
      },
    },
    {
      url: 'https://ipapi.co/json/',
      pick: (j) => {
        if (j.error) return null
        const lon = Number(j.longitude)
        const lat = Number(j.latitude)
        if (!valid(lon, lat)) return null
        return {
          lon,
          lat,
          name: String(j.city ?? j.region ?? j.country_name ?? 'IP 所在地'),
          detail: [j.region, j.country_name].filter(Boolean).join(' · '),
          source: 'ip',
        }
      },
    },
    {
      url: 'https://api.ip.sb/geoip',
      pick: (j) => {
        const lon = Number(j.longitude)
        const lat = Number(j.latitude)
        if (!valid(lon, lat)) return null
        return {
          lon,
          lat,
          name: String(j.city ?? j.country ?? 'IP 所在地'),
          detail: [j.region, j.country].filter(Boolean).join(' · '),
          source: 'ip',
        }
      },
    },
  ]

  for (const s of sources) {
    try {
      const json = (await getJson(s.url, 6500)) as Record<string, unknown>
      const place = s.pick(json)
      if (place) return place
    } catch {
      // 换下一个源
    }
  }
  return null
}

/** 浏览器精确定位（需要用户授权；非安全上下文会直接失败） */
export async function locateByBrowser(): Promise<Place | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return null
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          lon: pos.coords.longitude,
          lat: pos.coords.latitude,
          name: '我的位置',
          detail: `精度 ±${Math.round(pos.coords.accuracy)} m`,
          source: 'gps',
        })
      },
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 9000, maximumAge: 300_000 },
    )
  })
}

/** Nominatim 的地点类型 → 中文短标签：搜索结果里同名地点很多，靠它区分城市与山峰 */
const KIND_LABEL: Record<string, string> = {
  city: '城市',
  town: '城镇',
  village: '村庄',
  hamlet: '村落',
  suburb: '城区',
  neighbourhood: '街区',
  county: '区县',
  state: '省州',
  country: '国家',
  mountain: '山',
  peak: '山峰',
  ridge: '山脊',
  valley: '山谷',
  glacier: '冰川',
  volcano: '火山',
  lake: '湖泊',
  reservoir: '水库',
  river: '河流',
  water: '水域',
  bay: '海湾',
  beach: '海滩',
  island: '岛屿',
  forest: '森林',
  park: '公园',
  nature_reserve: '保护区',
  aerodrome: '机场',
  railway: '车站',
  building: '建筑',
  attraction: '景点',
  viewpoint: '观景点',
}

/** 地名搜索（Nominatim）。返回按匹配度排序的前几条。 */
export async function searchPlace(query: string): Promise<Place[]> {
  const q = query.trim()
  if (!q) return []
  const url =
    'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=zh-CN&q=' +
    encodeURIComponent(q)
  try {
    const list = (await getJson(url, 9000)) as {
      lat: string
      lon: string
      name?: string
      display_name?: string
      type?: string
    }[]
    return list
      .map((it): Place | null => {
        const lon = Number(it.lon)
        const lat = Number(it.lat)
        if (!valid(lon, lat)) return null
        const parts = String(it.display_name ?? '').split(',')
        const type = String(it.type ?? '')
        return {
          lon,
          lat,
          name: it.name || parts[0]?.trim() || q,
          detail: parts.slice(1, 3).join(',').trim(),
          kind: KIND_LABEL[type] || (type && type !== 'yes' ? type : '地点'),
          source: 'search',
        }
      })
      .filter((p): p is Place => p !== null)
  } catch {
    return []
  }
}

/**
 * 解析用户输入的坐标。容忍这几种写法：
 * - `39.9026, 116.4602`（纬度在前，中国习惯）
 * - `116.4602, 39.9026`（经度在前 —— 第一个数超过 90 时自动识别）
 * - `39.9026°N 116.4602°E`、`N39.9 E116.4`
 */
export function parseLatLon(text: string): { lon: number; lat: number } | null {
  const s = text.trim()
  if (!s) return null
  const nums = s.match(/-?\d+(?:\.\d+)?/g)
  if (!nums || nums.length < 2) return null
  const a = Number(nums[0])
  const b = Number(nums[1])
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null

  const upper = s.toUpperCase()
  const latTagged = /[NS]/.test(upper)
  const lonTagged = /[EW]/.test(upper)
  let lon: number
  let lat: number
  if (latTagged && !lonTagged) {
    lat = a
    lon = b
  } else if (lonTagged && !latTagged) {
    lon = a
    lat = b
  } else if (Math.abs(a) > 90) {
    // 纬度最大 90°，第一个数超过 90 只能是经度（`116.4, 39.9` 这种写法）
    lon = a
    lat = b
  } else {
    lat = a
    lon = b
  }
  if (!valid(lon, lat)) return null
  return { lon, lat }
}

/** 逆地理编码：把经纬度变成「城市 · 区域」这类可读名称 */
export async function reverseName(lon: number, lat: number): Promise<string | null> {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&accept-language=zh-CN&lon=${lon}&lat=${lat}`
  try {
    const j = (await getJson(url, 7000)) as {
      name?: string
      display_name?: string
      address?: Record<string, string>
    }
    const a = j.address ?? {}
    const city = a.city || a.town || a.county || a.state || ''
    const district = a.city_district || a.suburb || a.neighbourhood || ''
    const label = [city, district].filter(Boolean).join(' · ')
    return label || j.name || j.display_name?.split(',')[0] || null
  } catch {
    return null
  }
}

/** 起飞点持久化：下次打开直接回到上次选的位置 */
const STORE_KEY = 'drone-sim.takeoff'

export function loadSavedTakeoff(): Place | null {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as Place
    if (!valid(p.lon, p.lat)) return null
    return { ...p, name: p.name || '上次起飞点' }
  } catch {
    return null
  }
}

export function saveTakeoff(place: Place): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(place))
  } catch {
    // 隐私模式下 localStorage 不可写，忽略
  }
}
