// 纯数值自检：physics.json 与 JS 参数一致 + 刚体行为断言（不依赖浏览器/Blender/Godot）
import { readFileSync } from 'node:fs';

const ROOT = 'D:/work/self/无人机模型器/physics/';
const json = JSON.parse(readFileSync(ROOT + 'physics.json', 'utf8'));
const src = readFileSync(ROOT + 'drone_physics.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { PHYSICS, DroneRigidBody } = mod;

const checks = [];
const ck = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail: String(detail) });

// ---- 参数一致性
const J = json, P = PHYSICS;
ck('质量一致', J.body.mass_kg === P.body.mass_kg, J.body.mass_kg);
ck('惯量张量一致', JSON.stringify(J.body.inertia_kgm2) === JSON.stringify(P.body.inertia_kgm2),
   J.body.inertia_kgm2.join(', '));
ck('推力系数一致', J.rotor.k_thrust_n_per_rad2s2 === P.rotor.k_thrust_n_per_rad2s2);
ck('最大总推力一致', J.rotor.max_thrust_total_n === P.rotor.max_thrust_total_n);
ck('重力/阻尼一致',
   J.environment.gravity_mps2 === P.environment.gravity_mps2 &&
   J.environment.linear_drag_kg_per_s === P.environment.linear_drag_kg_per_s);
ck('接触点/间隙两处一致',
   JSON.stringify(J.geometry.contact_points_local_m) === JSON.stringify(P.geometry.contact_points_local_m)
   && J.geometry.contact_clearance_m === P.geometry.contact_clearance_m
   && J.geometry.body_bottom_offset_m === P.geometry.body_bottom_offset_m,
   `${J.geometry.contact_points_local_m.length} 点 / 间隙 ${J.geometry.contact_clearance_m} m / 兜底 ${J.geometry.body_bottom_offset_m} m`);
ck('悬停油门 × 最大推力 ≈ mg',
   Math.abs(J.control.throttle_hover * J.rotor.max_thrust_total_n
            - J.body.mass_kg * J.environment.gravity_mps2) < 0.01,
   `${(J.control.throttle_hover * J.rotor.max_thrust_total_n).toFixed(3)} N vs ` +
   `${(J.body.mass_kg * J.environment.gravity_mps2).toFixed(3)} N`);

const run = (d, setup, seconds, dt = 1 / 60) => {
  d.reset();
  if (setup) setup(d);
  let contacts = 0;
  for (let t = 0; t < seconds; t += dt) {
    d.step(dt);
    if (d.contact) contacts++;
  }
  return { t: d.telemetry, contacts };
};

// ---- 1. 悬停收敛（油门 0.455 应抵消重力）
let d = new DroneRigidBody();
let r = run(d, x => x.setControls({ throttle: 0.455 }), 3);
ck('悬停 3s 后垂速 < 0.05 m/s', Math.abs(r.t.velocity[1]) < 0.05,
   `vy=${r.t.velocity[1].toFixed(4)}  y=${r.t.position[1].toFixed(4)}`);
ck('悬停不掉高', Math.abs(r.t.position[1] - 0.35) < 0.12, `Δy=${(r.t.position[1] - 0.35).toFixed(4)}`);

// ---- 2. 线性惯性：松手后不会瞬停，按阻尼指数衰减
d = new DroneRigidBody();
r = run(d, x => { x.velocity[0] = 0.5; x.setControls({ throttle: 0.455 }); }, 1);
ck('无输入 1s 后仍保留惯性速度', r.t.velocity[0] > 0.20 && r.t.velocity[0] < 0.48,
   `vx=${r.t.velocity[0].toFixed(4)} m/s`);
ck('阻尼确实在耗散动能', r.t.kinetic_energy_j < 0.5 * 0.249 * 0.25,
   `E=${r.t.kinetic_energy_j.toFixed(4)} J`);

// ---- 3. 转动惯性 + 姿态自稳
d = new DroneRigidBody();
r = run(d, x => x.setControls({ throttle: 0.455, pitch: -1 }), 0.35);
const tilted = r.t.pitch_deg;
ck('前倾指令产生机头下压', tilted < -5, `pitch=${tilted.toFixed(2)}°`);
ck('角速度非零（有转动惯量）', Math.abs(r.t.omega[0]) > 0.2,
   `wx=${r.t.omega[0].toFixed(3)} rad/s`);
// 松手后自稳回正
for (let t = 0; t < 2.5; t += 1 / 60) {
  d.setControls({ pitch: 0 });
  d.step(1 / 60);
}
ck('松手 2.5s 后姿态回正', Math.abs(d.telemetry.pitch_deg) < 8,
   `pitch=${d.telemetry.pitch_deg.toFixed(2)}°`);

// ---- 4. 地面接触：不穿透、有恢复、最终静止
d = new DroneRigidBody();
r = run(d, x => { x.reset({ position: [0, 0.25, 0] }); x.setControls({ throttle: 0 }); }, 2.5);
ck('落地不穿透地面', r.t.position[1] >= 0.052 - 1e-6, `y=${r.t.position[1].toFixed(5)}`);
ck('落地脚架间隙 ≥ 3 mm', d.groundClearance() >= 0.003 - 1e-6,
   `clearance=${d.groundClearance().toFixed(5)} m`);

// ---- 4b. 倾斜落地全过程不穿模（多点接触的核心价值）
d = new DroneRigidBody();
d.reset({ position: [0, 0.22, 0] });
let minClr = Infinity, maxTilt = 0;
for (let t = 0; t < 3.0; t += 1 / 60) {
  const tilting = t < 0.55;
  d.setControls({ throttle: 0, pitch: tilting ? -1 : 0, roll: tilting ? 0.7 : 0 });
  d.step(1 / 60);
  minClr = Math.min(minClr, d.groundClearance());
  maxTilt = Math.max(maxTilt, Math.abs(d.telemetry.pitch_deg), Math.abs(d.telemetry.roll_deg));
}
ck('倾斜落地全程脚架不插地', minClr >= 0.003 - 1e-6,
   `maxTilt=${maxTilt.toFixed(1)}° minClearance=${minClr.toFixed(5)} m`);
ck('倾斜测试确实产生大倾角', maxTilt > 15, `${maxTilt.toFixed(1)}°`);
ck('发生过接触', r.contacts > 0, `${r.contacts} 帧`);
ck('落地后垂速衰减', Math.abs(r.t.velocity[1]) < 0.25, `vy=${r.t.velocity[1].toFixed(4)}`);

// ---- 5. 电机饱和
d = new DroneRigidBody();
r = run(d, x => x.setControls({ throttle: 1, pitch: -1, roll: 1, yaw: 1 }), 0.5);
ck('单电机推力不越界',
   r.t.thrusts_n.every(t => t >= 0 && t <= 5.374 / 4 + 1e-9),
   r.t.thrusts_n.map(t => t.toFixed(3)).join(' / '));
ck('转速由推力反算且为正', r.t.rpms.every(x => x >= 0 && Number.isFinite(x)),
   r.t.rpms.map(x => Math.round(x)).join(' / ') + ' RPM');

// ---- 6. 冲量与角冲量
d = new DroneRigidBody();
d.reset();
d.applyImpulse([0.02, 0, 0], [0, 0.03, 0]);
ck('线冲量改变速度', Math.abs(d.velocity[0] - 0.02 / 0.249) < 1e-9,
   `vx=${d.velocity[0].toFixed(4)}`);
ck('偏心冲量产生角速度', Math.abs(d.omega[2]) > 0.1,
   `wz=${d.omega[2].toFixed(3)} rad/s`);

// ---- 7. 四元数始终归一
ck('四元数归一', Math.abs(Math.hypot(...d.quaternion) - 1) < 1e-6);

console.log('='.repeat(78));
for (const c of checks)
  console.log((c.ok ? '[PASS] ' : '[FAIL] ') + c.name + (c.detail ? '  | ' + c.detail : ''));
const bad = checks.filter(c => !c.ok);
console.log('-'.repeat(78));
console.log(`${checks.length - bad.length}/${checks.length} 通过`
  + (bad.length ? '  失败: ' + bad.map(c => c.name).join(', ') : ''));
if (bad.length) process.exitCode = 1;
