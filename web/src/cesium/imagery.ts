// Esri 影像的「占位瓦片」修复层。
//
// 问题现象：飞行中（快速移动 / 切起飞点 / 拉高俯视）地面会突然出现一大块灰白色板子，
// 上面斜排着 "Map data not yet available" 水印，而且飞到别处再飞回来它还在。
//
// 原因：ArcGIS World_Imagery 的 MapServer 在某个深层的瓦片**尚未生成或该区域没有该级别数据**时，
// 不会返回 404，而是返回 HTTP 200 + 一张 256×256 的灰底水印图。Cesium 无从分辨，
// 把它当成正常瓦片贴上去并缓存，于是永不自愈 —— 只能靠我们认图。
//
// 修复：认出来之后按代价从低到高三级处理
//   1. 等 700 ms 重取一次（服务端正在生成的情况，第二次通常就有真图）；
//   2. 取低两级（必要时低四级）的同一象限瓦片裁剪放大（糊，但地形轮廓和色调是对的）；
//   3. 返回 1×1 透明图，让下面那层 11 级兜底影像透出来。
import type * as CesiumNS from 'cesium'

const Cesium = window.Cesium

/** 低于这个级别不会出现占位（Esri 的浅层瓦片是预生成的），不必付出检测成本 */
const DETECT_MIN_LEVEL = 14
/** 重试等待：服务端生成一张 19 级瓦片通常在这个量级内完成 */
const RETRY_DELAY = 700

type RequestArgs = Parameters<CesiumNS.ImageryProvider['requestImage']>
type Imagery = Awaited<NonNullable<ReturnType<CesiumNS.ImageryProvider['requestImage']>>>

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms))

let probeCanvas: HTMLCanvasElement | null = null
let transparentTile: HTMLCanvasElement | null = null

/**
 * 是不是那张 "Map data not yet available" 占位图。
 *
 * 判据取自实图特征（见 web/shots 与 ESRI 实测样本）：
 *   整块底色接近 #DCDCDC（三通道都 > 195）、几乎无彩色、颜色种类极少。
 * 用「量化后唯一色数」而不是方差，是因为雪地 / 盐湖也平，但它们的灰阶过渡丰富，
 * 唯一色数会明显高于一张只有底色的占位图。
 */
function isPlaceholder(img: Imagery): boolean {
  const w = (img as { width?: number }).width ?? 0
  const h = (img as { height?: number }).height ?? 0
  if (!w || !h) return false
  probeCanvas ??= document.createElement('canvas')
  const c = probeCanvas
  c.width = 32
  c.height = 32
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) return false
  try {
    ctx.drawImage(img as CanvasImageSource, 0, 0, 32, 32)
  } catch {
    return false
  }
  let data: Uint8ClampedArray
  try {
    data = ctx.getImageData(0, 0, 32, 32).data
  } catch {
    // canvas 被跨域图污染（理论上 Cesium 走 XHR+blob 不会发生）：宁可当正常图，也不要误杀
    return false
  }
  const seen = new Set<number>()
  let light = 0
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    if (r > 195 && g > 195 && b > 195) light += 1
    // 每通道量化到 4 bit，再拼成一个 12 bit 颜色键
    seen.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4))
  }
  return light / 1024 > 0.55 && seen.size < 90
}

/** 1×1 透明图：让下层兜底影像透出来，而不是留一块黑或灰 */
function transparent(): HTMLCanvasElement {
  if (!transparentTile) {
    const c = document.createElement('canvas')
    c.width = 1
    c.height = 1
    transparentTile = c
  }
  return transparentTile
}

/**
 * 包一层 Esri 影像源。返回的对象与原 provider 接口一致，可直接 addImageryProvider。
 *
 * @param url      `.../MapServer/tile/{z}/{y}/{x}`
 * @param maxLevel 该层封顶级别
 */
export function createEsriImagery(url: string, maxLevel: number): CesiumNS.ImageryProvider {
  const provider = new Cesium.UrlTemplateImageryProvider({
    url,
    maximumLevel: maxLevel,
    // 占位图会被替换成透明图，必须声明 alpha，否则 Cesium 会按不透明贴图处理
    hasAlphaChannel: true,
    credit: new Cesium.Credit('Esri, Maxar, Earthstar Geographics'),
  })

  const raw = provider.requestImage.bind(provider) as (
    ...args: RequestArgs
  ) => Promise<Imagery> | undefined

  /** 取低 dz 级的同一象限瓦片并裁剪放大到整块 */
  async function upscale(x: number, y: number, level: number, dz: number) {
    const lv = level - dz
    if (lv < 0) return null
    let parent: Imagery | undefined
    try {
      parent = await raw(x >> dz, y >> dz, lv)
    } catch {
      return null
    }
    if (!parent || isPlaceholder(parent)) return null
    const n = 1 << dz
    const sub = 256 / n
    const canvas = document.createElement('canvas')
    canvas.width = 256
    canvas.height = 256
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    try {
      ctx.drawImage(parent as CanvasImageSource, (x % n) * sub, (y % n) * sub, sub, sub, 0, 0, 256, 256)
    } catch {
      return null
    }
    return canvas
  }

  const wrapped = async (
    x: number,
    y: number,
    level: number,
    request?: RequestArgs[3],
  ): Promise<Imagery | undefined> => {
    const img = await raw(x, y, level, request)
    if (!img || level < DETECT_MIN_LEVEL || !isPlaceholder(img)) return img

    // 1) 服务端正在生成：稍等再要一次（不带 request，避免已被 Cesium 取消）
    await sleep(RETRY_DELAY)
    const again = await raw(x, y, level)
    if (again && !isPlaceholder(again)) return again

    // 2) 降级：低一级 → 低两级 → 低四级
    //
    // 实测（2026-11，Esri World_Imagery）：
    //   玉龙雪山 19 级占位、18 级正常；那曲 18 级占位、17 级正常；塔克拉玛干 18/19 都占位、16 级正常。
    // 也就是说缺数据是「从某一级往上全缺」，往下追一级基本就能拿到真图，
    // 所以从 level-1 开始试：18 级瓦片裁 1/4 放大，比直接降到 15 级清楚一倍。
    for (const dz of [1, 2, 4]) {
      const up = await upscale(x, y, level, dz)
      if (up) return up
    }

    // 3) 兜底：透明，交给下层
    return transparent()
  }

  provider.requestImage = ((x: number, y: number, level: number, request?: RequestArgs[3]) =>
    wrapped(x, y, level, request)) as CesiumNS.ImageryProvider['requestImage']

  return provider
}

/** 兜底用的低清影像：全球 11 级，瓦片数极少，只为「不出现空洞」 */
export function createEsriBaseLayer(url: string): CesiumNS.ImageryProvider {
  return new Cesium.UrlTemplateImageryProvider({
    url,
    maximumLevel: 11,
    credit: new Cesium.Credit('Esri, Maxar, Earthstar Geographics'),
  })
}
