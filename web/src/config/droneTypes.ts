// 无人机机型库（飞行配置页的「无人机类型」）。
//
// 每个机型同时给出两套参数：
//   · 动力学：质量 / 惯量 / 最大推力 / 角速率上限 / 线性阻力 → 写进物理层
//   · 表现：视觉缩放系数（真实机体只有 0.3 m 宽，在城市尺度下要放大才看得见）
// 悬停油门不写死，由 mg / 最大推力现算（见 drone_physics.js 的 hoverThrottle）。

export interface DroneProfile {
  id: string
  /** 机型名 */
  name: string
  /** 一句话定位 */
  tag: string
  /** 详细说明 */
  desc: string
  /** 主题色（配置页卡片与飞行页徽标共用） */
  accent: string
  massKg: number
  inertia: [number, number, number]
  /** 四个电机的最大总推力（N） */
  maxThrustN: number
  /** 俯仰 / 横滚角速率上限（rad/s） */
  maxRatePitchRadps: number
  /** 偏航角速率上限（rad/s） */
  maxRateYawRadps: number
  /** 线性阻力系数（kg/s） */
  linearDrag: number
  /** 视觉缩放倍数 */
  droneScale: number
  /** 面板上展示的规格 */
  specs: { k: string; v: string }[]
}

const G = 9.81

export const DRONE_TYPES: DroneProfile[] = [
  {
    id: 'cinewhoop',
    name: '微型穿越机',
    tag: '5 寸 · 竞速穿越',
    desc: '推重比 3.1，起步窜升、转向极快，适合狭窄地形与竞速穿楼。',
    accent: '#ff9f45',
    massKg: 0.095,
    inertia: [0.0002, 0.00033, 0.00049],
    maxThrustN: 2.9,
    maxRatePitchRadps: 5.2,
    maxRateYawRadps: 4.4,
    linearDrag: 0.07,
    droneScale: 5,
    specs: [
      { k: '起飞重量', v: '95 g' },
      { k: '推重比', v: '3.1 : 1' },
      { k: '角速率', v: '5.2 rad/s' },
      { k: '悬停油门', v: '32%' },
    ],
  },
  {
    id: 'mini3pro',
    name: 'Mini 3 Pro',
    tag: '标准 · 一体化云台',
    desc: '249 g 消费级航拍机，自带三轴云台，是本模拟器的基准机型。',
    accent: '#5ad1ff',
    massKg: 0.249,
    inertia: [0.00052, 0.00085, 0.00127],
    maxThrustN: 5.374,
    maxRatePitchRadps: 2.6,
    maxRateYawRadps: 2.2,
    linearDrag: 0.1,
    droneScale: 8,
    specs: [
      { k: '起飞重量', v: '249 g' },
      { k: '推重比', v: '2.2 : 1' },
      { k: '角速率', v: '2.6 rad/s' },
      { k: '悬停油门', v: '45%' },
    ],
  },
  {
    id: 'm300',
    name: '航测多旋翼',
    tag: 'M300 级 · 重载长航时',
    desc: '1.6 kg 重载平台，推重比低、速度慢，但稳，适合测绘与长距离巡航。',
    accent: '#57ffb0',
    massKg: 1.6,
    inertia: [0.09, 0.14, 0.18],
    maxThrustN: 30,
    maxRatePitchRadps: 1.2,
    maxRateYawRadps: 0.9,
    linearDrag: 0.36,
    droneScale: 16,
    specs: [
      { k: '起飞重量', v: '1600 g' },
      { k: '推重比', v: '1.9 : 1' },
      { k: '角速率', v: '1.2 rad/s' },
      { k: '悬停油门', v: '52%' },
    ],
  },
]

/** 兜底：未知 id 落到基准机型 */
export function getDroneType(id: string): DroneProfile {
  return DRONE_TYPES.find((d) => d.id === id) ?? DRONE_TYPES[1]
}

/** 机型参数 → 物理层 profile（只带动力学相关项） */
export function toPhysicsProfile(d: DroneProfile) {
  return {
    mass_kg: d.massKg,
    inertia_kgm2: d.inertia,
    max_thrust_total_n: d.maxThrustN,
    max_rate_pitch_radps: d.maxRatePitchRadps,
    max_rate_yaw_radps: d.maxRateYawRadps,
    linear_drag_kg_per_s: d.linearDrag,
  }
}

/** 推重比（展示用） */
export function thrustToWeight(d: DroneProfile): number {
  return d.maxThrustN / (d.massKg * G)
}
