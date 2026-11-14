// 与 drone_physics.js 对应的类型声明（运行时仍加载同目录的 .js）
export interface PhysicsBody {
  mass_kg: number
  inertia_kgm2: number[]
  inertia_note?: string
}

export interface PhysicsGeometry {
  motor_x_m: number
  motor_z_m: number
  diagonal_wheelbase_m: number
  prop_radius_m: number
  contact_radius_m: number
  body_bottom_offset_m: number
  contact_clearance_m: number
  contact_points_local_m: number[][]
  contact_note?: string
}

export interface PhysicsRotor {
  order: string[]
  spin: number[]
  k_thrust_n_per_rad2s2: number
  k_torque_nm_per_rad2s2: number
  torque_to_thrust_ratio_m: number
  hover_rpm: number
  hover_thrust_total_n: number
  max_thrust_total_n: number
  thrust_to_weight: number
  /** 3D 模式反向推力上限 / 正向最大值 */
  reverse_thrust_ratio: number
}

export interface PhysicsEnvironment {
  gravity_mps2: number
  ground_y_m: number
  linear_drag_kg_per_s: number
  angular_drag_nms: number[]
  restitution: number
  friction: number
}

export interface PhysicsControl {
  max_rate_pitch_radps: number
  max_rate_roll_radps: number
  max_rate_yaw_radps: number
  rate_gain: number
  stabilize_gain: number
  throttle_hover: number
  stabilize_default: boolean
}

export interface PhysicsParams {
  schema: string
  coordinate: Record<string, string>
  body: PhysicsBody
  geometry: PhysicsGeometry
  rotor: PhysicsRotor
  environment: PhysicsEnvironment
  control: PhysicsControl
  integration: { fixed_step_s: number; max_substeps: number; max_frame_dt_s: number }
}

export interface DroneTelemetry {
  time: number
  position: number[]
  velocity: number[]
  quaternion: number[]
  omega: number[]
  pitch_deg: number
  roll_deg: number
  yaw_deg: number
  thrust_total_n: number
  /** 推力在世界竖直方向的分量：倒飞时推力向上、油门为负 */
  thrust_up_n: number
  /** 机身上方向与世界上方向点积：< 0 即倒飞 */
  up_y: number
  inverted: boolean
  thrusts_n: number[]
  rpms: number[]
  kinetic_energy_j: number
  potential_energy_j: number
  speed_mps: number
  contact: boolean
}

export interface DroneControls {
  throttle: number
  pitch: number
  roll: number
  yaw: number
}

export declare const PHYSICS: PhysicsParams

export interface DroneProfileOverrides {
  mass_kg?: number
  inertia_kgm2?: number[]
  max_thrust_total_n?: number
  max_rate_pitch_radps?: number
  max_rate_yaw_radps?: number
  linear_drag_kg_per_s?: number
}

export declare class DroneRigidBody {
  constructor(overrides?: {
    mass_kg?: number
    inertia_kgm2?: number[]
    gravity_mps2?: number
    linear_drag_kg_per_s?: number
    max_thrust_total_n?: number
  })
  p: PhysicsParams
  position: number[]
  velocity: number[]
  quaternion: number[]
  omega: number[]
  contact: boolean
  /** 本次 step 内触地瞬间的最大下坠速度（m/s），用于撞击解体判定 */
  groundImpact: number
  thrusts: number[]
  rpms: number[]
  controls: DroneControls
  wind: number[]
  time: number
  /** 3D 双向油门：允许负推力（倒飞） */
  threeD: boolean
  stabilize: boolean
  /** 悬停油门（按当前机型的 mg / 最大总推力 现算） */
  readonly hoverThrottle: number
  reset(init?: { position?: number[]; velocity?: number[] }): void
  setControls(c: Partial<DroneControls>): void
  setWind(w: number[]): void
  setStabilize(on: boolean): void
  setThreeD(on: boolean): void
  /** 应用机型配置（飞行配置页的「无人机类型」），改完需 reset() */
  applyProfile(profile?: DroneProfileOverrides): DroneRigidBody
  applyImpulse(J: number[], offsetWorld?: number[]): void
  step(dt: number): void
  groundClearance(): number
  /**
   * 地形高度查询（局部 x,z → 相对原点地表的高度，米）。
   * 为 null 时地面退化为常数平面 environment.ground_y_m。
   */
  groundProvider: ((x: number, z: number) => number) | null
  /** 地表法向查询（局部 x,z → 单位向量，y 为正） */
  groundNormalProvider: ((x: number, z: number) => number[] | null) | null
  /** 底部探针盒半径（米），与建筑碰撞半径一致 */
  collisionRadius: number
  setCollisionRadius(r: number): void
  readonly telemetry: DroneTelemetry
}

export declare function attitudeAngles(q: number[]): { pitch: number; yaw: number; roll: number }

export default DroneRigidBody
