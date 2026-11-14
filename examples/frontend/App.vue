<!--
  Vue3 + Vite 用法示例（已启用六自由度刚体物理）

  准备：
    1. npm i three
    2. 把 DroneViewer.vue 复制到 src/components/DroneViewer.vue
    3. ★ 把 physics/ 整个目录复制到 src/components/physics/
       （DroneViewer.vue 用相对路径 import './physics/drone_physics.js'）
    4. 把 drone_mini3pro.glb 复制到 public/models/drone_mini3pro.glb
    5. 把本文件里 DroneViewer 的 import 路径改成 '@/components/DroneViewer.vue'

  'three/addons/...' 在 npm 方式下由 three 包的 exports 自动解析。
-->
<template>
  <div class="page">
    <div class="bar">
      <label>油门 <input v-model.number="throttle" type="range" min="0" max="1" step="0.01"> {{ (throttle * 100).toFixed(0) }}%</label>
      <label>云台 <input v-model.number="pitch" type="range" min="-90" max="30"> {{ pitch }}°</label>
      <label><input v-model="stabilize" type="checkbox"> 姿态自稳</label>
      <label><input v-model="folded" type="checkbox"> 折叠机臂</label>
      <label><input v-model="keyboard" type="checkbox"> 键盘飞行</label>
      <button @click="gust">阵风</button>
      <button @click="hit">偏心撞击</button>
      <button @click="cycleCam">{{ camLabel }}</button>
      <button @click="snapCam">镜头归位</button>
      <button @click="reset">复位</button>
      <span class="tel">{{ tele }}</span>
    </div>
    <DroneViewer
      ref="viewer"
      class="view"
      url="/models/drone_mini3pro.glb"
      :physics="true"
      :throttle="throttle"
      :stabilize="stabilize"
      :gimbal-pitch="pitch"
      :folded="folded"
      :keyboard="keyboard"
      :scale="1"
      :auto-orbit="false"
      @ready="onReady"
      @error="onError"
      @telemetry="onTelemetry"
    />
  </div>
</template>

<script setup>
import { ref } from 'vue'
import DroneViewer from '../../DroneViewer.vue'   // 复制到项目后改成你的组件路径

const viewer = ref(null)
const throttle = ref(0.455)       // 0.455 × 5.374 N = 2.445 N ≈ mg
const pitch = ref(-12)
const stabilize = ref(true)
const folded = ref(false)
const keyboard = ref(true)
const tele = ref('等待模型…')
const camLabel = ref('跟随：固定方位')
const CAM_LABEL = { world: '跟随：固定方位', body: '跟随：追尾', off: '自由视角' }
function cycleCam() {
  const m = viewer.value?.cycleFollowMode()
  if (m) camLabel.value = CAM_LABEL[m]
}
function snapCam() { viewer.value?.snapFollow() }

function onReady(e) {
  tele.value = `已加载 ${e.nodes.length} 个旋翼 · 质量 ${e.physics.body.mass_kg} kg`
  console.log('根节点 extras:', e.rootExtras)
}
function onError(e) { tele.value = '加载失败: ' + e }
function onTelemetry(t) {
  tele.value =
    `xyz ${t.position.map(x => x.toFixed(2)).join('/')}  ` +
    `v ${t.speed_mps.toFixed(2)} m/s  P/R ${t.pitch_deg.toFixed(0)}°/${t.roll_deg.toFixed(0)}°  ` +
    `RPM ${t.rpm}  动能 ${t.kinetic_energy_j.toFixed(2)} J` +
    (t.contact ? '  [触地]' : '')
}
function reset() {
  viewer.value?.reset()
  throttle.value = 0.455
}
function gust() {
  viewer.value?.setWind([(Math.random() - 0.5) * 0.9, 0, (Math.random() - 0.5) * 0.9])
  setTimeout(() => viewer.value?.setWind([0, 0, 0]), 450)
}
function hit() {
  // 外部冲量：线冲量 N·s + 偏心作用点 → 同时产生角速度，体现转动惯量
  viewer.value?.applyImpulse([0.010, 0.002, -0.006], [0.02, 0.035, 0])
}

// 其它 expose：setThrottle(v) / setStabilize(bool) / getObject(name) / body()
// const r = viewer.value?.getObject('Rotor_FL')
</script>

<style scoped>
.page { display: flex; flex-direction: column; height: 100vh; }
.bar { display: flex; flex-wrap: wrap; gap: 12px; align-items: center;
       padding: 10px 16px; background: #161c26; color: #dfe8f2; font: 13px system-ui, sans-serif; }
.bar label { display: flex; align-items: center; gap: 6px; }
.bar input[type=range] { width: 110px; }
.bar button { background: #1d3b5c; color: #d4e9ff; border: 1px solid #3a6a99;
              border-radius: 6px; padding: 5px 10px; cursor: pointer; }
.tel { margin-left: auto; font-family: Consolas, monospace; color: #7fd5a5; font-size: 12px; }
.view { flex: 1; min-height: 0; }
</style>
