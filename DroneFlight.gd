# DroneFlight.gd —— Godot 4.x 模拟飞行控制模板
#
# 场景搭建：
#   CharacterBody3D        <- 挂本脚本；CollisionShape3D 用 SphereShape3D，半径 0.17
#     └─ Drone_Root        <- 把 drone_mini3pro.glb 作为实例化子场景拖进来
#   Camera3D               <- near 调到 0.01（模型只有 0.32 m）
#
# 开箱即用：脚本内置物理键码回退，不配置输入映射也能直接飞。
#   W/S 前后  A/D 左右  空格/Ctrl 升降  Q/E 偏航  ↑/↓ 云台  F 折叠机臂
# 若项目设置里定义了下列 action，则优先使用 action：
#   drone_forward / drone_back / drone_left / drone_right / drone_up / drone_down
#   drone_yaw_left / drone_yaw_right / drone_gimbal_up / drone_gimbal_down / drone_fold
#
# 坐标：-Z = 机头，+Y = 上（glTF 导入 Godot 后保持一致）。
# 旋翼 / 云台 / 机臂都是独立节点，枢轴已就位，直接改局部旋转即可。

extends CharacterBody3D
class_name DroneFlight

signal telemetry(position: Vector3, attitude_deg: Vector3, rpm: float)

@export_group("模型")
@export var model_path: NodePath = ^"Drone_Root"
## 真实米制。若物理或相机裁剪不稳，把模型与碰撞体一起放大并同比调整速度参数。
@export var visual_scale: float = 1.0
@export var auto_spin: bool = true
## 真实转速会频闪；仅作视觉演示时可降到 300~900
@export_range(0.0, 20000.0, 10.0) var rpm: float = 6000.0

@export_group("飞控")
@export_range(0.0, 1.0, 0.01) var throttle: float = 0.45
@export var hover_throttle: float = 0.45
@export var thrust_gain: float = 11.0
@export var vertical_drag: float = 2.1
@export var horizontal_accel: float = 9.0
@export var horizontal_drag: float = 1.5
@export var yaw_speed: float = 1.3
@export_range(0.0, 45.0, 1.0) var max_tilt_deg: float = 20.0
@export var floor_y: float = 0.055

@export_group("云台 / 机臂")
@export_range(-90.0, 30.0, 1.0) var gimbal_pitch_deg: float = -12.0
@export var fold_arms: bool = false
@export var fold_angle_deg: float = 75.0

var _visual: Node3D
var _rotors: Array[Node3D] = []
var _arms: Array[Node3D] = []
var _gimbal: Node3D
# 与 GLB extras 中每个 Rotor_* 的「转向」一致：FL/RR 正转，FR/RL 反转
const SPIN := [1.0, -1.0, -1.0, 1.0]
const FOLD_DIR := [1.0, -1.0, -1.0, 1.0]
const TAGS := ["FL", "FR", "RL", "RR"]

# 未配置 Project Settings → Input Map 时的物理键码回退
const KEY_FALLBACK := {
	"drone_forward": KEY_W, "drone_back": KEY_S,
	"drone_left": KEY_A, "drone_right": KEY_D,
	"drone_up": KEY_SPACE, "drone_down": KEY_CTRL,
	"drone_yaw_left": KEY_Q, "drone_yaw_right": KEY_E,
	"drone_gimbal_up": KEY_UP, "drone_gimbal_down": KEY_DOWN,
	"drone_fold": KEY_F,
}
var _fold_prev: bool = false

var _angle: float = 0.0
var _fold: float = 0.0
var _yaw: float = 0.0
var _pitch: float = 0.0
var _roll: float = 0.0


func _ready() -> void:
	_visual = get_node_or_null(model_path) as Node3D
	if _visual == null:
		push_error("DroneFlight: 找不到模型根节点 %s" % model_path)
		set_physics_process(false)
		return
	_visual.scale = Vector3.ONE * visual_scale
	for t in TAGS:
		_rotors.append(_visual.get_node_or_null("Arm_%s/Rotor_%s" % [t, t]) as Node3D)
		_arms.append(_visual.get_node_or_null("Arm_%s" % t) as Node3D)
	_gimbal = _visual.get_node_or_null("Gimbal_Pivot") as Node3D
	for i in TAGS.size():
		if _rotors[i] == null:
			push_warning("缺少旋翼节点 Rotor_%s，检查 GLB 层级" % TAGS[i])


func _physics_process(delta: float) -> void:
	var d := minf(delta, 0.05)
	_read_input(d)
	_integrate_motion(d)
	_drive_parts(d)
	telemetry.emit(global_position,
		Vector3(rad_to_deg(_pitch), rad_to_deg(_roll), rad_to_deg(_yaw)), rpm)


func _action_pressed(a: String) -> bool:
	if InputMap.has_action(a):
		return Input.is_action_pressed(a)
	return Input.is_key_pressed(KEY_FALLBACK.get(a, 0))


func _axis(neg: String, pos: String) -> float:
	if InputMap.has_action(neg) and InputMap.has_action(pos):
		return Input.get_axis(neg, pos)
	return (float(Input.is_key_pressed(KEY_FALLBACK.get(pos, 0)))
		- float(Input.is_key_pressed(KEY_FALLBACK.get(neg, 0))))


func _read_input(d: float) -> void:
	# 纵向 / 横向输入 → 目标倾角（视觉倾斜只作用于模型，碰撞体保持竖直）
	var want_pitch := _axis("drone_forward", "drone_back") * deg_to_rad(max_tilt_deg)
	var want_roll  := _axis("drone_left", "drone_right") * deg_to_rad(max_tilt_deg)
	var sm := minf(1.0, d * 4.5)
	_pitch = lerpf(_pitch, want_pitch, sm)
	_roll  = lerpf(_roll, want_roll, sm)
	_yaw  += _axis("drone_yaw_right", "drone_yaw_left") * yaw_speed * d

	var gim := _axis("drone_gimbal_down", "drone_gimbal_up") * 60.0 * d
	gimbal_pitch_deg = clampf(gimbal_pitch_deg + gim, -90.0, 30.0)
	var fold_now := _action_pressed("drone_fold")
	if fold_now and not _fold_prev:
		fold_arms = not fold_arms
	_fold_prev = fold_now


func _integrate_motion(d: float) -> void:
	var lift := (throttle - hover_throttle) * thrust_gain
	if _action_pressed("drone_up"):
		lift += 6.0
	if _action_pressed("drone_down"):
		lift -= 6.0
	velocity.y += (lift - vertical_drag * velocity.y) * d

	# 前倾产生沿 -Z 的加速度，横滚产生沿 X 的加速度（按当前偏航旋转）
	var fwd := Vector3(0, 0, -1).rotated(Vector3.UP, _yaw)
	var rgt := Vector3(1, 0, 0).rotated(Vector3.UP, _yaw)
	velocity += fwd * (-_pitch * horizontal_accel * d)
	velocity += rgt * (-_roll * horizontal_accel * d)
	velocity.x *= 1.0 - horizontal_drag * d
	velocity.z *= 1.0 - horizontal_drag * d

	move_and_slide()
	if global_position.y < floor_y:
		global_position.y = floor_y
		velocity.y = maxf(velocity.y, 0.0)

	# 姿态只作用于模型节点。父级 CharacterBody3D 不旋转，
	# 否则子节点会继承一次 yaw，导致偏航角翻倍。
	_visual.rotation = Vector3(_pitch, _yaw, _roll)


func _drive_parts(d: float) -> void:
	if auto_spin:
		# 真实 RPM 在 60fps 下会频闪；要观察桨形可把 rpm 调到 300~900
		_angle += rpm * TAU / 60.0 * d
		for i in _rotors.size():
			if _rotors[i] != null:
				_rotors[i].rotation.y = SPIN[i] * _angle
	if _gimbal != null:
		_gimbal.rotation.x = deg_to_rad(gimbal_pitch_deg)
	_fold = lerpf(_fold, 1.0 if fold_arms else 0.0, minf(1.0, d * 5.0))
	for i in _arms.size():
		if _arms[i] != null:
			_arms[i].rotation.y = FOLD_DIR[i] * deg_to_rad(fold_angle_deg) * _fold


## 外部 UI 可直接调用：set_throttle(0.7)
func set_throttle(v: float) -> void:
	throttle = clampf(v, 0.0, 1.0)


func reset_pose() -> void:
	global_position = Vector3(0, 0.35, 0)
	velocity = Vector3.ZERO
	_pitch = _roll = _yaw = 0.0
	_visual.rotation = Vector3.ZERO
	rotation = Vector3.ZERO
