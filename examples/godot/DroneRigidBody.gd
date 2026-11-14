# DroneRigidBody.gd —— Godot 4.x 真实刚体版（与前端 physics/physics.json 同源）
#
# 与运动学版 DroneFlight.gd 的区别：
#   * 节点类型 RigidBody3D，质量/惯量/重力/碰撞/摩擦由物理引擎积分
#   * 每帧对质心施加 4 个旋翼的合力，并施加由电机力臂算出的力矩
#   * 角速度由引擎处理陀螺耦合 ω×(Iω)，这里不再手写欧拉方程
#   * 落地、翻倒、撞击、滑动全部是真实碰撞响应，不是位置钳制
#
# 输入无需配置映射（内置键码回退）：
#   W/S 前后 A/D 左右 Q/E 偏航 空格/Ctrl 油门 ±  ↑/↓ 云台  F 折叠  R 复位
# 若已定义 drone_* action 则优先使用 action。

extends RigidBody3D
class_name DroneRigidBodyPhysics

signal telemetry(data: Dictionary)

# ---- 与 physics/physics.json 一致（改参数时两边同步）----
const MASS_KG := 0.249
const INERTIA := Vector3(0.00052, 0.00085, 0.00127)   # [Ixx, Iyy, Izz]
const ARM_X := 0.0873
const ARM_Z := 0.0873
const K_THRUST := 1.547e-6        # N / (rad/s)^2
const Q_RATIO := 0.02             # k_torque / k_thrust, 单位 m
const MAX_THRUST_TOTAL := 5.374
const HOVER_THROTTLE := 0.455
const LINEAR_DRAG := 0.10         # kg/s
const ANGULAR_DRAG := Vector3(0.00012, 0.00012, 0.00016)
const MAX_RATE_PITCH := 2.6
const MAX_RATE_ROLL := 2.6
const MAX_RATE_YAW := 2.2
const RATE_GAIN := 9.0
const STABILIZE_GAIN := 3.2
const SPIN := [1.0, -1.0, -1.0, 1.0]
const FOLD_DIR := [1.0, -1.0, -1.0, 1.0]
const TAGS := ["FL", "FR", "RL", "RR"]
const KEY_FALLBACK := {
	"drone_forward": KEY_W, "drone_back": KEY_S,
	"drone_left": KEY_A, "drone_right": KEY_D,
	"drone_up": KEY_SPACE, "drone_down": KEY_CTRL,
	"drone_yaw_left": KEY_Q, "drone_yaw_right": KEY_E,
	"drone_gimbal_up": KEY_UP, "drone_gimbal_down": KEY_DOWN,
	"drone_fold": KEY_F, "drone_reset": KEY_R,
}

@export var throttle: float = HOVER_THROTTLE
@export var stabilize: bool = true
@export var gimbal_pitch_deg: float = -12.0
@export var fold_arms: bool = false
@export var wind: Vector3 = Vector3.ZERO
@export var follow_camera: bool = true
@export var follow_body_yaw: bool = false      # true = 追尾（只跟航向，不跟翻滚）
@export var camera_offset: Vector3 = Vector3(0.45, 0.28, 0.62)

var _visual: Node3D
var _rotors: Array[Node3D] = []
var _arms: Array[Node3D] = []
var _gimbal: Node3D
var _camera: Camera3D
var _thrusts := [0.0, 0.0, 0.0, 0.0]
var _rpms := [0.0, 0.0, 0.0, 0.0]
var _vis_angle := 0.0
var _fold := 0.0
var _fold_prev := false
var _reset_prev := false
var _cam_prev := false
var _cam_dist := 1.0
var _time := 0.0
const CAM_LAMBDA := 12.0


func _ready() -> void:
	mass = MASS_KG
	inertia = INERTIA
	gravity_scale = 1.0             # 项目重力 9.81 m/s²（project.godot 已设置）
	linear_damp = 0.0               # 阻尼显式施加，与前端求解器完全一致
	angular_damp = 0.0
	can_sleep = false               # 悬停时不能被判定为静止而休眠
	continuous_cd = true
	max_contacts_reported = 4       # 否则 get_contact_count() 恒为 0
	_visual = get_node_or_null("Drone_Root") as Node3D
	if _visual == null:
		push_error("DroneRigidBody: 找不到 Drone_Root（GLB 实例节点）")
		set_physics_process(false)
		return
	for t in TAGS:
		_rotors.append(_visual.get_node_or_null("Arm_%s/Rotor_%s" % [t, t]) as Node3D)
		_arms.append(_visual.get_node_or_null("Arm_%s" % t) as Node3D)
	_gimbal = _visual.get_node_or_null("Gimbal_Pivot") as Node3D
	_camera = get_parent().get_node_or_null("Camera3D") as Camera3D
	reset_pose()


func _action_pressed(a: String) -> bool:
	if InputMap.has_action(a):
		return Input.is_action_pressed(a)
	return Input.is_key_pressed(KEY_FALLBACK.get(a, 0))


func _axis(neg: String, pos: String) -> float:
	if InputMap.has_action(neg) and InputMap.has_action(pos):
		return Input.get_axis(neg, pos)
	return (float(Input.is_key_pressed(KEY_FALLBACK.get(pos, 0)))
		- float(Input.is_key_pressed(KEY_FALLBACK.get(neg, 0))))


func _physics_process(delta: float) -> void:
	var d := minf(delta, 0.05)
	_read_input(d)
	var basis := global_transform.basis           # 机体系 → 世界系
	var w_local := basis.transposed() * angular_velocity   # Godot 的角速度是世界系

	# ---- 1. 目标角速度（速率内环 + 姿态自稳）----
	var c_pitch := _axis("drone_forward", "drone_back") * -1.0   # W → 前倾（负）
	var c_roll := _axis("drone_left", "drone_right")              # D → 右滚（正）
	var c_yaw := _axis("drone_yaw_left", "drone_yaw_right")
	var wt := Vector3(c_pitch * MAX_RATE_PITCH,
		-c_yaw * MAX_RATE_YAW, -c_roll * MAX_RATE_ROLL)
	if stabilize:
		var fwd := -basis.z                       # 机体 -Z 机头（世界系）
		var right := basis.x
		var ang_p := asinf(clampf(fwd.y, -1.0, 1.0))
		var ang_r := asinf(clampf(right.y, -1.0, 1.0))
		wt.x += clampf(-STABILIZE_GAIN * ang_p, -MAX_RATE_PITCH, MAX_RATE_PITCH)
		wt.z += clampf(-STABILIZE_GAIN * ang_r, -MAX_RATE_ROLL, MAX_RATE_ROLL)
	var tau := Vector3(
		INERTIA.x * RATE_GAIN * (wt.x - w_local.x),
		INERTIA.y * RATE_GAIN * (wt.y - w_local.y),
		INERTIA.z * RATE_GAIN * (wt.z - w_local.z))

	# ---- 2. 四旋翼 mixer：总推力 + 3 个力矩的解析解 ----
	var total := clampf(throttle, 0.0, 1.0) * MAX_THRUST_TOTAL
	var base := total / 4.0
	var a := tau.x / (4.0 * ARM_Z)
	var b := tau.z / (4.0 * ARM_X)
	var c := tau.y / (4.0 * Q_RATIO)
	var per_max := MAX_THRUST_TOTAL / 4.0
	var T := [
		clampf(base + a - b - c, 0.0, per_max),     # FL
		clampf(base + a + b + c, 0.0, per_max),     # FR
		clampf(base - a - b + c, 0.0, per_max),     # RL
		clampf(base - a + b - c, 0.0, per_max),     # RR
	]
	_thrusts = T

	# ---- 3. 由实际推力算力矩（电机饱和会真实限制机动）----
	var tau_x := ARM_Z * (T[0] + T[1] - T[2] - T[3])
	var tau_z := ARM_X * (-T[0] + T[1] - T[2] + T[3])
	var tau_y := -Q_RATIO * (T[0] + T[3] - T[1] - T[2])
	var tau_body := Vector3(tau_x, tau_y, tau_z)
	tau_body -= Vector3(ANGULAR_DRAG.x * w_local.x,
		ANGULAR_DRAG.y * w_local.y, ANGULAR_DRAG.z * w_local.z)
	apply_torque(basis * tau_body)                 # 力矩转到世界系

	# ---- 4. 合力：机体 +Y 推力 + 风 − 线性阻力（重力由引擎给）----
	var up := basis.y
	var thrust_sum := T[0] + T[1] + T[2] + T[3]
	apply_central_force(up * thrust_sum + wind - LINEAR_DRAG * linear_velocity)

	for i in 4:
		_rpms[i] = sqrt(maxf(T[i], 0.0) / K_THRUST) * 60.0 / TAU
	_drive_visuals(d)
	_time += d
	telemetry.emit({
		"time": _time, "position": global_position,
		"speed": linear_velocity.length(), "omega": angular_velocity.length(),
		"thrust_n": thrust_sum, "rpms": _rpms.duplicate(),
		"kinetic_j": 0.5 * mass * linear_velocity.length_squared(),
		"potential_j": mass * 9.81 * global_position.y,
		"contact": get_contact_count() > 0,
		"camera_follow": follow_camera,
		"camera_distance": _cam_dist,
	})


func _read_input(d: float) -> void:
	if _axis("drone_down", "drone_up") != 0.0:
		throttle = clampf(throttle + _axis("drone_down", "drone_up") * d * 0.35, 0.0, 1.0)
	var gim := _axis("drone_gimbal_down", "drone_gimbal_up") * 60.0 * d
	gimbal_pitch_deg = clampf(gimbal_pitch_deg + gim, -90.0, 30.0)
	var fold_now := _action_pressed("drone_fold")
	if fold_now and not _fold_prev:
		fold_arms = not fold_arms
	_fold_prev = fold_now
	var reset_now := _action_pressed("drone_reset")
	if reset_now and not _reset_prev:
		reset_pose()
	_reset_prev = reset_now
	# C 切换跟随 / 自由，V 镜头立即归位
	var cam_now := Input.is_key_pressed(KEY_C)
	if cam_now and not _cam_prev:
		follow_camera = not follow_camera
	_cam_prev = cam_now
	if Input.is_key_pressed(KEY_V) and _camera != null:
		_camera.global_position = global_position + camera_offset * _cam_dist


func _drive_visuals(d: float) -> void:
	var avg_rpm := (_rpms[0] + _rpms[1] + _rpms[2] + _rpms[3]) / 4.0
	_vis_angle += avg_rpm * TAU / 60.0 * 0.035 * d    # 视觉降速，避免频闪
	for i in 4:
		if _rotors[i] != null:
			_rotors[i].rotation.y = SPIN[i] * _vis_angle
	if _gimbal != null:
		_gimbal.rotation.x = deg_to_rad(gimbal_pitch_deg)
	_fold = lerpf(_fold, 1.0 if fold_arms else 0.0, minf(1.0, d * 5.0))
	for i in 4:
		if _arms[i] != null:
			_arms[i].rotation.y = FOLD_DIR[i] * deg_to_rad(75.0) * _fold
	if _camera != null and follow_camera:
		var off := camera_offset * _cam_dist
		if follow_body_yaw:
			# 追尾只取航向：跟随机体 pitch/roll 会让画面剧烈翻滚
			var e := global_transform.basis.get_euler()
			off = off.rotated(Vector3.UP, e.y)
		# 速度前馈抵消一阶平滑的 v/λ 稳态滞后
		var goal := global_position + off + linear_velocity * 0.05
		var a := 1.0 - exp(-CAM_LAMBDA * d)      # 帧率无关平滑
		_camera.global_position = _camera.global_position.lerp(goal, a)
		_camera.look_at(global_position)


func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseButton and event.pressed:
		if event.button_index == MOUSE_BUTTON_WHEEL_UP:
			_cam_dist = clampf(_cam_dist * 0.9, 0.3, 4.0)
		elif event.button_index == MOUSE_BUTTON_WHEEL_DOWN:
			_cam_dist = clampf(_cam_dist * 1.1, 0.3, 4.0)


## 外部 UI：撞击 / 阵风 / 复位
func apply_impulse_world(j: Vector3, offset_world: Vector3 = Vector3.ZERO) -> void:
	apply_impulse(j, offset_world)


func set_wind(w: Vector3) -> void:
	wind = w


func reset_pose() -> void:
	global_transform = Transform3D(Basis(), Vector3(0, 0.35, 0))
	linear_velocity = Vector3.ZERO
	angular_velocity = Vector3.ZERO
	throttle = HOVER_THROTTLE
	_vis_angle = 0.0
	_fold = 0.0
