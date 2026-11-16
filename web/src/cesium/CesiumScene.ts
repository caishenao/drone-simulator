// Cesium 场景封装：三维地图、OSM 建筑、无人机 GLB 与跟随相机。
// Cesium 通过 index.html 的 UMD 脚本注入（window.Cesium），类型来自 npm 包。
import type * as CesiumNS from 'cesium'
import { CollisionWorld } from '../drone/collision'
import { AirflowField, ExplosionFx } from './effects'
import { createEsriBaseLayer, createEsriImagery } from './imagery'
import { fetchBuildings, type BuildingFootprint } from './buildings'
import { TerrainField, localToLonLat } from './terrainField'

const Cesium = window.Cesium

export type ImageryKind =
  | 'google-3d'
  | 'esri'
  | 'esri-street'
  | 'tianditu'
  | 'tianditu-vec'
  | 'tianditu-ter'
/** 跟随镜头：追尾 / 固定方位 / 云台第一视角 / 自由轨道 */
export type FollowMode = 'chase' | 'world' | 'fpv' | 'free'

export interface SceneConfig {
  /** 场景原点（无人机物理坐标 (0,0,0) 对应的经纬度） */
  lon: number
  lat: number
  height: number
  /** 纯视觉放大系数：真实机体 0.32 m，在城市尺度下需要放大才看得见 */
  droneScale: number
  followDistance: number
  /**
   * 是否加载真实高程。默认开。
   * 无头软件渲染（swiftshader）下地形会把帧率从 ~240 压到 ~0.5，
   * 自检脚本用 ?terrain=0 关掉它专门跑飞行回归；地形本身另有一份自检。
   */
  terrain: boolean
}

export const DEFAULT_SCENE: SceneConfig = {
  lon: 116.4602,
  lat: 39.9026,
  height: 0,
  droneScale: 8,
  followDistance: 22,
  terrain: true,
}

const ESRI_IMAGERY =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
const ZERO3: readonly number[] = [0, 0, 0]
const ESRI_STREET =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}'

/**
 * Google Photorealistic 3D Tiles 的 key（Google Cloud → Map Tiles API）。
 *
 * 这是「Google Earth 那种」摄影测量实景：楼有立面、山有坡面、相机平移有视差。
 * 三个前提必须说清楚，否则接上看不到东西会误判成代码问题：
 *   1. 覆盖 49 个国家 2500+ 城市，**不含中国大陆**（雄安 / 通州 / 北京都拿不到）；
 *   2. tile.googleapis.com 境内直连不通，需要代理；
 *   3. 计费按 root tileset 会话算，$6/千次，每月 1000 次免费。
 * 因此做成「有 key 才启用、失败自动回落 Esri」，绝不让演示开天窗。
 */
const GOOGLE_MAPS_KEY = (import.meta.env?.VITE_GOOGLE_MAPS_KEY as string | undefined) || ''
/** 面板据此提示「先去配 key」，而不是让用户点了没反应 */
export const hasGoogleMapsKey = Boolean(GOOGLE_MAPS_KEY)

/**
 * 全球真实高程（免 key、免代理）：ArcGIS WorldElevation3D/Terrain3D。
 *
 * 之前用的是 EllipsoidTerrainProvider —— 半径 6378137 的完美椭球，
 * 一点起伏都没有，所以飞到山区看到的还是平地，只有一层卫星图片。
 * 换成真高程后山体才有坡度、背阴面和视差：相机一动，山脊与山谷就会互相遮挡。
 * Cesium 的 ArcGISTiledElevationTerrainProvider 直接吃这个 ImageServer 的 LERC 瓦片。
 */
const ARCGIS_TERRAIN =
  'https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer'

/**
 * 天地图浏览器端 key（tk）。这枚 key 的权限类型是「浏览器端」，
 * 服务端直接 curl 会返回 403（code 301012），浏览器带 Referer 即可正常取图。
 * 可通过 .env.local 的 VITE_TIANDITU_KEY 覆盖。
 */
const TIANDITU_KEY =
  (import.meta.env?.VITE_TIANDITU_KEY as string | undefined) ||
  '9c123d6f8cee62d220f6d6318e801ab6'
/** 天地图限流按域名分摊，8 个子域轮转 */
const TIANDITU_SUBDOMAINS = ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7']
/** 天地图 w 矩阵集最高 18 级，19 级返回「该级别下该区域无影像」占位图 */
const TIANDITU_MAX_LEVEL = 18

/**
 * 天地图影像/注记只覆盖中国境内，境外请求会返回一张白底「无影像」占位图
 * （仍是合法 image/png，仅靠 content-type 探测识别不出来）。
 * 用保守外接矩形判断，宁可在边缘多用 Esri，也不要给用户一片白地。
 */
function tdtHasCoverage(lon: number, lat: number): boolean {
  return Number.isFinite(lon) && Number.isFinite(lat) && lon >= 73 && lon <= 135 && lat >= 17 && lat <= 54
}

type TdtLayer = 'img' | 'vec' | 'ter' | 'cia' | 'cva'

/** 天地图 WMTS（球面墨卡托 w 矩阵集）；Cesium 的 {TileMatrix} 直接取层级号，与天地图编号一致 */
function tiandituProvider(layer: TdtLayer): CesiumNS.ImageryProvider {
  return new Cesium.WebMapTileServiceImageryProvider({
    url:
      `https://{s}.tianditu.gov.cn/${layer}_w/wmts?SERVICE=WMTS&REQUEST=GetTile` +
      '&VERSION=1.0.0' +
      `&LAYER=${layer}&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles` +
      '&TILEMATRIX={TileMatrix}&TILEROW={TileRow}&TILECOL={TileCol}' +
      `&tk=${TIANDITU_KEY}`,
    layer,
    style: 'default',
    format: 'tiles',
    tileMatrixSetID: 'w',
    subdomains: TIANDITU_SUBDOMAINS,
    maximumLevel: TIANDITU_MAX_LEVEL,
    credit: new Cesium.Credit('天地图 · 国家地理信息公共服务平台'),
  })
}

/** sRGB 十六进制 → 线性色：Cesium 把颜色分量当线性值送进着色器，直接给 sRGB 会发白 */
function srgb(hex: string, alpha = 1): CesiumNS.Color {
  const c = Cesium.Color.fromCssColorString(hex)
  return new Cesium.Color(Math.pow(c.red, 2.2), Math.pow(c.green, 2.2), Math.pow(c.blue, 2.2), alpha)
}

export class CesiumScene {
  readonly viewer: CesiumNS.Viewer
  readonly config: SceneConfig

  private origin: CesiumNS.Cartesian3
  private east: CesiumNS.Cartesian3
  private north: CesiumNS.Cartesian3
  private up: CesiumNS.Cartesian3

  private drone: CesiumNS.Model | null = null
  private droneECEF = new Cesium.Cartesian3()
  private matrixScratch = new Cesium.Matrix4()
  private columnScratch = new Array<number>(16).fill(0)

  private buildings: CesiumNS.GeoJsonDataSource | null = null
  /** 矢量瓦片生成的建筑体块（带法线光照，真立体明暗） */
  private buildingPrimitive: CesiumNS.Primitive | null = null
  private buildingLabels: CesiumNS.LabelCollection | null = null
  private buildingData: BuildingFootprint[] = []
  private buildingsOn = true
  private buildingCount = 0
  private ionTileset: CesiumNS.Cesium3DTileset | null = null
  /** 建筑碰撞体（静态刚体）：局部米制轮廓 + 楼顶高度 */
  readonly collision = new CollisionWorld()

  // —— 特效：空气流场 + 撞击爆炸 ——
  private airflow: AirflowField
  private explosion: ExplosionFx
  private shake = 0
  /** 死亡镜头过渡量 0→1 */
  private crashCamT = 0
  private crashCamOn = false
  private airflowOn = true
  private lastYaw = 0
  private crashed = false

  // —— 真实高程 ——
  /** 全球高程地形；null = 服务不可达，退回椭球（山还是平的，但飞行不受影响） */
  private terrain: CesiumNS.TerrainProvider | null = null
  /** 地形初始化结束（成功或放弃）后 resolve；采样高程前必须等它 */
  private terrainReady: Promise<void>
  /** 场景一建好、地形与原点就位后 resolve —— 调用方要等这个再操作场景 */
  readonly ready: Promise<void>
  /** 场景切换序号：只有最新一次 setOrigin 才允许落地 */
  private originSeq = 0
  /** 原点处的地形高程（米，海拔）。origin 已经抬到这条线上，物理 y=0 即地面 */
  groundElevation = 0

  // —— 地形碰撞 ——
  /**
   * 地形高度场（局部米制网格）。
   * 物理层原本的地面判定是常数平面，机体在山体里照样穿行；
   * 这份高度场加上 globe.getHeight 提供「随位置变化」的地面高度与地表法向，
   * 让无人机能真的撞上山。
   */
  readonly terrainField = new TerrainField({ half: 600, cell: 30 })
  /** 地表法向缓存：按 12 m 量化，避免每物理子步都去查瓦片 */
  private normalCache = new Map<number, [number, number, number]>()
  /** 地面高度缓存：按 4 m 量化。globe.getHeight 单次 4.5 ms，不缓存会拖垮帧率 */
  private heightCache = new Map<number, number>()
  /** 上次滚动重采样时无人机所在的局部位置 */
  private terrainSampleAt = { x: 1e9, z: 1e9 }
  /** 地形碰撞是否启用（关掉后退回平面地面） */
  private terrainCollisionOn = true

  /**
   * 默认底图用 Esri 而不是天地图：
   * 这枚硬编码的天地图公共 key 免费额度很小，跑两轮自检（几百张瓦片）就会整体 429，
   * 打开就是一片空白；Esri 无需 key、19 级封顶比天地图 18 级更细、还覆盖全球 ——
   * 用户搜到境外或无人区时不会掉白块。天地图仍留在面板里，配自己的 key 更好。
   */
  private imageryKind: ImageryKind = 'esri'
  /** 天地图注记层（影像用 cia，矢量用 cva），切换底图时一并换掉 */
  private labelLayer: CesiumNS.ImageryLayer | null = null
  /** Google Photorealistic 3D Tiles 实例，只有 google-3d 底图下存在 */
  private googleTileset: CesiumNS.Cesium3DTileset | null = null
  /** 底图切换序号：网络请求回来时对不上就丢弃，防止快速连点后旧结果覆盖新底图 */
  private imagerySeq = 0
  /** 进 Google 实景前的建筑开关，退出时原样还原 */
  private buildingPref3d: boolean | null = null
  /** 进/出实景时场景会自动收放本地建筑，需要把新状态同步给面板按钮 */
  onBuildingsSync: ((show: boolean) => void) | null = null

  private followMode: FollowMode = 'chase'
  private followDistance: number
  private fixedHeading = Cesium.Math.toRadians(126)
  private followPitch = Cesium.Math.toRadians(-22)
  /** 复用的 HeadingPitchRange，避免每帧 new */
  private followHpr = new Cesium.HeadingPitchRange(0, -0.38, 22)

  // —— 云台 / 第一视角 ——
  /** 云台俯仰（度，相对地平线，负值向下） */
  private gimbalPitchDeg = -12
  /** 云台偏航（度，相对机头，辅助环视） */
  private gimbalYawDeg = 0
  private gimbalNode: CesiumNS.ModelNode | null = null
  private gimbalBase = new Cesium.Matrix4()
  private gimbalRot = new Cesium.Matrix3()
  private gimbalMat = new Cesium.Matrix4()
  /** 机身显隐（撞击后为 false，FPV 下额外隐藏） */
  private droneVisible = true
  /** 机体姿态/位置（局部 ENU 米制），供 FPV 相机逐帧取景 */
  private bodyRot = [1, 0, 0, 0, 1, 0, 0, 0, 1]
  private bodyPos = [0, 0, 0]
  /** GLB 里云台相对重心的安装位置（米，机体系） */
  private static readonly GIMBAL_FWD = 0.048
  private static readonly GIMBAL_DOWN = 0.024
  private fpvPos = new Cesium.Cartesian3()
  private fpvTarget = new Cesium.Cartesian3()
  private fpvDir = new Cesium.Cartesian3()
  private fpvUp = new Cesium.Cartesian3()
  /** 常规镜头视场角，退出 FPV 时还原 */
  private baseFov = Cesium.Math.toRadians(60)

  // —— 旋翼：Cesium 给的是节点矩阵，逐帧绕局部 Y 写回即可转动 ——
  private rotors: {
    node: CesiumNS.ModelNode
    base: CesiumNS.Matrix4
    dir: number
    phase: number
  }[] = []
  private rotorAngle = 0
  private rotorsBound = false
  private rotorRot = new Cesium.Matrix3()
  private rotorLocal = new Cesium.Matrix4()
  /** 相机在局部米制坐标下的位置（供流场做近距淡出） */
  private camLocal = [0, 0, 0]
  private camRel = new Cesium.Cartesian3()

  // —— 地图点选：把任意地表位置设为起飞点 ——
  private pickMode = false
  private pickHandler: CesiumNS.ScreenSpaceEventHandler | null = null
  /** 用户在地球上点选位置（经纬度，度）；由 CesiumViewer 转发给应用层 */
  onGlobePick: ((lon: number, lat: number) => void) | null = null

  // —— 飞行轨迹：PolylineCollection 增量追加顶点，长航线也不卡 ——
  private trail = new Cesium.PolylineCollection()
  private trailLine: CesiumNS.Polyline | null = null
  private trailPoints: CesiumNS.Cartesian3[] = []
  private trailClock = 0
  private trailVisible = true
  private trailRecording = true
  /** 轨迹颜色与线宽（飞行配置页设置） */
  private trailColor = '#5ad1ff'
  private trailWidth = 2.4
  private static readonly TRAIL_MAX_POINTS = 4000
  private static readonly TRAIL_SAMPLE_SEC = 0.2
  private static readonly TRAIL_MIN_STEP_M = 0.6

  // —— 配置页：起飞点预览标记 ——
  /** 预览标记实体 id（地面定位点 + 名称） */
  private static readonly PREVIEW_MARKER_ID = '__drone_preview_marker'

  constructor(container: HTMLElement, config: Partial<SceneConfig> = {}) {
    this.config = { ...DEFAULT_SCENE, ...config }
    this.followDistance = this.config.followDistance

    this.origin = Cesium.Cartesian3.fromDegrees(this.config.lon, this.config.lat, this.config.height)
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(this.origin)
    this.east = new Cesium.Cartesian3(enu[0], enu[1], enu[2])
    this.north = new Cesium.Cartesian3(enu[4], enu[5], enu[6])
    this.up = new Cesium.Cartesian3(enu[8], enu[9], enu[10])

    this.viewer = new Cesium.Viewer(container, {
      // 底图在下面统一挂（天地图是「影像 + 注记」两层，不能只给一个 baseLayer）
      baseLayer: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      shouldAnimate: true,
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    })

    const scene = this.viewer.scene
    // 记录默认视场角：云台第一视角用广角（75°），退出时还原
    this.baseFov =
      (this.viewer.camera.frustum as CesiumNS.PerspectiveFrustum).fov ?? Cesium.Math.toRadians(60)
    // 时钟锁定在夏至正午（北京时间 12:00）：默认跟随系统时间，
    // 晚上打开会变成夜景（天空暗红、地面发黑），演示场景必须固定光照
    this.viewer.clock.currentTime = Cesium.JulianDate.fromIso8601('2026-06-21T04:00:00Z')
    this.viewer.clock.shouldAnimate = false
    this.viewer.clock.clockRange = Cesium.ClockRange.CLAMPED
    // 底图未加载时露出的球体底色：用中性石板色，避免深蓝近乎全黑
    scene.globe.baseColor = Cesium.Color.fromCssColorString('#3b4956')
    // 地面不参与光照：Cesium 的 Entity/PerInstance 几何不会被 globe 阴影接收，
    // 开了只会让卫星影像整体压暗，看不到任何投影
    scene.globe.enableLighting = false
    // 关闭地面大气：它按太阳角度给地表叠暖色，瓦片缺失时会把整片地面染成暗红
    scene.globe.showGroundAtmosphere = false
    scene.globe.depthTestAgainstTerrain = true
    // 定向光：让建筑有稳定的立面明暗（太阳光跟着纬度/季节变，赤道正午几乎垂直打下来，
    // 墙面全是一个亮度，看着又平了）。地面保持 enableLighting=false，不跟着变暗。
    this.updateSunLight()
    // 阴影贴图对 Primitive 的接收端支持不完整（开了也看不到地面投影），关掉省性能
    this.viewer.shadows = false
    // 低空掠视时瓦片细分压力大：降 SSE（更细）+ 缓存更多已下载块。
    // 不开 preloadSiblings：每块预取 4 个兄弟会把请求量放大 4 倍，天地图直接 429 限流
    scene.globe.maximumScreenSpaceError = 2
    scene.globe.preloadSiblings = false
    scene.globe.tileCacheSize = 300
    if (scene.skyAtmosphere) {
      scene.skyAtmosphere.show = true
      scene.skyAtmosphere.hueShift = -0.02
      scene.skyAtmosphere.saturationShift = 0.04
    }
    scene.fog.enabled = true
    scene.fog.density = 0.00022
    scene.backgroundColor = Cesium.Color.fromCssColorString('#0b1520')
    // 关掉 FXAA：它会把小尺寸机体/桨叶糊成一团（MSAA 4x 仍在，边缘不会锯齿）
    scene.postProcessStages.fxaa.enabled = false
    scene.screenSpaceCameraController.minimumZoomDistance = 1.5
    // 配置页要能一路滚轮缩到地球全景（40 km 只够看城市）。
    // 地球半径约 6.37e6 m，2.5e7 m 约等于 4 个地球直径，足够看到完整球体。
    scene.screenSpaceCameraController.maximumZoomDistance = 25_000_000
    this.viewer.cesiumWidget.creditContainer.parentElement?.classList.add('cesium-credits')

    this.viewer.scene.primitives.add(this.trail)

    // 地图点选：只在「点选模式」下响应，正常飞行时点画面不会被误判为换起飞点
    this.pickHandler = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas)
    this.pickHandler.setInputAction(
      (movement: CesiumNS.ScreenSpaceEventHandler.PositionedEvent) => {
        if (!this.pickMode || !this.onGlobePick) return
        // 接上真实地形后不能再只求「视线 × 椭球」：点在山上会落到山脊背后的椭球面，
        // 差几十上百米。先沿视线打地形，打不到（点在天上或地形未开）再退回椭球。
        const ray = this.viewer.camera.getPickRay(movement.position)
        const cart =
          (ray && this.viewer.scene.globe.pick(ray, this.viewer.scene)) ||
          this.viewer.camera.pickEllipsoid(movement.position, Cesium.Ellipsoid.WGS84)
        if (!cart) return
        const c = Cesium.Cartographic.fromCartesian(cart)
        this.onGlobePick(Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude))
      },
      Cesium.ScreenSpaceEventType.LEFT_CLICK,
    )

    // 空气流场 + 爆炸特效（各自一个 BillboardCollection，单 draw call）
    this.airflow = new AirflowField(this.viewer.scene, this.localToEcef, 80)
    this.explosion = new ExplosionFx(this.viewer.scene, this.localToEcef)
    this.viewer.scene.primitives.add(this.airflow.primitive)
    this.viewer.scene.primitives.add(this.explosion.additive)
    this.viewer.scene.primitives.add(this.explosion.soft)

    // 真实高程：先建地形再定原点 —— origin 必须落在地表上，
    // 否则物理 y=0 停在椭球面，整架飞机和所有建筑都会埋进山里
    this.terrainReady = this.initTerrain()
    this.ready = this.terrainReady.then(async () => {
      await this.setOrigin(this.config.lon, this.config.lat)
    })

    // 默认底图：天地图卫星影像 + 中文注记
    void this.setImagery(this.imageryKind)

    this.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(this.config.lon, this.config.lat + 0.008, 1100),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-26), roll: 0 },
    })

    this.patchCulling()
  }

  get originCartographic(): CesiumNS.Cartographic {
    return Cesium.Cartographic.fromCartesian(this.origin)
  }

  /**
   * Cesium 的可见性剔除遇到 NaN 包围体时会执行 `new Array(NaN)`，
   * 抛出的 RangeError 被 Scene 记成 renderError 后**永久停掉渲染循环**（整页卡成静止帧）。
   * 这里给它包一层：单帧剔除失败就跳过这一帧，下一帧照常渲染。
   */
  private patchCulling(): void {
    const V = (Cesium as unknown as { View?: { prototype: Record<string, unknown> } }).View
    const proto = V?.prototype
    if (!proto || proto.__droneSafeCull) return
    const orig = proto.createPotentiallyVisibleSet as ((this: unknown, s: unknown) => void) | undefined
    if (typeof orig !== 'function') return
    proto.__droneSafeCull = true
    type Cmd = {
      pass?: unknown
      boundingVolume?: { center?: { x: number; y: number; z: number }; radius?: number }
    }
    proto.createPotentiallyVisibleSet = function (
      this: unknown,
      scene: { frameState?: { commandList?: Cmd[] } },
    ) {
      const list = scene?.frameState?.commandList
      const bad: { cx: number; cy: number; cz: number; r: number; pass: unknown }[] = []
      if (list) {
        // 包围体是 NaN 的 command 会让 Cesium 的 near/far 变成 NaN，
        // 进而 new Array(NaN) 抛 RangeError 把渲染循环停死 —— 先摘掉它们
        for (let i = list.length - 1; i >= 0; i--) {
          const bv = list[i]?.boundingVolume
          const c = bv?.center
          if (!bv || !c) continue
          const okC = Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z)
          const okR = Number.isFinite(bv.radius as number)
          if (!okC || !okR) {
            if (bad.length < 6) bad.push({ cx: c.x, cy: c.y, cz: c.z, r: bv.radius as number, pass: list[i]?.pass })
            list.splice(i, 1)
          }
        }
      }
      if (bad.length) (window as unknown as Record<string, unknown>).__cullBad = bad
      try {
        orig.call(this, scene)
      } catch {
        if (list) list.length = 0
      }
    }
  }

  private updateSunLight(): void {
    // 锁定「当地 15:00」而不是正午：正午太阳近乎顶射，所有墙面一个亮度，
    // 建筑立刻退回成一摞色块。下午三点太阳西斜，南墙/西墙亮、北墙/东墙暗。
    const utc = 15 - this.config.lon / 15
    const h = Math.floor(((utc % 24) + 24) % 24)
    const m = Math.round(((((utc % 1) + 1) % 1) * 60) / 5) * 5
    const iso = `2026-06-21T${String(h).padStart(2, '0')}:${String(m === 60 ? 55 : m).padStart(2, '0')}:00Z`
    this.viewer.clock.currentTime = Cesium.JulianDate.fromIso8601(iso)
    this.viewer.clock.shouldAnimate = false
    // 之前若被换成 DirectionalLight，这里恢复成随经纬度走太阳的 SunLight
    if (!(this.viewer.scene.light instanceof Cesium.SunLight)) {
      this.viewer.scene.light = new Cesium.SunLight()
    }
  }

  /** 局部米制坐标（x=东、y=上、z=南）→ ECEF；箭头函数保证 this 绑定，可传给特效类 */
  localToEcef = (
    x: number,
    y: number,
    z: number,
    result: CesiumNS.Cartesian3,
  ): CesiumNS.Cartesian3 => {
    result.x = this.origin.x + this.east.x * x + this.up.x * y - this.north.x * z
    result.y = this.origin.y + this.east.y * x + this.up.y * y - this.north.y * z
    result.z = this.origin.z + this.east.z * x + this.up.z * y - this.north.z * z
    return result
  }

  /** 相机位置换算到场景局部米制坐标（x=东, y=上, z=南），供流场做近距淡出 */
  private cameraLocal(): number[] {
    const rel = Cesium.Cartesian3.subtract(this.viewer.camera.position, this.origin, this.camRel)
    this.camLocal[0] = Cesium.Cartesian3.dot(rel, this.east)
    this.camLocal[1] = Cesium.Cartesian3.dot(rel, this.up)
    this.camLocal[2] = -Cesium.Cartesian3.dot(rel, this.north)
    return this.camLocal
  }

  /** 地图点选模式：光标变十字，下一次点击地球即回调 onGlobePick */
  setPickMode(on: boolean): void {
    this.pickMode = on
    this.viewer.scene.canvas.style.cursor = on ? 'crosshair' : ''
  }

  // —— 特效接口 ——
  /** 空气流场显隐 */
  setAirflowVisible(visible: boolean): void {
    this.airflowOn = visible
    this.applyAirflowVisibility()
  }

  /** 流线是绕机体的一层可视化：第一视角下镜头就在流场里，会变成划过画面的白线，需隐掉 */
  private applyAirflowVisibility(): void {
    this.airflow.setVisible(this.airflowOn && !this.crashed && this.followMode !== 'fpv')
  }

  /** 机体模型显隐（坠毁后隐藏机身，只剩爆炸碎片；FPV 下也隐藏） */
  setDroneVisible(visible: boolean): void {
    this.droneVisible = visible
    this.applyDroneVisibility()
  }

  private applyDroneVisibility(): void {
    if (this.drone) this.drone.show = this.droneVisible && this.followMode !== 'fpv'
  }

  /** 在局部米制坐标处引爆 */
  detonate(position: readonly number[], strength = 1): void {
    this.explosion.detonate(position, strength)
    this.shake = 1
    this.crashed = true
    this.crashCamOn = true
    this.applyAirflowVisibility()
  }

  /** 擦碰碎屑（低速刚体碰撞反馈） */
  impact(position: readonly number[], strength = 1): void {
    this.explosion.impact(position, strength)
    this.shake = Math.max(this.shake, Math.min(0.4, strength * 0.4))
  }

  /** 清理爆炸残留（重新开始时调用） */
  resetEffects(): void {
    this.explosion.reset()
    this.shake = 0
    this.crashed = false
    this.crashCamOn = false
    this.crashCamT = 0
    this.applyAirflowVisibility()
  }

  /** 撞击死亡镜头：抬高俯角 + 拉远，避免火球被楼顶平面挡住 */
  setCrashCamera(on: boolean): void {
    this.crashCamOn = on
    if (!on) this.crashCamT = 0
  }

  /** 逐帧推进特效：爆炸、相机抖动（坠毁后仍需继续跑） */
  updateEffects(dt: number): void {
    this.explosion.update(dt)
    this.shake = this.explosion.power
    if (this.crashCamOn && this.crashCamT < 1) {
      this.crashCamT = Math.min(1, this.crashCamT + dt * 4)
    }
    // 坠毁后不再调用 updateDrone，镜头推进要在这里补上，否则会僵在贴楼顶的死角
    if (this.crashed) this.updateCamera(this.lastYaw)
  }

  /** 加载 GLB 无人机；upAxis/forwardAxis 用于抵消 Cesium 的 glTF 轴向修正 */
  async loadDrone(url: string): Promise<void> {
    const model = await Cesium.Model.fromGltfAsync({
      url,
      modelMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY),
      scale: this.config.droneScale,
      minimumPixelSize: 34,
      upAxis: Cesium.Axis.Y,
      forwardAxis: Cesium.Axis.X,
      allowPicking: false,
    })
    model.shadows = Cesium.ShadowMode.DISABLED
    this.viewer.scene.primitives.add(model)
    this.drone = model
    // fromGltfAsync 解析完成时 sceneGraph 可能还没建好，getNode 会返回 undefined → 这里先试一次，失败则逐帧重试
    this.bindRotors()
    this.bindGimbal()
    this.applyDroneVisibility()
  }

  /** 绑定四个旋翼节点：绕各自电机轴（模型局部 Y）自转，对角同向、相邻反向 */
  private bindRotors(): void {
    if (this.rotorsBound || !this.drone) return
    const rotorSpec: [string, number][] = [
      ['Rotor_FL', 1],
      ['Rotor_FR', -1],
      ['Rotor_RL', -1],
      ['Rotor_RR', 1],
    ]
    const found: {
      node: CesiumNS.ModelNode
      base: CesiumNS.Matrix4
      dir: number
      phase: number
    }[] = []
    for (const [name, dir] of rotorSpec) {
      const node = this.drone.getNode(name)
      if (!node) return // 还没就绪：保持空数组，下一帧再试
      found.push({
        node,
        base: Cesium.Matrix4.clone(node.matrix),
        dir,
        // 相位错开：四片桨叶不会始终成同一角度，看起来才像各自在转
        phase: found.length * 1.7,
      })
    }
    this.rotors = found
    this.rotorsBound = true
  }

  /** 旋翼自转：rpm 由物理推出，视觉按 1/780 缩放（6000 rpm ≈ 7.7 转/秒，肉眼刚好能看出在转） */
  private updateRotorSpin(dt: number, rpm: number): void {
    if (!this.rotorsBound) this.bindRotors()
    if (this.rotors.length === 0 || dt <= 0) return
    // 3D 模式负推力 = 电机反转：rpm 传负值，桨叶反向转，肉眼能看出「在倒推」
    const dir = rpm < 0 ? -1 : 1
    const revPerSec = Math.min(11, Math.abs(rpm) / 780)
    this.rotorAngle = (this.rotorAngle + dir * revPerSec * dt * Math.PI * 2) % (Math.PI * 2)
    for (const r of this.rotors) {
      Cesium.Matrix3.fromRotationY(this.rotorAngle * r.dir + r.phase, this.rotorRot)
      Cesium.Matrix4.fromRotationTranslation(this.rotorRot, Cesium.Cartesian3.ZERO, this.rotorLocal)
      // 注意：必须整体赋值 node.matrix，改元素或原地写回都不会触发 Cesium 重算
      r.node.matrix = Cesium.Matrix4.multiply(r.base, this.rotorLocal, new Cesium.Matrix4())
    }
  }

  /** 绑定云台俯仰节点：GLB 里镜头朝 -Z，绕局部 X 正转抬头、负转低头 */
  private bindGimbal(): void {
    if (this.gimbalNode || !this.drone) return
    const node = this.drone.getNode('Gimbal_Pivot')
    if (!node) return
    this.gimbalNode = node
    this.gimbalBase = Cesium.Matrix4.clone(node.matrix)
    this.updateGimbalNode()
  }

  /** 把云台俯仰写进 GLB 节点，切回第三人称时能看到镜头真实抬头/低头 */
  private updateGimbalNode(): void {
    if (!this.gimbalNode) this.bindGimbal()
    if (!this.gimbalNode) return
    Cesium.Matrix3.fromRotationX(Cesium.Math.toRadians(this.gimbalPitchDeg), this.gimbalRot)
    Cesium.Matrix4.fromRotationTranslation(this.gimbalRot, Cesium.Cartesian3.ZERO, this.gimbalMat)
    this.gimbalNode.matrix = Cesium.Matrix4.multiply(this.gimbalBase, this.gimbalMat, new Cesium.Matrix4())
  }

  /** 设置云台角度（度）：俯仰 -90..30，偏航 -90..90（相对机头） */
  setGimbal(pitchDeg: number, yawDeg: number): void {
    if (Number.isFinite(pitchDeg)) this.gimbalPitchDeg = Cesium.Math.clamp(pitchDeg, -90, 30)
    if (Number.isFinite(yawDeg)) this.gimbalYawDeg = Cesium.Math.clamp(yawDeg, -90, 90)
    this.updateGimbalNode()
  }

  get gimbalAngles(): { pitch: number; yaw: number } {
    return { pitch: this.gimbalPitchDeg, yaw: this.gimbalYawDeg }
  }

  /**
   * 组装机体模型矩阵：局部 ENU 位姿（米制、x=东 y=上 z=南）→ ECEF，含 glTF 轴向修正。
   * 本地机体（updateDrone）与远端玩家机体（RemoteDrones）必须共用这一套数学，
   * 否则两边姿态对不上。结果写进 result（调用方自备 scratch，避免本地/远端互相踩）。
   */
  composeDroneMatrix(
    position: readonly number[],
    quaternion: readonly number[],
    result: CesiumNS.Matrix4,
  ): CesiumNS.Matrix4 {
    const q = new Cesium.Quaternion(quaternion[0], quaternion[1], quaternion[2], quaternion[3])
    const rot = Cesium.Matrix3.toArray(Cesium.Matrix3.fromQuaternion(q))
    // FPV 相机要读本机体的机体系三轴（bodyRot）。远端机体 compose 时也会覆盖它，
    // 但读点只在本地 updateDrone 尾部的 updateCamera：每帧本地 compose 先写后读，时序安全
    for (let i = 0; i < 9; i++) this.bodyRot[i] = rot[i]
    const cols = this.columnScratch
    // 机体系三轴（右 / 上 / 后）→ ECEF
    for (let c = 0; c < 3; c++) {
      const a = rot[c * 3]
      const b = rot[c * 3 + 1]
      const d = rot[c * 3 + 2]
      cols[c * 4] = this.east.x * a + this.up.x * b - this.north.x * d
      cols[c * 4 + 1] = this.east.y * a + this.up.y * b - this.north.y * d
      cols[c * 4 + 2] = this.east.z * a + this.up.z * b - this.north.z * d
      cols[c * 4 + 3] = 0
    }
    // 模型空间经轴向修正后为 X=右、Y=前、Z=上 → 第二列取「前」= 后向取反
    for (let i = 0; i < 3; i++) {
      const back = cols[8 + i]
      const tpl = cols[4 + i]
      cols[4 + i] = -back
      cols[8 + i] = tpl
    }

    const [x, y, z] = position
    cols[12] = this.origin.x + this.east.x * x + this.up.x * y - this.north.x * z
    cols[13] = this.origin.y + this.east.y * x + this.up.y * y - this.north.y * z
    cols[14] = this.origin.z + this.east.z * x + this.up.z * y - this.north.z * z
    cols[15] = 1
    return Cesium.Matrix4.fromColumnMajorArray(cols, result)
  }

  /** 把物理状态（米制、x=东 y=上 z=南）写进模型矩阵并更新跟随相机 */
  updateDrone(
    position: readonly number[],
    quaternion: readonly number[],
    yawRad: number,
    dt = 0,
    rpm = 0,
    velocity: readonly number[] = ZERO3,
    wind: readonly number[] = ZERO3,
  ): void {
    if (!this.drone) return
    // 刚体解算若出现 NaN，写进 modelMatrix 会让 Model 的包围球变成 NaN，
    // 随后 Cesium 的可见性剔除会 new Array(NaN) 直接把渲染打停
    if (!Number.isFinite(position[0] + position[1] + position[2])) return
    if (!Number.isFinite(quaternion[0] + quaternion[1] + quaternion[2] + quaternion[3])) return
    // 地形高度场随机体滚动重采样（异步，不阻塞物理）
    this.refreshTerrainField(position[0], position[2])
    this.lastYaw = yawRad

    this.composeDroneMatrix(position, quaternion, this.matrixScratch)
    this.drone.modelMatrix = this.matrixScratch
    Cesium.Matrix4.getTranslation(this.matrixScratch, this.droneECEF)

    const [x, y, z] = position
    this.bodyPos[0] = x
    this.bodyPos[1] = y
    this.bodyPos[2] = z

    this.updateRotorSpin(dt, rpm)
    this.updateGimbalNode()
    this.sampleTrail(dt)
    // 空气流场：贴着机体的一层流线，速度越快越明显
    if (this.airflowOn && this.followMode !== 'fpv') {
      this.airflow.update(dt, position, velocity, wind, this.cameraLocal())
    }
    // 每帧跟一次：任何「死区」都会让机体先漂走再被追上，观感就是整体颤抖
    this.updateCamera(yawRad)
  }

  private updateCamera(yawRad: number): void {
    if (!this.drone) return
    if (this.followMode === 'fpv') {
      this.updateFpvCamera()
      return
    }
    if (this.followMode === 'free') return
    // 复位前 droneECEF 还是 (0,0,0)（地心）：拿它 lookAt 会让相机 up 与 direction 共线，
    // 视图矩阵退化后 setView 算出的视锥是 NaN，Cesium 会在可见性剔除里 new Array(NaN) 崩掉
    if (Cesium.Cartesian3.magnitude(this.droneECEF) < 1e6) return
    if (!Number.isFinite(yawRad)) return
    const hpr = this.followHpr
    hpr.heading = this.followMode === 'chase' ? -yawRad : this.fixedHeading
    hpr.pitch = this.followPitch
    hpr.range = this.followDistance
    // 死亡镜头：抬高俯角并拉远，让爆炸从楼顶平面上露出来
    if (this.crashCamT > 0.001) {
      // easeOut：镜头先快速退开，再缓停
      const k = 1 - (1 - this.crashCamT) * (1 - this.crashCamT)
      hpr.pitch = this.followPitch + (-0.82 - this.followPitch) * k
      hpr.range = this.followDistance * (1 + 1.5 * k)
    }
    // 爆炸抖动：只在撞击后短暂生效
    if (this.shake > 0.01) {
      const k = Math.min(1, this.shake)
      hpr.heading += (Math.random() - 0.5) * 0.055 * k
      hpr.pitch += (Math.random() - 0.5) * 0.05 * k
      hpr.range *= 1 + (Math.random() - 0.5) * 0.07 * k
    }
    this.viewer.camera.lookAt(this.droneECEF, hpr)
  }

  /**
   * 云台第一视角：机位落在 GLB 云台镜头上，朝向 = 机头航向 + 云台偏航、云台俯仰。
   * 三轴云台会隔离机体俯仰/横滚 —— 画面地平线始终水平，只有视线在动，
   * 这正是穿越机/航拍机 FPV 的手感，也是这个视角区别于「追尾」的关键。
   */
  private updateFpvCamera(): void {
    if (Cesium.Cartesian3.magnitude(this.droneECEF) < 1e6) return
    const r = this.bodyRot
    // 机体系（右 / 上 / 后）在局部 ENU（x=东 y=上 z=南）下的分量
    const fwdX = -r[6]
    const fwdY = -r[7]
    const fwdZ = -r[8]
    const upX = r[3]
    const upY = r[4]
    const upZ = r[5]
    // 航向：机头水平投影相对正北的夹角（局部 z 轴指向南，故取 -r[6] / r[8]）
    const heading = Math.atan2(-r[6], r[8])
    if (!Number.isFinite(heading)) return
    const pitch = Cesium.Math.toRadians(this.gimbalPitchDeg)
    const yaw = heading + Cesium.Math.toRadians(this.gimbalYawDeg)
    const cp = Math.cos(pitch)
    const sp = Math.sin(pitch)
    const sy = Math.sin(yaw)
    const cy = Math.cos(yaw)
    // 视线与相机上方向（roll=0，地平线水平）
    const dx = sy * cp
    const dy = sp
    const dz = -cy * cp
    const ux = -sp * sy
    const uy = cp
    const uz = sp * cy

    // 机位：云台按视觉缩放后的安装位置，正好落在镜头处
    const scale = this.drone?.scale ?? this.config.droneScale
    const fwdOff = CesiumScene.GIMBAL_FWD * scale
    const downOff = CesiumScene.GIMBAL_DOWN * scale
    const lx = this.bodyPos[0] + fwdX * fwdOff - upX * downOff
    const ly = this.bodyPos[1] + fwdY * fwdOff - upY * downOff
    const lz = this.bodyPos[2] + fwdZ * fwdOff - upZ * downOff

    this.fpvPos.x = this.origin.x + this.east.x * lx + this.up.x * ly - this.north.x * lz
    this.fpvPos.y = this.origin.y + this.east.y * lx + this.up.y * ly - this.north.y * lz
    this.fpvPos.z = this.origin.z + this.east.z * lx + this.up.z * ly - this.north.z * lz

    this.fpvDir.x = this.east.x * dx + this.up.x * dy - this.north.x * dz
    this.fpvDir.y = this.east.y * dx + this.up.y * dy - this.north.y * dz
    this.fpvDir.z = this.east.z * dx + this.up.z * dy - this.north.z * dz
    this.fpvUp.x = this.east.x * ux + this.up.x * uy - this.north.x * uz
    this.fpvUp.y = this.east.y * ux + this.up.y * uy - this.north.y * uz
    this.fpvUp.z = this.east.z * ux + this.up.z * uy - this.north.z * uz

    // 坠毁：从镜头里看火球只剩一片橙红。改成从残骸斜上方俯视 ——
    // 楼群里贴着街面后撤很容易被邻楼墙面糊住，抬高反而一定看得见火球。
    if (this.crashCamT > 0.001) {
      const k = 1 - (1 - this.crashCamT) * (1 - this.crashCamT)
      this.fpvTarget.x = this.fpvPos.x
      this.fpvTarget.y = this.fpvPos.y
      this.fpvTarget.z = this.fpvPos.z
      // 机头水平方向 (sin h, 0, -cos h)：后退一点、抬高，形成约 75° 俯角
      const back = 7 * k
      const cx = lx - Math.sin(heading) * back
      const cy = ly + 26 * k
      const cz = lz + Math.cos(heading) * back
      this.fpvPos.x = this.origin.x + this.east.x * cx + this.up.x * cy - this.north.x * cz
      this.fpvPos.y = this.origin.y + this.east.y * cx + this.up.y * cy - this.north.y * cz
      this.fpvPos.z = this.origin.z + this.east.z * cx + this.up.z * cy - this.north.z * cz
      Cesium.Cartesian3.subtract(this.fpvTarget, this.fpvPos, this.fpvDir)
      Cesium.Cartesian3.normalize(this.fpvDir, this.fpvDir)
      // 近乎垂直俯视时不能用 ENU 上方向（与视线共线），改用正北做画面上方
      Cesium.Cartesian3.clone(this.north, this.fpvUp)
    }

    const camera = this.viewer.camera
    // 必须先清掉 lookAt 留下的变换，否则 setView 的位置会被上一次的局部坐标系解释
    camera.lookAtTransform(Cesium.Matrix4.IDENTITY)
    camera.setView({
      destination: this.fpvPos,
      orientation: { direction: this.fpvDir, up: this.fpvUp },
    })
  }

  private applyFov(): void {
    const frustum = this.viewer.camera.frustum as CesiumNS.PerspectiveFrustum
    if (!('fov' in frustum)) return
    // 云台视角用广角，贴近运动相机的观感；退出时还原常规 60°
    frustum.fov = this.followMode === 'fpv' ? Cesium.Math.toRadians(76) : this.baseFov
  }

  setFollowMode(mode: FollowMode): void {
    this.followMode = mode
    const controller = this.viewer.scene.screenSpaceCameraController
    if (mode === 'free') {
      controller.enableInputs = true
      this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY)
    } else {
      controller.enableInputs = false
    }
    this.applyFov()
    this.applyDroneVisibility()
    this.applyAirflowVisibility()
  }

  /**
   * 恢复自由视角的手动输入。
   *
   * Cesium 的 camera.flyTo 会在飞行期间把 enableInputs 关掉、结束时再打开，
   * 所以配置页的预览动画结束后必须补一次 —— 否则用户会觉得地球突然拖不动了。
   * 只有仍处于自由视角时才恢复：飞行页的跟随机位必须保持「输入关闭」。
   */
  private restoreFreeInputs(): void {
    if (this.followMode !== 'free') return
    this.viewer.scene.screenSpaceCameraController.enableInputs = true
  }

  setFollowDistance(distance: number): void {
    this.followDistance = Math.min(220, Math.max(3, distance))
  }

  zoomBy(deltaY: number): void {
    this.setFollowDistance(this.followDistance * (1 + deltaY * 0.0012))
  }

  setDroneScale(scale: number): void {
    this.config.droneScale = scale
    if (this.drone) this.drone.scale = scale
  }

  // —— 飞行轨迹 ——
  /** 按固定间隔采样机体位置；原地悬停不重复记点，避免顶点暴涨 */
  private sampleTrail(dt: number): void {
    if (!this.trailRecording || dt <= 0) return
    this.trailClock += dt
    if (this.trailClock < CesiumScene.TRAIL_SAMPLE_SEC) return
    this.trailClock = 0

    const last = this.trailPoints[this.trailPoints.length - 1]
    if (last && Cesium.Cartesian3.distance(last, this.droneECEF) < CesiumScene.TRAIL_MIN_STEP_M) return
    this.trailPoints.push(Cesium.Cartesian3.clone(this.droneECEF))
    if (this.trailPoints.length > CesiumScene.TRAIL_MAX_POINTS) this.trailPoints.shift()
    if (this.trailPoints.length < 2) return

    if (!this.trailLine) {
      this.trailLine = this.trail.add({
        positions: this.trailPoints.slice(),
        width: this.trailWidth,
        show: this.trailVisible,
        material: this.trailMaterial(),
      })
    } else {
      // 必须整体赋值：顶点数变化才会触发顶点缓冲重建
      this.trailLine.positions = this.trailPoints.slice()
    }
  }

  /** 轨迹材质：配置页可选颜色 */
  private trailMaterial(): CesiumNS.Material {
    const c = Cesium.Color.fromCssColorString(this.trailColor)
    return Cesium.Material.fromType('Color', {
      color: (c ?? Cesium.Color.fromCssColorString('#5ad1ff')).withAlpha(0.78),
    })
  }

  /** 轨迹颜色（十六进制，如 #5ad1ff） */
  setTrailColor(hex: string): void {
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return
    this.trailColor = hex
    if (this.trailLine) this.trailLine.material = this.trailMaterial()
  }

  /** 轨迹线宽（像素） */
  setTrailWidth(width: number): void {
    this.trailWidth = Math.min(8, Math.max(1, width))
    if (this.trailLine) this.trailLine.width = this.trailWidth
  }

  get trailStyle(): { color: string; width: number } {
    return { color: this.trailColor, width: this.trailWidth }
  }

  setTrailVisible(visible: boolean): void {
    this.trailVisible = visible
    this.trail.show = visible
  }

  setTrailRecording(recording: boolean): void {
    this.trailRecording = recording
    this.trailClock = 0
  }

  clearTrail(): void {
    if (this.trailLine) {
      this.trail.remove(this.trailLine)
      this.trailLine = null
    }
    this.trailPoints = []
    this.trailClock = 0
  }

  get trailStats(): { points: number; recording: boolean; visible: boolean } {
    return {
      points: this.trailPoints.length,
      recording: this.trailRecording,
      visible: this.trailVisible,
    }
  }

  /** 加载本地 OSM 建筑 GeoJSON，按高度拉伸为三维城市 */
  async loadBuildings(url: string): Promise<number> {
    const ds = await Cesium.GeoJsonDataSource.load(url, {
      clampToGround: false,
      stroke: Cesium.Color.TRANSPARENT,
      fill: Cesium.Color.WHITE,
    })
    // 快照：下面会往同一集合里追加屋顶实体，直接迭代 live 数组会无限增长
    const entities = [...ds.entities.values]
    const low = srgb('#7b8794')
    const high = srgb('#c8d0d7')
    const roofEntities: CesiumNS.Entity[] = []

    for (const entity of entities) {
      const props = entity.properties
      const height = Number(props?.height?.getValue() ?? 12)
      const name = String(props?.name?.getValue() ?? '')
      const t = Math.min(1, Math.max(0, Math.log10(Math.max(height, 6) / 6) / Math.log10(528 / 6)))
      const base = Cesium.Color.lerp(low, high, t, new Cesium.Color())
      // 逐栋微调明度，避免相邻体块糊成一片
      let h = 0
      for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 997
      const vary = 0.93 + ((h + Math.round(height)) % 9) * 0.018
      const color = new Cesium.Color(
        Math.min(1, base.red * vary),
        Math.min(1, base.green * vary),
        Math.min(1, base.blue * vary),
        1,
      )

      if (entity.polygon) {
        entity.polygon.height = new Cesium.ConstantProperty(0)
        entity.polygon.extrudedHeight = new Cesium.ConstantProperty(height)
        entity.polygon.material = new Cesium.ColorMaterialProperty(color)
        entity.polygon.outline = new Cesium.ConstantProperty(false)
      }
      entity.description = undefined

      const hierarchy = entity.polygon?.hierarchy?.getValue(Cesium.JulianDate.now())
      const positions = hierarchy?.positions ?? []

      // 楼体碰撞体：ECEF → 局部米制（x=东，z=南），供刚体碰撞解算
      if (positions.length >= 3) {
        const ring: number[] = []
        const rel = new Cesium.Cartesian3()
        for (const p of positions) {
          Cesium.Cartesian3.subtract(p, this.origin, rel)
          ring.push(Cesium.Cartesian3.dot(rel, this.east), -Cesium.Cartesian3.dot(rel, this.north))
        }
        this.collision.add(ring, Math.max(3, height), name)
      }

      // 屋顶盖：Cesium 不给多边形打光，用一层略亮的顶面把「屋顶」和「墙面」区分开
      if (positions.length >= 3) {
        roofEntities.push(
          new Cesium.Entity({
            polygon: {
              hierarchy: new Cesium.PolygonHierarchy(positions),
              height: new Cesium.ConstantProperty(height + 0.15),
              material: new Cesium.ColorMaterialProperty(
                new Cesium.Color(
                  Math.min(1, color.red * 1.14 + 0.015),
                  Math.min(1, color.green * 1.14 + 0.015),
                  Math.min(1, color.blue * 1.12 + 0.015),
                  1,
                ),
              ),
              outline: false,
            },
          }),
        )
      }

      if (name && height >= 200) {
        entity.label = new Cesium.LabelGraphics({
          text: name,
          font: '600 13px "Microsoft YaHei", sans-serif',
          fillColor: Cesium.Color.fromCssColorString('#f3f7fa'),
          outlineColor: Cesium.Color.fromCssColorString('#16212c'),
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -10),
          scaleByDistance: new Cesium.NearFarScalar(300, 1.0, 4000, 0.7),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(300, 4500),
          disableDepthTestDistance: 0,
        })
        // 标签需要独立锚点：把实体位置抬到楼顶
        if (positions.length > 0) {
          const sum = new Cesium.Cartesian3()
          for (const p of positions) Cesium.Cartesian3.add(sum, p, sum)
          Cesium.Cartesian3.divideByScalar(sum, positions.length, sum)
          const anchor = Cesium.Cartesian3.add(
            sum,
            Cesium.Cartesian3.multiplyByScalar(this.up, height + 6, new Cesium.Cartesian3()),
            new Cesium.Cartesian3(),
          )
          entity.position = new Cesium.ConstantPositionProperty(anchor)
        }
      }
    }

    // 屋顶实体一次性并入（不参与显隐开关的计数）
    for (const roof of roofEntities) ds.entities.add(roof)

    await this.viewer.dataSources.add(ds)
    this.buildings = ds
    this.buildingCount = entities.length
    this.collision.build()
    return this.buildingCount
  }

  get buildingsCount(): number {
    return this.buildingCount
  }

  setBuildingsVisible(show: boolean): void {
    this.buildingsOn = show
    if (this.buildings) this.buildings.show = show
    if (this.buildingPrimitive) this.buildingPrimitive.show = show
    if (this.buildingLabels) this.buildingLabels.show = show
  }

  /** 当前起飞点（场景原点）经纬度 */
  get originLonLat(): [number, number] {
    return [this.config.lon, this.config.lat]
  }

  /**
   * 把场景原点搬到新坐标：重算 ENU 基、清空旧建筑与轨迹。
   * 无人机本体由 useDroneSim 负责复位（它持有刚体）。
   */
  /** 建地形。失败就退回椭球：没有高程也能飞，只是山还是平的 */
  private async initTerrain(): Promise<void> {
    if (!this.config.terrain) return
    try {
      const provider = await Promise.race([
        Cesium.ArcGISTiledElevationTerrainProvider.fromUrl(ARCGIS_TERRAIN),
        new Promise<never>((_, reject) =>
          window.setTimeout(() => reject(new Error('地形服务超时')), 9000),
        ),
      ])
      this.terrain = provider
      this.viewer.terrainProvider = provider
    } catch (err) {
      console.warn('[cesium] 全球高程不可用，退回椭球地形（地形没有起伏）', err)
    }
  }

  /** 采样某点的地形高程（米）；无地形或采样失败按 0（椭球面）处理 */
  private async sampleGround(lon: number, lat: number): Promise<number> {
    await this.terrainReady
    const terrain = this.terrain
    if (!terrain) return 0
    const carto = Cesium.Cartographic.fromDegrees(lon, lat)
    // mostDetailed 会按 provider 的 availability 一路往下细分，个别区域会拒答；
    // 退到固定 13 / 11 级（约 20 m / 75 m 格网）也远好过 0 —— 0 意味着原点落回椭球面，整机埋进山里
    const tries = [
      () => Cesium.sampleTerrainMostDetailed(terrain, [carto]),
      () => Cesium.sampleTerrain(terrain, 13, [carto]),
      () => Cesium.sampleTerrain(terrain, 11, [carto]),
    ]
    for (const run of tries) {
      try {
        const [hit] = await run()
        const h = hit?.height
        if (Number.isFinite(h)) return h as number
      } catch {
        /* 换下一档 */
      }
    }
    return 0
  }

  // ————————————————————————————————————————————
  // 地形碰撞：把「地面高度 + 地表法向」提供给物理层
  // ————————————————————————————————————————————

  /** 地形碰撞总开关。关掉后物理层退回常数平面（老行为） */
  setTerrainCollision(on: boolean): void {
    this.terrainCollisionOn = on
    this.normalCache.clear()
    this.heightCache.clear()
  }

  get terrainCollision(): boolean {
    return this.terrainCollisionOn
  }

  /** 是否有真实高程可用（false = 地面是常数平面，撞上去该说「地面」而不是「山体」） */
  get hasTerrain(): boolean {
    return this.terrain !== null
  }

  /**
   * 取局部水平位置 (x,z) 的地面高度（米，相对原点地表）。
   *
   * 两条路径：
   *   1) globe.getHeight() —— 与画面上看到的地形完全一致（同一套瓦片插值），
   *      但瓦片没加载到该点时返回 undefined。
   *   2) 高度场缓存 —— 异步预取好的网格，保证瓦片没加载也知道地形走向。
   *
   * 性能：globe.getHeight() 单次约 4.5 ms（内部要遍历已加载瓦片列表做高程插值），
   * 而物理层每子步要问 9 次、每帧 12 子步 —— 不缓存的话一帧要 480 ms，直接把帧率打死。
   * 所以按 4 m 量化缓存：无人机 20 m/s 时同一格能复用约 50 次，命中率 > 95%。
   */
  groundHeightAt(x: number, z: number): number {
    if (!this.terrainCollisionOn) return 0
    // 没有真实高程 provider 时，Cesium 用的是椭球地形 —— 那就没有「地面起伏」可言，
    // 地面就是常数平面。
    if (!this.terrain) return 0
    const q = 4
    const key = (Math.round(x / q) * 73856093) ^ (Math.round(z / q) * 19349663)
    const cached = this.heightCache.get(key)
    if (cached !== undefined) return cached
    const ll = localToLonLat(this.config.lon, this.config.lat, x, z)
    const h = this.viewer.scene.globe.getHeight(
      Cesium.Cartographic.fromDegrees(ll.lon, ll.lat),
    )
    // 合理性校验：椭球地形下 globe.getHeight() 会返回 -64000 m 这种无意义值
    // （它是相对球面半径算的，不是相对大地水准面），不挡住就会把地面放到 -64 km 处。
    // 真实椭球高程落在 -500 ~ 9000 m（死海到珠峰），边界留宽一点。
    const plausible = h !== undefined && Number.isFinite(h) && h > -1200 && h < 12000
    const v = plausible ? (h as number) - this.groundElevation : this.terrainField.heightAt(x, z)
    if (this.heightCache.size > 20000) this.heightCache.clear()
    this.heightCache.set(key, v)
    return v
  }

  /**
   * 取局部水平位置 (x,z) 的地表法向（单位向量，y 为正、指向地表外侧）。
   * 由地形梯度中心差分求得，并按 12 m 量化缓存 —— 物理层每个子步都要问一次，
   * 不缓存的话会变成每帧几十次瓦片查表。
   */
  groundNormalAt(x: number, z: number): [number, number, number] | null {
    if (!this.terrainCollisionOn) return null
    // 没有真实高程 → 地面是平的，法向恒为竖直向上
    if (!this.terrain) return [0, 1, 0]
    const q = 12
    const key = (Math.round(x / q) * 73856093) ^ (Math.round(z / q) * 19349663)
    const cached = this.normalCache.get(key)
    if (cached) return cached
    const d = 25
    const dhdx = (this.groundHeightAt(x + d, z) - this.groundHeightAt(x - d, z)) / (2 * d)
    const dhdz = (this.groundHeightAt(x, z + d) - this.groundHeightAt(x, z - d)) / (2 * d)
    const nx = -dhdx
    const ny = 1
    const nz = -dhdz
    const len = Math.hypot(nx, ny, nz) || 1
    const n: [number, number, number] = [nx / len, ny / len, nz / len]
    if (this.normalCache.size > 4000) this.normalCache.clear()
    this.normalCache.set(key, n)
    return n
  }

  /**
   * 以无人机为中心滚动重采样地形高度场。
   * 机体飞出当前覆盖范围时调用（异步，不阻塞物理）。
   */
  private refreshTerrainField(x: number, z: number): void {
    if (!this.terrainCollisionOn || !this.terrain) return
    if (this.terrainField.busy) return
    const moved = Math.hypot(x - this.terrainSampleAt.x, z - this.terrainSampleAt.z)
    if (moved < 120) return
    this.terrainSampleAt = { x, z }
    this.terrainField.recenter(x, z)
    void this.terrainField
      .sample(this.terrain, this.config.lon, this.config.lat, this.groundElevation)
      .then(() => {
        this.normalCache.clear()
        this.heightCache.clear()
      })
  }

  /**
   * 搬场景原点。地形采样是异步的，所以这里也改成异步：
   * 必须等高程回来再定 origin，否则首帧按椭球高度摆飞机，地形一接上就整个人埋进山里。
   *
   * seq 是切换请求序号：并发切场景时（用户连点城市、或启动 IP 定位迟到），
   * 只有序号最新的那次才允许落地 —— 否则「采样慢的旧请求」会把「采样快的新请求」顶掉，
   * 场景停在一个用户根本没选过的城市。
   * 返回 false 表示这次请求已过期，调用方应放弃后续动作。
   */
  async setOrigin(
    lon: number,
    lat: number,
    height = this.config.height,
    seq?: number,
    opts: { keepCamera?: boolean } = {},
  ): Promise<boolean> {
    if (seq !== undefined) {
      if (seq < this.originSeq) return false
      this.originSeq = seq
    }
    const ground = await this.sampleGround(lon, lat)
    // 采样是网络往返，这期间可能又来了更新的请求 —— 过期的结果直接丢弃
    if (seq !== undefined && seq !== this.originSeq) return false
    this.groundElevation = ground
    this.config.lon = lon
    this.config.lat = lat
    this.config.height = height

    this.origin = Cesium.Cartesian3.fromDegrees(lon, lat, ground + height)
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(this.origin)
    this.east = new Cesium.Cartesian3(enu[0], enu[1], enu[2])
    this.north = new Cesium.Cartesian3(enu[4], enu[5], enu[6])
    this.up = new Cesium.Cartesian3(enu[8], enu[9], enu[10])

    this.clearBuildings()
    this.clearTrail()
    this.resetEffects()
    // 光照方向绑在原点 ENU 上，换城市必须重算
    this.updateSunLight()

    // 地形碰撞：先把高度场灌满，否则刚起飞那几秒机体脚下的地形是未知高度，
    // 会把山谷误判成 y=0 的平面而误触解体。
    // 加超时兜底 —— 地形服务不可用时不能把场景卡住（ready 是调用方的入口）。
    this.normalCache.clear()
    this.heightCache.clear()
    this.terrainSampleAt = { x: 0, z: 0 }
    this.terrainField.recenter(0, 0)
    if (this.terrain) {
      await Promise.race([
        this.terrainField.sample(this.terrain, lon, lat, ground),
        new Promise<boolean>((r) => window.setTimeout(() => r(false), 8000)),
      ])
    }

    // 先给一个整体视角，建筑加载完再交给跟随相机。
    // 配置页切点时不能动镜头（keepCamera）—— 视角过渡要由用户点「开始飞行」时统一做。
    if (!opts.keepCamera) {
      this.viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(lon, lat + 0.009, ground + 1150),
        orientation: { heading: 0, pitch: Cesium.Math.toRadians(-24), roll: 0 },
      })
    }
    return true
  }

  // ————————————————————————————————————————————
  // 配置页：起飞点预览
  // ————————————————————————————————————————————

  /**
   * 俯视全景：相机放到目标点北侧高空，看向目标点。
   * 方向用 direction/up 表达而不是 heading/pitch ——
   * 后者要按「相机在哪、朝哪看」和「目标在哪」两层角度手算，很容易差半个身位。
   */
  previewCamera(lon: number, lat: number, elevation = 950, northOffset = 620, duration = 1.6): void {
    const ground = this.groundElevation
    const target = Cesium.Cartesian3.fromDegrees(lon, lat, ground)
    const camPos = Cesium.Cartesian3.fromDegrees(
      lon,
      lat + northOffset / 111320,
      ground + elevation,
    )
    const dir = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.subtract(target, camPos, new Cesium.Cartesian3()),
      new Cesium.Cartesian3(),
    )
    // 相机的 up 用所在位置的径向方向（近似当地天顶）
    const up = Cesium.Cartesian3.normalize(camPos, new Cesium.Cartesian3())
    this.viewer.camera.flyTo({
      destination: camPos,
      orientation: { direction: dir, up },
      duration,
      complete: () => this.restoreFreeInputs(),
      cancel: () => this.restoreFreeInputs(),
    })
  }

  /** 在地表标出配置页选中的起飞点 */
  setPreviewMarker(lon: number, lat: number, label = ''): void {
    this.clearPreviewMarker()
    const height = this.groundElevation + 0.5
    this.viewer.entities.add({
      id: CesiumScene.PREVIEW_MARKER_ID,
      position: Cesium.Cartesian3.fromDegrees(lon, lat, height),
      point: {
        pixelSize: 13,
        color: Cesium.Color.fromCssColorString('#5ad1ff'),
        outlineColor: Cesium.Color.fromCssColorString('#07131d'),
        outlineWidth: 2,
        // 标记要穿透地形可见：山体另一侧也能看到选点
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: label,
        font: '600 13px "Microsoft YaHei", sans-serif',
        fillColor: Cesium.Color.fromCssColorString('#eaf6ff'),
        outlineColor: Cesium.Color.fromCssColorString('#07131d'),
        outlineWidth: 4,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -18),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    })
  }

  clearPreviewMarker(): void {
    const e = this.viewer.entities.getById(CesiumScene.PREVIEW_MARKER_ID)
    if (e) this.viewer.entities.remove(e)
  }

  /** 把机体摆到当前原点的地表位置（配置页预览用，不启动物理） */
  placeDroneAtGround(): void {
    if (!this.drone) return
    this.updateDrone([0, 0.4, 0], [0, 0, 0, 1], 0)
  }

  /**
   * 从配置视角过渡进入飞行视角：镜头从当前位置推到追尾机位，再交回跟随相机。
   *
   * 实现上先借用 Cesium 自己的 lookAt 几何摆出追尾位姿，把相机的世界位姿抄下来，
   * 再用 flyTo 飞过去 —— 手推 ENU 偏移很容易和 Cesium 的航向定义差 90°。
   *
   * 过渡期间 followMode 暂置 'free'：跟随相机每帧 lookAt，会跟 flyTo 抢镜头。
   */
  async flyIntoFlight(opts: { duration?: number; mode?: FollowMode } = {}): Promise<boolean> {
    if (!this.drone) return false
    const duration = opts.duration ?? 2.6
    const mode = opts.mode ?? this.followMode
    const target = Cesium.Cartesian3.clone(this.droneECEF)
    if (Cesium.Cartesian3.magnitude(target) < 1e6) return false

    // 1. 追尾位姿：参数与 updateCamera 保持一致
    const hpr = this.followHpr
    hpr.heading = mode === 'chase' ? -this.lastYaw : this.fixedHeading
    hpr.pitch = this.followPitch
    hpr.range = this.followDistance
    this.viewer.camera.lookAt(target, hpr)
    const dest = Cesium.Cartesian3.clone(this.viewer.camera.positionWC)
    const dir = Cesium.Cartesian3.clone(this.viewer.camera.directionWC)
    const up = Cesium.Cartesian3.clone(this.viewer.camera.upWC)
    this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY)

    // 2. 过渡期间不跟随：跟随相机每帧 lookAt，会跟 flyTo 抢镜头。
    //    Cesium 的 flyTo 自己会关掉手动输入，这里不再重复关。
    this.followMode = 'free'
    const ok = await new Promise<boolean>((resolve) => {
      this.viewer.camera.flyTo({
        destination: dest,
        orientation: { direction: dir, up },
        duration,
        complete: () => resolve(true),
        cancel: () => resolve(false),
      })
    })

    // 3. 交回跟随相机（用正式入口：顺带把手动输入按新模式恢复/关闭）
    this.setFollowMode(mode)
    this.snapCamera(this.lastYaw)
    return ok
  }

  /** 清空建筑渲染物与碰撞体 */
  clearBuildings(): void {
    if (this.buildingPrimitive) {
      this.viewer.scene.primitives.remove(this.buildingPrimitive)
      this.buildingPrimitive = null
    }
    if (this.buildingLabels) {
      this.viewer.scene.primitives.remove(this.buildingLabels)
      this.buildingLabels = null
    }
    if (this.buildings) {
      this.viewer.dataSources.remove(this.buildings, true)
      this.buildings = null
    }
    this.buildingData = []
    this.buildingCount = 0
    this.collision.clear()
  }

  /**
   * 围绕 (lon, lat) 实时生成 3D 城市。
   *
   * 用 Primitive + PerInstanceColorAppearance(flat:false)：几何自带法线，
   * 会被 scene.light 照亮 —— 南墙亮、北墙暗、屋顶最亮，这是「真 3D」的关键。
   * 之前用 Entity 的 extruded polygon，Cesium 一律平涂，看着就是一摞色块。
   */
  async loadBuildingsAt(
    lon: number,
    lat: number,
    radius = 950,
  ): Promise<{ count: number; tiles: number; error?: string }> {
    this.clearBuildings()
    let result: Awaited<ReturnType<typeof fetchBuildings>>
    try {
      result = await fetchBuildings(lon, lat, radius)
    } catch (err) {
      return { count: 0, tiles: 0, error: err instanceof Error ? err.message : String(err) }
    }

    const { list, tiles } = result
    if (!list.length) {
      return { count: 0, tiles, error: '该位置周边没有 3D 建筑（山区、水域或未测绘区域），仍可自由飞行' }
    }

    // 数量上限保护：按离原点的距离保留近处建筑，远处本来就看不见
    let picked = list
    if (picked.length > 2400) {
      picked = [...list]
        .sort((a, b) => {
          const da = Math.abs(a.ring[0]) + Math.abs(a.ring[1])
          const db = Math.abs(b.ring[0]) + Math.abs(b.ring[1])
          return da - db
        })
        .slice(0, 2400)
    }

    const base = this.config.height
    // 基色压在中灰：定向光会把朝光面提亮约 1.6 倍，基色太白就糊成一片纸板
    const low = srgb('#6d7886')
    const high = srgb('#c6cfd9')
    const instances: CesiumNS.GeometryInstance[] = []
    const labelSpecs: { x: number; z: number; h: number; text: string }[] = []
    const scratch = new Cesium.Cartesian3()

    for (const b of picked) {
      const positions: CesiumNS.Cartesian3[] = []
      for (let i = 0; i < b.ring.length; i += 2) {
        positions.push(
          Cesium.Cartesian3.clone(this.localToEcef(b.ring[i], base, b.ring[i + 1], scratch)),
        )
      }
      if (positions.length < 3) continue

      // 高度分档 + 按轮廓哈希微调，避免相邻体块糊成一片
      const t = Math.min(1, Math.max(0, Math.log10(Math.max(b.height, 6) / 6) / Math.log10(528 / 6)))
      const baseColor = Cesium.Color.lerp(low, high, t, new Cesium.Color())
      let hash = 0
      for (let i = 0; i < b.ring.length; i += 2) hash = (hash * 31 + Math.round(b.ring[i] * 7 + b.ring[i + 1] * 13)) % 997
      const h = Math.abs(hash)
      const vary = 0.92 + (h % 9) * 0.016
      // 色温分层：真实城区里玻璃幕墙、混凝土、砖石混在一起，
      // 全城一个色相看着就像未贴图的模型
      const warm = ((h >> 4) % 5) / 4
      const color = new Cesium.Color(
        Math.min(1, baseColor.red * vary * (1.03 + warm * 0.07)),
        Math.min(1, baseColor.green * vary * (1.0 + warm * 0.02)),
        Math.min(1, baseColor.blue * vary * (0.99 - warm * 0.08)),
        1,
      )

      const geometry = new Cesium.PolygonGeometry({
        polygonHierarchy: new Cesium.PolygonHierarchy(positions),
        height: base + b.minHeight,
        extrudedHeight: base + b.height,
        vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
      })
      // 退化多边形（自相交、几乎共线）剖分出来的包围球是 NaN，
      // 进了 Cesium 的可见性剔除会 new Array(NaN) 直接把渲染打停 —— 这里先试算一次再决定收不收
      const probe = Cesium.PolygonGeometry.createGeometry(geometry)
      const bs = probe?.boundingSphere
      if (
        !probe ||
        !bs ||
        !Number.isFinite(bs.radius) ||
        bs.radius <= 0 ||
        bs.radius > 4000 ||
        !Number.isFinite(bs.center.x) ||
        !Number.isFinite(bs.center.y) ||
        !Number.isFinite(bs.center.z)
      )
        continue

      instances.push(
        new Cesium.GeometryInstance({
          geometry,
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(color),
          },
          id: { name: b.name, height: b.height },
        }),
      )

      // 碰撞体：同一份轮廓，局部米制直接给刚体用
      this.collision.add(b.ring, base + b.height, b.name || '建筑')

      if (b.height >= 150 && b.name) {
        let cx = 0
        let cz = 0
        for (let i = 0; i < b.ring.length; i += 2) {
          cx += b.ring[i]
          cz += b.ring[i + 1]
        }
        const n = b.ring.length / 2
        labelSpecs.push({ x: cx / n, z: cz / n, h: base + b.height, text: b.name })
      }
    }

    const primitive = new Cesium.Primitive({
      geometryInstances: instances,
      appearance: new Cesium.PerInstanceColorAppearance({
        flat: false,
        closed: true,
        translucent: false,
      }),
      asynchronous: true,
      releaseGeometryInstances: true,
    })
    primitive.show = this.buildingsOn
    this.viewer.scene.primitives.add(primitive)
    this.buildingPrimitive = primitive

    if (labelSpecs.length) {
      const labels = new Cesium.LabelCollection()
      for (const l of labelSpecs) {
        labels.add({
          position: this.localToEcef(l.x, l.h + 8, l.z, new Cesium.Cartesian3()),
          text: l.text,
          // 13px + 3px 描边在 2 km 外只剩一团黑斑：放大字号、收描边，并让它在远处淡出
          font: '600 15px "Microsoft YaHei", sans-serif',
          fillColor: Cesium.Color.fromCssColorString('#f3f7fa'),
          outlineColor: Cesium.Color.fromCssColorString('#16212c'),
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          scaleByDistance: new Cesium.NearFarScalar(300, 1.0, 2400, 0.85),
          translucencyByDistance: new Cesium.NearFarScalar(1600, 1.0, 3200, 0.0),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(200, 3200),
          disableDepthTestDistance: 0,
        })
      }
      labels.show = this.buildingsOn
      this.viewer.scene.primitives.add(labels)
      this.buildingLabels = labels
    }

    this.buildingData = picked
    this.buildingCount = instances.length
    this.collision.build()
    return { count: this.buildingCount, tiles }
  }

  /** 已加载的建筑数量与轮廓（自检/调试用） */
  get buildingsData(): readonly BuildingFootprint[] {
    return this.buildingData
  }

  /**
   * 切换底图。天地图用「底图 + 注记」两层：
   * 影像 img_w 配 cia_w（影像注记），矢量 vec_w 配 cva_w（矢量注记），地形 ter_w 配 cia_w。
   */
  async setImagery(kind: ImageryKind): Promise<void> {
    // 连点不同底图时只认最后一次：Google 3D 要发网络请求，几百毫秒后回来时可能已经切走了
    const seq = ++this.imagerySeq
    const layers = this.viewer.imageryLayers
    layers.removeAll()
    this.labelLayer = null
    this.disposeGoogle3d()
    this.imageryKind = kind
    if (kind === 'google-3d') {
      await this.applyGoogle3d(seq)
      return
    }

    if (kind === 'tianditu' || kind === 'tianditu-vec' || kind === 'tianditu-ter') {
      const base: TdtLayer = kind === 'tianditu' ? 'img' : kind === 'tianditu-vec' ? 'vec' : 'ter'
      const label: TdtLayer = kind === 'tianditu-vec' ? 'cva' : 'cia'
      layers.addImageryProvider(tiandituProvider(base))
      // 注记层只叠在上面，不参与拾取与地形深度
      this.labelLayer = layers.addImageryProvider(tiandituProvider(label))
      // 天地图对单 key 有并发限流，被限时整屏瓦片全是 429 → 探测一次，挂了自动回退 Esri
      void this.ensureTianditu(base)
      return
    }

    if (kind === 'esri' || kind === 'esri-street') {
      // Esri 的 MapServer 在深层瓦片未生成 / 该区域无该级别数据时，
      // 返回的是一张写着 "Map data not yet available" 的灰底图（HTTP 200），
      // Cesium 会当正常瓦片贴上去并永久缓存 —— 这就是飞行中突然出现大灰块的原因。
      // 卫星影像垫一层 11 级兜底 + 用带占位检测的包装层，街道图没有这个毛病。
      if (kind === 'esri') layers.addImageryProvider(createEsriBaseLayer(ESRI_IMAGERY))
      layers.addImageryProvider(createEsriImagery(kind === 'esri' ? ESRI_IMAGERY : ESRI_STREET, 19))
      // Esri 纯影像没有地名，境内再叠一层天地图中文注记。
      // 但这枚公共 key 的配额经常被打死（实测直接 curl 就 429），
      // 所以先探一张再决定挂不挂 —— 挂不上就安静地退回纯影像，不往控制台刷几十条 429
      if (kind === 'esri') void this.attachCjkLabels()
      return
    }
  }

  /**
   * 切到 Google Photorealistic 3D Tiles（摄影测量实景）。
   *
   * 它自己带建筑立面与地形贴图，所以这里做三件事：
   *   1. 收起本地 OSM 体块 —— 否则素色方块会从实景楼里穿出来；
   *   2. 清掉 globe 影像层（setImagery 已清），未覆盖区域露出深色底，看得出是「没有数据」；
   *   3. 加载失败或超时就回落 Esri，并把原因交给面板显示。
   */
  private async applyGoogle3d(seq: number): Promise<void> {
    // 没 key 就立刻回落，不要先动建筑开关 —— 否则画面会闪一下
    if (!GOOGLE_MAPS_KEY) {
      this.fallbackFromGoogle3d('未配置 VITE_GOOGLE_MAPS_KEY')
      return
    }
    // 记住用户原本的建筑开关，退出实景时原样还原
    if (this.buildingPref3d === null) {
      this.buildingPref3d = this.buildingsOn
      this.setBuildingsVisible(false)
      this.onBuildingsSync?.(false)
    }
    try {
      const load = Cesium.createGooglePhotorealistic3DTileset({ key: GOOGLE_MAPS_KEY })
      const tileset = await Promise.race([
        load,
        // 境内 tile.googleapis.com 不通时不会立刻报错，只会一直挂着，必须自己掐表
        new Promise<never>((_, reject) => {
          window.setTimeout(() => reject(new Error('请求超时（境内需代理）')), 15000)
        }),
      ])
      if (seq !== this.imagerySeq) {
        tileset.destroy()
        return
      }
      // 摄影测量网格：SSE 16 在几十米高度看楼已经够细，再往上堆只会爆显存
      tileset.maximumScreenSpaceError = 16
      // 实景贴图自带烘焙光照，再叠 Cesium 阴影会与本地太阳方向打架，出双层阴影
      tileset.shadows = Cesium.ShadowMode.DISABLED
      this.viewer.scene.primitives.add(tileset)
      this.googleTileset = tileset
    } catch (err) {
      if (seq !== this.imagerySeq) return
      this.fallbackFromGoogle3d(err instanceof Error ? err.message : String(err))
    }
  }

  private fallbackFromGoogle3d(reason: string): void {
    console.warn('[cesium] Google 3D 实景不可用，回落 Esri 卫星：', reason)
    void this.setImagery('esri').then(() => this.onImageryFallback?.('esri', reason))
  }

  /** 卸掉 Google 实景并把建筑开关还原（幂等，切任何底图都会先走一遍） */
  private disposeGoogle3d(): void {
    if (this.googleTileset) {
      this.viewer.scene.primitives.remove(this.googleTileset)
      this.googleTileset = null
    }
    if (this.buildingPref3d !== null) {
      const pref = this.buildingPref3d
      this.buildingPref3d = null
      this.setBuildingsVisible(pref)
      this.onBuildingsSync?.(pref)
    }
  }

  /**
   * 给 Esri 卫星影像补中文注记：只在天地图真的能出图、且起飞点在境内时才叠。
   * rectangle 只能在 ImageryLayer 构造时给（类型上是只读的），不能事后赋值。
   */
  private async attachCjkLabels(): Promise<void> {
    const kind = this.imageryKind
    if (!(await this.probeTianditu('cia'))) return
    // 探测要几百毫秒，期间用户可能又切了底图
    if (this.imageryKind !== kind) return
    const label = new Cesium.ImageryLayer(tiandituProvider('cia'), {
      rectangle: Cesium.Rectangle.fromDegrees(73, 17, 135, 54),
    })
    this.labelLayer = label
    this.viewer.imageryLayers.add(label)
  }

  /** 底图不可用需要回落时通知 UI：同步按钮状态，并把原因显示在面板上 */
  onImageryFallback: ((kind: ImageryKind, reason?: string) => void) | null = null

  /**
   * 探测天地图是否真的能出图：单 key 被限流时 Cesium 只会不断 429，
   * 地面就一直停在纯色兜底上，观感比换一家底图差得多。
   * 另外境外区域返回的是白底占位图，content-type 同样是 image/png，
   * 所以先按当前起飞点做覆盖判断，再发瓦片请求。
   */
  private async probeTianditu(layer: TdtLayer): Promise<boolean> {
    const [lon, lat] = this.originLonLat
    if (!tdtHasCoverage(lon, lat)) return false
    const base =
      `https://t0.tianditu.gov.cn/${layer}_w/wmts?SERVICE=WMTS&REQUEST=GetTile` +
      '&VERSION=1.0.0' +
      `&LAYER=${layer}&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles`
    // 三张不同瓦片轮询，避免单张恰好被限流而误判
    const probes: [number, number, number][] = [
      [53970, 24833, 16],
      [53971, 24834, 16],
      [107940, 49666, 17],
    ]
    for (const [x, y, z] of probes) {
      try {
        const r = await fetch(`${base}&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}&tk=${TIANDITU_KEY}`)
        if (r.ok && (r.headers.get('content-type') ?? '').startsWith('image/')) return true
      } catch {
        // 网络错误同样按不可用处理，继续试下一张
      }
    }
    return false
  }

  private async ensureTianditu(layer: TdtLayer): Promise<void> {
    const kind = this.imageryKind
    if (!kind.startsWith('tianditu')) return
    const ok = await this.probeTianditu(layer)
    // 探测期间用户可能已手动切走，别把选择抢回来
    if (ok || !this.imageryKind.startsWith('tianditu')) return
    await this.setImagery('esri')
    this.onImageryFallback?.('esri')
  }

  /** 起飞点搬走后重新判断底图：之前在境内、现在到境外时必须从天地图切到 Esri */
  recheckImagery(): void {
    const kind = this.imageryKind
    if (!kind.startsWith('tianditu')) return
    const base: TdtLayer = kind === 'tianditu' ? 'img' : kind === 'tianditu-vec' ? 'vec' : 'ter'
    void this.ensureTianditu(base)
  }

  /** 可选：接入 Cesium ion 的全球三维建筑（需要访问令牌） */
  async enableIonBuildings(token: string): Promise<number> {
    Cesium.Ion.defaultAccessToken = token
    const tileset = await Cesium.createOsmBuildingsAsync()
    this.viewer.scene.primitives.add(tileset)
    this.ionTileset = tileset
    this.setBuildingsVisible(false)
    return 1
  }

  disableIonBuildings(): void {
    if (this.ionTileset) {
      this.viewer.scene.primitives.remove(this.ionTileset)
      this.ionTileset = null
    }
    this.setBuildingsVisible(true)
  }

  /** 让相机回到无人机后方（切换模式或复位时调用） */
  snapCamera(yawRad: number): void {
    this.updateCamera(yawRad)
  }

  /** 列出场景里每个 primitive 的包围球，用于定位 NaN 包围体导致的渲染中断 */
  debugPrimitives() {
    const prims = this.viewer.scene.primitives
    const out: { type: string; show: boolean; radius: number | null; cx: number | null }[] = []
    for (let i = 0; i < prims.length; i++) {
      const p = prims.get(i) as unknown as {
        constructor?: { name?: string }
        show?: boolean
        boundingSphere?: { radius: number; center: { x: number } }
        length?: number
      }
      const bs = p.boundingSphere
      out.push({
        type: p.constructor?.name ?? '?',
        show: p.show !== false,
        radius: bs ? bs.radius : null,
        cx: bs ? bs.center.x : null,
      })
    }
    return out
  }

  /** 供端到端自检读取的场景快照 */
  debugSnapshot() {
    const camera = this.viewer.camera.positionWC
    const globe = this.viewer.scene.globe
    // 私有用例：只用于自检判断「地表贴图是否已细化到可用层级」
    const rendered = (globe as unknown as { _surface?: { _tilesToRender?: { level: number }[] } })._surface
      ?._tilesToRender
    const levels = rendered ? rendered.map((t) => t.level) : []
    return {
      model: this.drone !== null,
      buildings: this.buildingCount,
      follow: this.followMode,
      gimbal: { pitch: this.gimbalPitchDeg, yaw: this.gimbalYawDeg },
      fov: Math.round(
        Cesium.Math.toDegrees(
          (this.viewer.camera.frustum as CesiumNS.PerspectiveFrustum).fov ?? this.baseFov,
        ),
      ),
      distance: Cesium.Cartesian3.distance(camera, this.droneECEF),
      camera: [camera.x, camera.y, camera.z] as [number, number, number],
      drone: [this.droneECEF.x, this.droneECEF.y, this.droneECEF.z] as [number, number, number],
      inputs: this.viewer.scene.screenSpaceCameraController.enableInputs,
      imagery: this.imageryKind,
      imageryLayers: this.viewer.imageryLayers.length,
      labelLayer: this.labelLayer !== null,
      trail: this.trailStats,
      origin: [this.config.lon, this.config.lat] as [number, number],
      buildingPrimitive: this.buildingPrimitive !== null,
      collision: { buildings: this.collision.buildings.length },
      airflow: { visible: this.airflowOn, count: this.airflow.count, sample: this.airflow.sample() },
      explosion: { active: this.explosion.isActive, particles: this.explosion.particleCount },
      droneVisible: this.drone ? this.drone.show : false,
      tileLevel: levels.length ? Math.max(...levels) : 0,
      tilesLoaded: globe.tilesLoaded,
    }
  }

  /** 等待地表瓦片细化到指定层级（自检/演示截图用），超时返回 false */
  async waitForGround(minLevel = 14, timeoutMs = 20_000): Promise<boolean> {
    const start = performance.now()
    while (performance.now() - start < timeoutMs) {
      if (this.debugSnapshot().tileLevel >= minLevel) return true
      await new Promise((r) => setTimeout(r, 300))
    }
    return false
  }

  /** 等待当前视角的瓦片全部加载完（尽力而为，超时返回 false） */
  async waitForTiles(timeoutMs = 15_000): Promise<boolean> {
    const start = performance.now()
    while (performance.now() - start < timeoutMs) {
      if (this.viewer.scene.globe.tilesLoaded) return true
      await new Promise((r) => setTimeout(r, 300))
    }
    return false
  }

  destroy(): void {
    this.pickHandler?.destroy()
    this.pickHandler = null
    this.drone = null
    this.buildings = null
    this.buildingPrimitive = null
    this.buildingLabels = null
    this.ionTileset = null
    this.googleTileset = null
    if (!this.viewer.isDestroyed()) this.viewer.destroy()
  }
}
