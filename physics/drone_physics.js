/* drone_physics.js —— 无依赖六自由度四旋翼刚体求解器（ES module）
 *
 * 与 physics/physics.json 是同一套参数；数值自检脚本会逐项比对两者。
 * 机体系：+X 右、+Y 上、−Z 机头（glTF / three.js / Godot 一致）。
 *
 * 物理链条（不是「速度衰减」式的假惯性）：
 *   控制指令 → 目标角速度 → 期望力矩 → 四旋翼 mixer 分配各电机推力
 *   → 电机力臂产生真实力矩 τ = r × F（含电机饱和）
 *   → 欧拉方程 I·dω/dt = τ − ω × (Iω) − 角阻尼
 *   → 四元数积分姿态 → 推力旋转到世界系 → 重力/风/线阻 → 速度/位置积分
 *   → 地面接触（法向恢复 + 切向摩擦）
 */
export const PHYSICS = {
  schema: 'drone-physics/1',
  coordinate: {
    frame: 'right-handed, Y-up', body_forward: '-Z', body_right: '+X',
    body_up: '+Y', rotor_axis: 'local Y (glTF/Godot)',
    units: 'meter / kilogram / second / newton',
  },
  body: {
    mass_kg: 0.249,
    inertia_kgm2: [0.00052, 0.00085, 0.00127],
    inertia_note: '机身盒体 + 4 个电机集中质量估算，机体系 [Ixx, Iyy, Izz]',
  },
  geometry: {
    motor_x_m: 0.0873, motor_z_m: 0.0873,
    diagonal_wheelbase_m: 0.247, prop_radius_m: 0.073,
    contact_radius_m: 0.052, body_bottom_offset_m: 0.052,
    contact_clearance_m: 0.003,
    contact_points_local_m: [
      [-0.108, -0.045, -0.100], [0.108, -0.045, -0.100],
      [-0.094, -0.025, 0.094], [0.094, -0.025, 0.094],
    ],
    contact_note: '4 个脚架触地点（机体系，Y 上 / -Z 机头）；落地取旋转后最低点做穿透修正，0.003 m 间隙保证脚底高于地面网格。',
  },
  rotor: {
    order: ['FL', 'FR', 'RL', 'RR'], spin: [1, -1, -1, 1],
    k_thrust_n_per_rad2s2: 1.547e-6, k_torque_nm_per_rad2s2: 3.094e-8,
    torque_to_thrust_ratio_m: 0.02, hover_rpm: 6000,
    hover_thrust_total_n: 2.443, max_thrust_total_n: 5.374,
    thrust_to_weight: 2.2,
    // 3D 模式（电机可反转）下的反向推力上限：3D 桨是对称桨，正反推力基本相当
    reverse_thrust_ratio: 1.0,
  },
  environment: {
    gravity_mps2: 9.81, ground_y_m: 0.0,
    linear_drag_kg_per_s: 0.10,
    angular_drag_nms: [0.00012, 0.00012, 0.00016],
    restitution: 0.25, friction: 0.55,
  },
  control: {
    max_rate_pitch_radps: 2.6, max_rate_roll_radps: 2.6,
    max_rate_yaw_radps: 2.2, rate_gain: 9.0, stabilize_gain: 3.2,
    throttle_hover: 0.455, stabilize_default: true,
  },
  integration: {
    fixed_step_s: 0.0041666667, max_substeps: 12, max_frame_dt_s: 0.05,
  },
};

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1],
                         a[2] * b[0] - a[0] * b[2],
                         a[0] * b[1] - a[1] * b[0]];

function qnorm(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}
function qmul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
const qinv = q => [-q[0], -q[1], -q[2], q[3]];
function qrotate(q, v) {
  const u = [q[0], q[1], q[2]];
  const t = [2 * (u[1] * v[2] - u[2] * v[1]),
             2 * (u[2] * v[0] - u[0] * v[2]),
             2 * (u[0] * v[1] - u[1] * v[0])];
  const c = cross(u, t);
  return [v[0] + q[3] * t[0] + c[0],
          v[1] + q[3] * t[1] + c[1],
          v[2] + q[3] * t[2] + c[2]];
}
/** 用旋转后的轴向量求姿态角，避开欧拉角万向锁。 */
export function attitudeAngles(q) {
  const fwd = qrotate(q, [0, 0, -1]);
  const right = qrotate(q, [1, 0, 0]);
  const up = qrotate(q, [0, 1, 0]);
  return {
    pitch: Math.asin(clamp(fwd[1], -1, 1)),          // + 抬头
    yaw: Math.atan2(-fwd[0], -fwd[2]),
    // atan2(右轴高度, 上轴高度)：正飞 0°，右滚为负。asin 只能给 ±90°，
    // 而且倒扣时 right[1] ≈ 0 会被误判成「已改平」，倒飞 HUD 与自稳都会失效。
    roll: Math.atan2(right[1], up[1]),
  };
}

export class DroneRigidBody {
  constructor(overrides = {}) {
    this.p = JSON.parse(JSON.stringify(PHYSICS));
    if (overrides.mass_kg !== undefined) this.p.body.mass_kg = overrides.mass_kg;
    if (overrides.inertia_kgm2) this.p.body.inertia_kgm2 = [...overrides.inertia_kgm2];
    if (overrides.gravity_mps2 !== undefined) this.p.environment.gravity_mps2 = overrides.gravity_mps2;
    if (overrides.linear_drag_kg_per_s !== undefined) this.p.environment.linear_drag_kg_per_s = overrides.linear_drag_kg_per_s;
    if (overrides.max_thrust_total_n !== undefined) this.p.rotor.max_thrust_total_n = overrides.max_thrust_total_n;
    // 外部注入的依赖（不属于机体状态，reset 不清除）：
    //   groundProvider(x, z)          → 该局部水平位置的地形高度（米，相对原点地表）
    //   groundNormalProvider(x, z)    → 该位置的地表法向（单位向量，y 为正）
    //   collisionRadius               → 底部探针盒半宽（米），与建筑碰撞半径一致
    // 三者都为 null / 0 时行为与「平面地面」完全一致。
    this.groundProvider = null;
    this.groundNormalProvider = null;
    this.collisionRadius = 0;
    this._probeBuf = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
    this.reset();
  }

  reset(init = {}) {
    this.position = init.position ? [...init.position] : [0, 0.35, 0];
    this.velocity = init.velocity ? [...init.velocity] : [0, 0, 0];
    this.quaternion = [0, 0, 0, 1];
    this.omega = [0, 0, 0];                 // 机体系角速度 [wx, wy, wz]
    this.controls = { throttle: this.p.control.throttle_hover, pitch: 0, roll: 0, yaw: 0 };
    this.wind = [0, 0, 0];
    this.stabilize = this.p.control.stabilize_default;
    /** 3D 模式：电机可反转，负油门产生反向推力（倒飞要靠它） */
    this.threeD = false;
    this.time = 0;
    this.contact = false;
    /** 本次 step 内触地瞬间的最大下坠速度（m/s）：contact 会随弹起清掉，撞击判定要用它 */
    this.groundImpact = 0;
    this.thrusts = [0, 0, 0, 0];
    this.rpms = [0, 0, 0, 0];
    this._updateDerived();
  }

  /**
   * 悬停油门：由当前机型的质量与推力上限推出（mg / 最大总推力）。
   * 换机型后油门刻度必须跟着走 —— 写死 0.455 的话，重 1.6 kg 的航测机一上来就往下掉，
   * 90 g 的穿越机则直接顶飞。
   *
   * 保留三位小数：基准机型算出来正好是 PHYSICS 里那个 0.455，
   * 取整后与既有参数完全一致（自检按 0.455 比对），换机型时也不会给出
   * 0.454537 这种没有操作意义的刻度。
   */
  get hoverThrottle() {
    const p = this.p;
    const raw = p.body.mass_kg * p.environment.gravity_mps2 / p.rotor.max_thrust_total_n;
    return Math.round(clamp(raw, 0, 1) * 1000) / 1000;
  }

  /**
   * 应用机型配置（飞行配置页的「无人机类型」）。
   * 传 undefined 的项保持原值；改完请调用 reset() 让刚体回到新机型的初始状态。
   * 注意：这里只改动力学参数，机体外形（GLB）与视觉缩放由场景层负责。
   */
  applyProfile(profile = {}) {
    const p = this.p;
    if (profile.mass_kg !== undefined) p.body.mass_kg = profile.mass_kg;
    if (profile.inertia_kgm2) p.body.inertia_kgm2 = [...profile.inertia_kgm2];
    if (profile.max_thrust_total_n !== undefined) p.rotor.max_thrust_total_n = profile.max_thrust_total_n;
    if (profile.max_rate_pitch_radps !== undefined) {
      p.control.max_rate_pitch_radps = profile.max_rate_pitch_radps;
      p.control.max_rate_roll_radps = profile.max_rate_pitch_radps;
    }
    if (profile.max_rate_yaw_radps !== undefined) p.control.max_rate_yaw_radps = profile.max_rate_yaw_radps;
    if (profile.linear_drag_kg_per_s !== undefined) p.environment.linear_drag_kg_per_s = profile.linear_drag_kg_per_s;
    // 悬停点随机型变化：油门刻度必须同步，否则新机型进场就失控
    p.control.throttle_hover = this.hoverThrottle;
    return this;
  }

  /** pitch +1=抬头, roll +1=右滚, yaw +1=右转；姿态量 −1..1，油门 0..1（3D 模式 −1..1） */
  setControls(c) {
    const k = this.controls;
    if (c.throttle !== undefined) k.throttle = clamp(c.throttle, this.threeD ? -1 : 0, 1);
    if (c.pitch !== undefined) k.pitch = clamp(c.pitch, -1, 1);
    if (c.roll !== undefined) k.roll = clamp(c.roll, -1, 1);
    if (c.yaw !== undefined) k.yaw = clamp(c.yaw, -1, 1);
  }
  setWind(w) { this.wind = [...w]; }
  setStabilize(on) { this.stabilize = !!on; }
  /** 3D 双向油门：允许负推力，倒飞时用它托住机身 */
  setThreeD(on) {
    this.threeD = !!on;
    if (!this.threeD && this.controls.throttle < 0) this.controls.throttle = 0;
  }

  /** 外部冲量（世界系 N·s）；offsetWorld 为作用点相对质心的世界偏移，产生角冲量 */
  applyImpulse(J, offsetWorld = [0, 0, 0]) {
    const m = this.p.body.mass_kg, I = this.p.body.inertia_kgm2;
    for (let i = 0; i < 3; i++) this.velocity[i] += J[i] / m;
    const rb = qrotate(qinv(this.quaternion), offsetWorld);
    const jb = qrotate(qinv(this.quaternion), J);
    const L = cross(rb, jb);
    for (let i = 0; i < 3; i++) this.omega[i] += L[i] / I[i];
  }

  step(dt) {
    const it = this.p.integration;
    const fdt = Math.min(dt, it.max_frame_dt_s);
    const n = Math.min(it.max_substeps,
                       Math.max(1, Math.ceil(fdt / it.fixed_step_s)));
    const h = fdt / n;
    this.groundImpact = 0;
    for (let i = 0; i < n; i++) this._integrate(h);
    this.time += fdt;
    this._updateDerived();
  }

  _integrate(h) {
    const p = this.p, B = p.body, G = p.geometry,
          R = p.rotor, E = p.environment, C = p.control;
    const I = B.inertia_kgm2, m = B.mass_kg, w = this.omega;
    const armX = G.motor_x_m, armZ = G.motor_z_m;
    const qRatio = R.torque_to_thrust_ratio_m;

    // ---- 1. 目标角速度（速率内环 + 姿态自稳）
    // 机体系：wx 绕 +X = 抬头；wy 绕 +Y = 左转；wz 绕 +Z = 左滚
    const c = this.controls;
    let wx = c.pitch * C.max_rate_pitch_radps;
    let wy = -c.yaw * C.max_rate_yaw_radps;
    let wz = -c.roll * C.max_rate_roll_radps;
    if (this.stabilize) {
      // 姿态误差用「旋转向量」求：把机身 up 转回世界 +Y 的那个旋转轴 × 角度。
      // 旧写法 wz += -gain * asin(right.y) 只在小角度成立，倒扣 180° 时 asin 给 0，
      // 自稳会认为「已改平」，于是永远翻不回来；旋转向量对任意姿态都成立。
      const upW = qrotate(this.quaternion, [0, 1, 0]);
      let ax = cross(upW, [0, 1, 0]);
      let s = Math.hypot(ax[0], ax[1], ax[2]);
      let ang = Math.atan2(s, upW[1]);
      if (s > 1e-4) {
        ax = [ax[0] / s, ax[1] / s, ax[2] / s];
      } else if (upW[1] < 0) {
        // 完全倒扣：任一水平轴都能把 -Y 转回 +Y，取机体右轴（绕纵轴横滚翻正）
        ax = qrotate(this.quaternion, [1, 0, 0]);
      } else {
        ax = [0, 0, 0];
        ang = 0;
      }
      if (ang > 1e-5) {
        // 世界系目标角速度 → 机体系（速率内环只认机体系角速度）
        const g = ang * C.stabilize_gain;
        const wb = qrotate(qinv(this.quaternion), [ax[0] * g, ax[1] * g, ax[2] * g]);
        wx += clamp(wb[0], -C.max_rate_pitch_radps, C.max_rate_pitch_radps);
        wy += clamp(wb[1], -C.max_rate_yaw_radps, C.max_rate_yaw_radps);
        wz += clamp(wb[2], -C.max_rate_roll_radps, C.max_rate_roll_radps);
      }
    }
    const tau = [I[0] * C.rate_gain * (wx - w[0]),
                 I[1] * C.rate_gain * (wy - w[1]),
                 I[2] * C.rate_gain * (wz - w[2])];

    // ---- 2. 四旋翼 mixer：4 个方程（总推力 + 3 力矩）的解析解
    const Ttotal = c.throttle * R.max_thrust_total_n;
    const base = Ttotal / 4;
    const A = tau[0] / (4 * armZ);
    const Bm = tau[2] / (4 * armX);
    const Cm = tau[1] / (4 * qRatio);
    const perMax = R.max_thrust_total_n / 4;
    // 3D 模式电机可反转：下界放到负值，倒飞时靠反向推力托住机体
    const perMin = this.threeD ? -perMax * R.reverse_thrust_ratio : 0;
    // 混控去饱和（姿态优先）：先把总推力收到「差动还留得下行程」的区间。
    // 否则满油门时四个电机一起顶到限幅，差动被吃光 —— 表现就是打杆没反应、
    // 机身锁在某个角速度上继续滚（一键倒飞后油门满反向时必现）。
    const maxDiff = Math.abs(A) + Math.abs(Bm) + Math.abs(Cm);
    const baseLo = perMin + maxDiff;
    const baseHi = perMax - maxDiff;
    const baseCmd = baseLo <= baseHi ? clamp(base, baseLo, baseHi) : (perMin + perMax) / 2;
    // 顺序 FL, FR, RL, RR；电机位置 (∓armX, ∓armZ)
    const T = [baseCmd + A - Bm - Cm, baseCmd + A + Bm + Cm,
               baseCmd - A - Bm + Cm, baseCmd - A + Bm - Cm]
      .map(t => clamp(t, perMin, perMax));  // 电机饱和：真实物理效应，保留

    // ---- 3. 由实际推力算力矩（clamp 之后，故与期望力矩可能不同）
    const [t0, t1, t2, t3] = T;
    const tauX = armZ * (t0 + t1 - t2 - t3);
    const tauZ = armX * (-t0 + t1 - t2 + t3);
    const tauY = -qRatio * (t0 + t3 - t1 - t2);

    // ---- 4. 欧拉方程 I·dω/dt = τ − ω×(Iω) − 角阻尼（陀螺耦合体现转动惯量）
    const Iw = [I[0] * w[0], I[1] * w[1], I[2] * w[2]];
    const gyro = cross(w, Iw);
    const dq = E.angular_drag_nms;
    w[0] += (tauX - gyro[0] - dq[0] * w[0]) / I[0] * h;
    w[1] += (tauY - gyro[1] - dq[1] * w[1]) / I[1] * h;
    w[2] += (tauZ - gyro[2] - dq[2] * w[2]) / I[2] * h;

    // ---- 5. 四元数积分 dq/dt = 0.5 * q * (0, ω)
    const q = this.quaternion;
    const d = qmul(q, [w[0], w[1], w[2], 0]);
    this.quaternion = qnorm([q[0] + 0.5 * d[0] * h, q[1] + 0.5 * d[1] * h,
                             q[2] + 0.5 * d[2] * h, q[3] + 0.5 * d[3] * h]);

    // ---- 6. 力：重力 + 机体上方向的推力 + 风 − 线性阻力
    const up = qrotate(this.quaternion, [0, 1, 0]);
    const Tsum = t0 + t1 + t2 + t3;
    const F = [-E.linear_drag_kg_per_s * this.velocity[0] + this.wind[0] + up[0] * Tsum,
               -m * E.gravity_mps2 - E.linear_drag_kg_per_s * this.velocity[1] + this.wind[1] + up[1] * Tsum,
               -E.linear_drag_kg_per_s * this.velocity[2] + this.wind[2] + up[2] * Tsum];
    const v = this.velocity;
    for (let i = 0; i < 3; i++) {
      v[i] += F[i] / m * h;
      this.position[i] += v[i] * h;
    }

    // ---- 7. 地面接触：4 个脚架点 + 底部包围盒探针
    //
    // 地面高度有两种来源：
    //   · 默认是常数平面 environment.ground_y_m（椭球面）
    //   · 外部注入 groundProvider(x, z) 时是随位置变化的地形高度场（真实山体）
    // 有地形时按「地表法向」解算：撞山会沿坡面弹开并顺坡下滑，
    // 而不是被垂直方向硬推出去 —— 垂直推出在陡坡上会抖，还会吞掉水平动量。
    //
    // 探针集合 = 4 个脚架触地点 + 机体底部包围盒的 4 个角。
    // 包围盒半径与建筑碰撞一致（随视觉缩放），这样在陡坡/山壁前就能提前接触，
    // 而不是等机体中心已经越过山脊才被发现 —— 否则会一头扎进山体。
    const gp = this.groundProvider;
    const clearance = G.contact_clearance_m;
    const rad = this.collisionRadius;
    let groundY = E.ground_y_m;
    if (gp) groundY = gp(this.position[0], this.position[2]);

    // 找最深穿透的那个探针，以及它所在的地形位置（法向要用该点的梯度）
    let pen = (groundY + G.body_bottom_offset_m) - this.position[1];
    let hitX = this.position[0];
    let hitZ = this.position[2];
    for (let i = 0; i < 4; i++) {
      const c = G.contact_points_local_m[i];
      const cw = qrotate(this.quaternion, c);
      const px = this.position[0] + cw[0];
      const pz = this.position[2] + cw[2];
      const gy = gp ? gp(px, pz) : groundY;
      const d = (gy + clearance) - (this.position[1] + cw[1]);
      if (d > pen) { pen = d; hitX = px; hitZ = pz; }
    }
    if (rad > 0) {
      for (let i = 0; i < 4; i++) {
        const c = this._probeBuf[i];
        const cw = qrotate(this.quaternion, c);
        const px = this.position[0] + cw[0];
        const pz = this.position[2] + cw[2];
        const gy = gp ? gp(px, pz) : groundY;
        const d = (gy + clearance) - (this.position[1] + cw[1]);
        if (d > pen) { pen = d; hitX = px; hitZ = pz; }
      }
    }

    // 地表法向：由接触点处的地形梯度求得（平面时就是竖直向上）
    let nx = 0, ny = 1, nz = 0;
    if (gp && this.groundNormalProvider) {
      const n = this.groundNormalProvider(hitX, hitZ);
      if (n) { nx = n[0]; ny = n[1]; nz = n[2]; }
    }

    this.contact = false;
    if (pen > 0) {
      // 沿法向推出（法向不竖直时会同时修正水平位置，这是撞山壁的关键）
      this.position[0] += nx * pen;
      this.position[1] += ny * pen;
      this.position[2] += nz * pen;
      this.contact = true;

      // 速度分解：法向反弹 + 切向摩擦
      const vn = v[0] * nx + v[1] * ny + v[2] * nz;
      if (vn < 0) {
        // 触地速度必须锁存：反弹后 contact 会在后续子步被清掉，
        // 只看 step 结束时的 contact 会漏判「高速撞地」
        this.groundImpact = Math.max(this.groundImpact, -vn);
        const j = -(1 + E.restitution) * vn;
        v[0] += j * nx; v[1] += j * ny; v[2] += j * nz;
      }
      const vn2 = v[0] * nx + v[1] * ny + v[2] * nz;
      const f = clamp(1 - E.friction * h * 60, 0, 1);
      v[0] = vn2 * nx + (v[0] - vn2 * nx) * f;
      v[1] = vn2 * ny + (v[1] - vn2 * ny) * f;
      v[2] = vn2 * nz + (v[2] - vn2 * nz) * f;

      // 顺坡下滑：重力在切平面上的分量。
      // 平面（ny=1）时这一项恒为 0，不影响原有行为。
      const gAcc = -E.gravity_mps2;
      const gN = gAcc * ny;
      v[0] += (0 - gN * nx) * h;
      v[1] += (gAcc - gN * ny) * h;
      v[2] += (0 - gN * nz) * h;

      w[0] *= 0.985; w[2] *= 0.985;
    }
    this.thrusts = T;
  }

  _updateDerived() {
    const kT = this.p.rotor.k_thrust_n_per_rad2s2;
    // 反向推力时电机反转：桨速取绝对值，符号由 thrusts 体现（场景层据此反转旋翼转向）
    this.rpms = this.thrusts.map(t => Math.sqrt(Math.abs(t) / kT) * 60 / (2 * Math.PI));
  }

  /** 4 个脚架接触点在世界系的最低高度（相对地面），用于穿模自检 */
  groundClearance() {
    const gp = this.groundProvider;
    let minC = Infinity;
    for (const c of this.p.geometry.contact_points_local_m) {
      const cw = qrotate(this.quaternion, c);
      const gy = gp ? gp(this.position[0] + cw[0], this.position[2] + cw[2])
                    : this.p.environment.ground_y_m;
      const cl = this.position[1] + cw[1] - gy;
      if (cl < minC) minC = cl;
    }
    return minC;
  }

  /**
   * 设置底部探针盒半径（米）。
   * 与建筑碰撞的 radius 保持一致，机体在视觉上的大小决定了它能"提前多远"撞上山壁。
   */
  setCollisionRadius(r) {
    const rad = Math.max(0, r || 0);
    this.collisionRadius = rad;
    const y = -this.p.geometry.body_bottom_offset_m;
    this._probeBuf[0] = [rad, y, rad];
    this._probeBuf[1] = [-rad, y, rad];
    this._probeBuf[2] = [rad, y, -rad];
    this._probeBuf[3] = [-rad, y, -rad];
  }

  get telemetry() {
    const p = this.p, m = p.body.mass_kg, I = p.body.inertia_kgm2,
          v = this.velocity, w = this.omega, E = p.environment;
    const a = attitudeAngles(this.quaternion);
    const up = qrotate(this.quaternion, [0, 1, 0]);
    const thrustTotal = this.thrusts.reduce((s, x) => s + x, 0);
    const lin = 0.5 * m * (v[0] ** 2 + v[1] ** 2 + v[2] ** 2);
    const rot = 0.5 * (I[0] * w[0] ** 2 + I[1] * w[1] ** 2 + I[2] * w[2] ** 2);
    return {
      time: this.time,
      position: [...this.position], velocity: [...v],
      quaternion: [...this.quaternion], omega: [...w],
      pitch_deg: a.pitch * 180 / Math.PI,
      roll_deg: a.roll * 180 / Math.PI,
      yaw_deg: a.yaw * 180 / Math.PI,
      thrust_total_n: thrustTotal,
      /** 推力在世界竖直方向的分量：倒飞时推力为正、油门为负 */
      thrust_up_n: thrustTotal * up[1],
      /** 机身上方向与世界上方向点积：< 0 即倒飞 */
      up_y: up[1],
      inverted: up[1] < 0,
      thrusts_n: [...this.thrusts], rpms: [...this.rpms],
      kinetic_energy_j: lin + rot, potential_energy_j: m * E.gravity_mps2 * this.position[1],
      speed_mps: Math.hypot(v[0], v[1], v[2]),
      contact: this.contact,
    };
  }
}

export default DroneRigidBody;
