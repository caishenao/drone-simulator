// 飞行配置（配置页与飞行页共用的单一数据源）。
//
// 配置项落 localStorage：下次进来还是上次的机型与轨迹颜色，
// 免得每次都要重新点一遍。起飞点不在这里 —— 它跟着场景走，由 geo/locate 管理。

import { reactive, watch } from 'vue'
import type { FollowMode } from '../cesium/CesiumScene'

export interface FlightConfigState {
  /** 机型 id（见 config/droneTypes.ts） */
  droneTypeId: string
  /** 轨迹是否显示 */
  trailVisible: boolean
  /** 轨迹是否记录 */
  trailRecording: boolean
  /** 轨迹颜色（十六进制） */
  trailColor: string
  /** 轨迹线宽（像素） */
  trailWidth: number
  /** 进入飞行时的初始镜头 */
  followMode: FollowMode
  /** 音效总开关 */
  sound: boolean
}

const STORE_KEY = 'drone-sim.config'

export const DEFAULT_CONFIG: FlightConfigState = {
  droneTypeId: 'mini3pro',
  trailVisible: true,
  trailRecording: true,
  trailColor: '#5ad1ff',
  trailWidth: 2.4,
  followMode: 'chase',
  sound: true,
}

/** 可选轨迹色板（配置页色板按钮） */
export const TRAIL_COLORS: { value: string; label: string }[] = [
  { value: '#5ad1ff', label: '冰蓝' },
  { value: '#57ffb0', label: '荧光绿' },
  { value: '#ffb547', label: '暖橙' },
  { value: '#ff6bd6', label: '品红' },
  { value: '#ffffff', label: '纯白' },
  { value: '#9d7bff', label: '幽紫' },
]

function load(): FlightConfigState {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return { ...DEFAULT_CONFIG }
    const p = JSON.parse(raw) as Partial<FlightConfigState>
    return {
      ...DEFAULT_CONFIG,
      ...p,
      // 颜色必须是合法十六进制，否则 Cesium 的 Color.fromCssColorString 会返回 undefined
      trailColor: /^#[0-9a-fA-F]{6}$/.test(p.trailColor ?? '') ? (p.trailColor as string) : DEFAULT_CONFIG.trailColor,
      trailWidth: Math.min(8, Math.max(1, Number(p.trailWidth ?? DEFAULT_CONFIG.trailWidth))),
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export const flightConfig = reactive<FlightConfigState>(load())

watch(
  flightConfig,
  (v) => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(v))
    } catch {
      // 隐私模式下不可写，忽略
    }
  },
  { deep: true },
)

/** 复位为默认配置（配置页的「恢复默认」） */
export function resetFlightConfig(): void {
  Object.assign(flightConfig, DEFAULT_CONFIG)
}
