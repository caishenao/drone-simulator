<!--
  DroneViewer.vue —— 可直接放进 Vue3 + Vite 项目（npm i three）

  <DroneViewer url="/models/drone_mini3pro.glb"
               :rpm="600" :gimbal-pitch="-12" :folded="false"
               :scale="1" :keyboard="true" :physics="true"
               :stabilize="true" :throttle="0.455"
               @ready="onReady" @telemetry="onTelemetry" />

  物理：默认启用六自由度刚体（质量 0.249 kg、惯量张量、四旋翼推力/力矩、
  欧拉方程含陀螺耦合、重力与风、地面接触）。参数来自同目录
  physics/physics.json，实现在 physics/drone_physics.js。
  ★ 复制本组件进项目时，请把整个 physics/ 目录一起复制，保持相对路径；
    或按实际位置修改下面的 import。

  坐标：GLB 内 -Z = 机头、+Y = 上；旋翼绕自身局部 Y 轴旋转。
  模型真实米制（含桨 0.32 m），小场景建议整个模型根节点 scale = 5~10，
  此时物理位置会自动乘同一 scale。
  Godot 侧见 examples/godot/DroneRigidBody.gd。
-->
<template>
  <div ref="host" class="drone-viewer">
    <div v-if="loading" class="drone-viewer__tip">加载 {{ url }} …</div>
    <div v-if="error" class="drone-viewer__tip drone-viewer__err">{{ error }}</div>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { DroneRigidBody, PHYSICS } from './physics/drone_physics.js'
import { FollowCamera } from './follow_camera.js'
import { createSkyGround } from './sky_ground.js'

const props = defineProps({
  url:          { type: String,  default: '/drone_mini3pro.glb' },
  scale:        { type: Number,  default: 1 },
  rpm:          { type: Number,  default: 600 },     // physics=false 时的视觉转速
  gimbalPitch:  { type: Number,  default: -12 },
  folded:       { type: Boolean, default: false },
  keyboard:     { type: Boolean, default: false },
  autoOrbit:    { type: Boolean, default: true },
  background:   { type: String,  default: '#8fb2d0' },
  physics:      { type: Boolean, default: true },
  stabilize:    { type: Boolean, default: true },
  wind:         { type: Array,   default: () => [0, 0, 0] },
  throttle:     { type: Number,  default: 0.455 },   // 0.455 = 悬停油门
  mass:         { type: Number,  default: 0.249 },
  follow:       { type: Boolean, default: true },
  followMode:   { type: String,  default: 'world' },  // world | body | off
  followDistance: { type: Number, default: 1 },
})
const emit = defineEmits(['ready', 'error', 'telemetry'])

const host = ref(null)
const loading = ref(true)
const error = ref('')

let renderer, scene, camera, controls, pmrem, raf = 0, ro, follow = null, skyGround = null
let model = null, gimbal = null
const HOME_VEC = new THREE.Vector3(0, 0.35, 0)
const rotors = []
const arms = []
const SPIN = PHYSICS.rotor.spin        // [1, -1, -1, 1]
const TAGS = PHYSICS.rotor.order
const clock = new THREE.Clock()
const keys = Object.create(null)
const state = { angle: 0, fold: 0 }
const body = new DroneRigidBody({ mass_kg: props.mass })
body.setStabilize(props.stabilize)
body.setWind(props.wind)
body.setControls({ throttle: props.throttle })

function onKeyDown(e) { keys[e.code] = true }
function onKeyUp(e)   { keys[e.code] = false }

function init() {
  const el = host.value
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.toneMapping = THREE.NeutralToneMapping ?? THREE.ACESFilmicToneMapping
  el.appendChild(renderer.domElement)

  scene = new THREE.Scene()
  // 天空渐变 + 不透明暖灰实体地面；地面/网格位于物理地面之下防穿模
  skyGround = createSkyGround(scene, {
    scale: props.scale, gridSize: 2 * props.scale, divisions: 20,
    horizon: props.background,
  })
  pmrem = new THREE.PMREMGenerator(renderer)
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.05).texture
  if ('environmentIntensity' in scene) scene.environmentIntensity = 0.55
  scene.add(new THREE.HemisphereLight(0xd7e8ff, 0x394150, 1.0))
  const sun = new THREE.DirectionalLight(0xffffff, 2.2)
  sun.position.set(0.6, 1.2, 0.5)
  sun.castShadow = true
  sun.shadow.camera.left = -2; sun.shadow.camera.right = 2
  sun.shadow.camera.top = 2;   sun.shadow.camera.bottom = -2
  sun.shadow.camera.near = 0.05; sun.shadow.camera.far = 6
  scene.add(sun)
  // 地面与网格由 sky_ground.js 统一创建

  camera = new THREE.PerspectiveCamera(40, 1, 0.005, 50)
  camera.position.set(0.55, 0.42, 0.72)
  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.autoRotate = props.autoOrbit
  controls.autoRotateSpeed = 0.7
  controls.minDistance = 0.2
  const s = props.scale
  HOME_VEC.set(0, 0.35 * s, 0)
  follow = new FollowCamera(camera, controls, renderer.domElement, {
    mode: props.follow ? props.followMode : 'off',
    offset: [0.55 * s, 0.12 * s, 0.72 * s],
    distance: props.followDistance,
    minDistance: 0.3, maxDistance: 6,
  })
  follow.snap(HOME_VEC, null)
  controls.target.copy(HOME_VEC)

  ro = new ResizeObserver(resize)
  ro.observe(el)
  resize()
  if (props.keyboard) {
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
  }
  load()
  raf = requestAnimationFrame(tick)
}

function resize() {
  const el = host.value
  if (!el || !renderer) return
  const w = el.clientWidth || 1, h = el.clientHeight || 1
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}

function load() {
  new GLTFLoader().load(props.url, gltf => {
    model = gltf.scene
    model.scale.setScalar(props.scale)
    model.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
    scene.add(model)
    TAGS.forEach(t => {
      rotors.push(model.getObjectByName('Rotor_' + t))
      arms.push(model.getObjectByName('Arm_' + t))
    })
    gimbal = model.getObjectByName('Gimbal_Pivot')
    loading.value = false
    emit('ready', {
      scene: model,
      rootExtras: model.getObjectByName('Drone_Root')?.userData ?? {},
      nodes: TAGS.map(t => 'Rotor_' + t),
      physics: PHYSICS,
    })
  }, undefined, e => {
    loading.value = false
    error.value = 'GLB 加载失败：' + e
    emit('error', e)
  })
}

function tick() {
  raf = requestAnimationFrame(tick)
  const dt = Math.min(clock.getDelta(), 0.05)
  if (model) {
    if (props.physics) {
      // 六自由度刚体：键盘 → 控制指令 → 推力分配 → 欧拉方程 → 四元数姿态
      body.setControls(readKeyboard(dt))
      body.step(dt)
      const t = body.telemetry, s = props.scale
      model.position.set(t.position[0] * s, t.position[1] * s, t.position[2] * s)
      model.quaternion.set(...t.quaternion)
      const avgRpm = t.rpms.reduce((a, b) => a + b, 0) / 4
      state.angle += avgRpm * Math.PI * 2 / 60 * 0.035 * dt   // 视觉降速抗频闪
      emit('telemetry', {
        ...t,
        rpm: Math.round(t.rpms[0]),
        attitude: [t.pitch_deg, t.roll_deg, t.yaw_deg],
      })
    } else {
      // 纯视觉模式：不积分刚体，只按 props.rpm 转桨
      state.angle += (props.rpm * Math.PI * 2 / 60) * dt
      emit('telemetry', {
        position: model.position.toArray(), attitude: [0, 0, 0],
        rpm: props.rpm, rpms: [props.rpm, props.rpm, props.rpm, props.rpm],
      })
    }
    rotors.forEach((r, i) => { if (r) r.rotation.y = SPIN[i] * state.angle })
    if (gimbal) gimbal.rotation.x = THREE.MathUtils.degToRad(props.gimbalPitch)
    state.fold += ((props.folded ? 1 : 0) - state.fold) * Math.min(1, dt * 5)
    arms.forEach((a, i) => { if (a) a.rotation.y = [1, -1, -1, 1][i] * 1.3 * state.fold })
  }
  if (follow) {
    follow.update(dt, model ? model.position : HOME_VEC,
                  model ? model.quaternion : null)
  } else {
    controls.update()
  }
  renderer.render(scene, camera)
}

function readKeyboard(dt) {
  const c = { pitch: 0, roll: 0, yaw: 0 }
  if (!props.keyboard) return c
  const k = keys
  if (k.KeyW) c.pitch -= 1
  if (k.KeyS) c.pitch += 1
  if (k.KeyA) c.roll -= 1
  if (k.KeyD) c.roll += 1
  if (k.KeyQ) c.yaw -= 1
  if (k.KeyE) c.yaw += 1
  if (k.Space || k.ShiftLeft) {
    setThrottle(THREE.MathUtils.clamp(
      body.controls.throttle + (k.Space ? 1 : -1) * dt * 0.35, 0, 1))
  }
  return c
}

function setThrottle(v) { body.setControls({ throttle: THREE.MathUtils.clamp(v, 0, 1) }) }
function reset() {
  body.reset()
  body.setStabilize(props.stabilize)
  body.setWind(props.wind)
  setThrottle(props.throttle)
  state.angle = 0; state.fold = 0
  follow?.snap(HOME_VEC, null)
}
function getObject(name) { return model ? model.getObjectByName(name) : null }
function applyImpulse(J, offset) { body.applyImpulse(J, offset) }
function setWind(w) { body.setWind(w) }
function setStabilize(on) { body.setStabilize(on) }
function setFollowMode(m) { follow?.setMode(m) }
function cycleFollowMode() { return follow?.cycleMode() }
function snapFollow() {
  follow?.snap(model ? model.position : HOME_VEC, model ? model.quaternion : null)
}
function followState() { return follow?.state(model ? model.position : HOME_VEC) ?? null }

defineExpose({
  setThrottle, reset, getObject, applyImpulse, setWind, setStabilize,
  setFollowMode, cycleFollowMode, snapFollow, followState,
  body: () => body, model: () => model,
})

watch(() => props.autoOrbit, v => { if (controls) controls.autoRotate = v })
watch(() => props.scale, v => {
  if (model) model.scale.setScalar(v)
  follow?.baseOffset.set(0.55 * v, 0.12 * v, 0.72 * v)
  HOME_VEC.set(0, 0.35 * v, 0)
  if (skyGround) {
    skyGround.ground.position.y = -0.003 * v
    skyGround.grid.position.y = -0.0015 * v
  }
})
watch(() => props.follow, v => follow?.setMode(v ? props.followMode : 'off'))
watch(() => props.followMode, v => { if (props.follow) follow?.setMode(v) })
watch(() => props.followDistance, v => follow?.setDistance(v))
watch(() => props.background, v => { if (scene?.fog) scene.fog.color.set(v) })
watch(() => props.stabilize, v => body.setStabilize(v))
watch(() => props.throttle, v => setThrottle(v))
watch(() => props.wind, v => body.setWind(v), { deep: true })
watch(() => props.keyboard, v => {
  if (v) {
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
  } else {
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
  }
})

onMounted(init)
onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  ro?.disconnect()
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
  follow?.dispose()
  skyGround?.dispose()
  controls?.dispose()
  model?.traverse(o => {
    if (o.isMesh) { o.geometry?.dispose(); o.material?.dispose?.() }
  })
  pmrem?.dispose()
  renderer?.dispose()
  renderer?.domElement?.remove()
})
</script>

<style scoped>
.drone-viewer { position: relative; width: 100%; height: 100%; min-height: 320px; overflow: hidden }
.drone-viewer :deep(canvas) { display: block; width: 100%; height: 100% }
.drone-viewer__tip {
  position: absolute; inset: 0; display: grid; place-items: center;
  font: 13px/1.6 system-ui, sans-serif; color: #64768c; background: #10151d;
}
.drone-viewer__err { color: #ff7a5c }
</style>
