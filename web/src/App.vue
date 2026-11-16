<script setup lang="ts">
// 应用外壳：首页 → 飞行配置页 → 飞行页 三段式流程。
//
// 路由用 hash（#/、#/config、#/flight）：不引路由库也能有前进后退，
// 还能让自检脚本直接深链到飞行页（http://127.0.0.1:5188/?terrain=0#/flight）。
import { onBeforeUnmount, onMounted, shallowRef, watch } from 'vue'
import CesiumViewer from './components/CesiumViewer.vue'
import ConfigView from './views/ConfigView.vue'
import FlightView from './views/FlightView.vue'
import HomeView from './views/HomeView.vue'
import { useDroneSim } from './composables/useDroneSim'
import { flightConfig } from './config/flightConfig'
import { loadSavedTakeoff } from './geo/locate'
import type { CesiumScene } from './cesium/CesiumScene'

type Stage = 'home' | 'config' | 'flight'

const sim = useDroneSim()
const scene = shallowRef<CesiumScene | null>(null)
const stage = shallowRef<Stage>(parseHash())
const ready = shallowRef(false)
const error = shallowRef('')
/** 镜头过渡中：防止连点「开始飞行」触发两次起飞 */
const entering = shallowRef(false)
/** 配置页是否已经初始化过：决定首次进入是否沿用上次的起飞点 */
let configPrepared = false

function parseHash(): Stage {
  const h = (window.location.hash || '').toLowerCase()
  if (h.includes('config')) return 'config'
  if (h.includes('flight')) return 'flight'
  return 'home'
}

function go(next: Stage) {
  if (stage.value === next) return
  window.location.hash = '#/' + next
}

function onHashChange() {
  const next = parseHash()
  if (next !== stage.value) stage.value = next
}

onMounted(() => window.addEventListener('hashchange', onHashChange))
onBeforeUnmount(() => window.removeEventListener('hashchange', onHashChange))

/**
 * 按当前阶段调整场景状态。
 *
 * 配置页：镜头自由（用户要环绕地球找点）、点地球即选点；
 * 飞行页：镜头交给跟随相机，点选只在面板显式开启时生效。
 */
function applyStage() {
  const s = scene.value
  if (!s) return
  if (stage.value === 'config') {
    sim.stopFlight()
    s.setFollowMode('free')
    s.setPickMode(true)
    // 首次进入配置页优先沿用上次的起飞点；之后回来就保持当前选点
    const target = configPrepared ? sim.takeoff.place : (loadSavedTakeoff() ?? sim.takeoff.place)
    configPrepared = true
    void sim.previewPlace(target)
  } else if (stage.value === 'flight') {
    s.setPickMode(sim.ui.picking)
  }
}

watch(stage, () => applyStage())

function onReady(next: CesiumScene, stats: { buildings: number }) {
  void stats
  scene.value = next
  sim.attachScene(next)
  ready.value = true
  // 端到端自检钩子（生产可删）
  const dbg = window as unknown as Record<string, unknown>
  dbg.__droneDebug = () => ({
    ready: ready.value,
    stage: stage.value,
    buildings: sim.takeoff.buildings,
    tele: { ...sim.tele },
    ui: { ...sim.ui },
    mp: {
      status: sim.mp.status,
      selfName: sim.mp.selfName,
      worldOrigin: sim.mp.worldOrigin ? { ...sim.mp.worldOrigin } : null,
      players: sim.mp.players.length,
    },
    crash: { ...sim.crash },
    takeoff: { ...sim.takeoff, place: { ...sim.takeoff.place } },
    scene: next.debugSnapshot(),
    audio: sim.audio.debug(),
  })
  dbg.__droneSim = sim
  dbg.__scene = next
  applyStage()
  // 深链直接进飞行页时，按「上次起飞点 → IP 属地 → 默认点」自动落位
  if (stage.value === 'flight') sim.startFlight({ bootstrap: true })
}

function onFail(message: string) {
  error.value = message
}

/** 滚轮：飞行页调跟随距离；配置页交给 Cesium 自己缩放地球 */
function onZoom(deltaY: number) {
  if (stage.value === 'config') return
  sim.zoomBy(deltaY)
}

/** 地图点选：配置页用来选起飞点，飞行页用来临时换点 */
function onPick(point: { lon: number; lat: number }) {
  if (stage.value === 'config') void sim.pickPreview(point.lon, point.lat)
  else void sim.pickTakeoff(point.lon, point.lat)
}

/** 配置页 → 飞行页：落地起飞点 → 起物理循环 → 镜头推进到机载视角 */
async function startFlight() {
  if (entering.value) return
  const s = scene.value
  if (!s) return
  entering.value = true
  try {
    const place = sim.takeoff.place
    // 1. 起飞点落地：加载周边 3D 建筑、复位刚体（镜头保持不动，稍后统一过渡）
    await sim.setTakeoff(place, { keepCamera: true })
    // 复位会把轨迹记录强制打开，这里按配置页的选择再落一次
    sim.setTrailVisible(flightConfig.trailVisible)
    sim.setTrailRecording(flightConfig.trailRecording)
    sim.setTrailColor(flightConfig.trailColor)
    sim.setTrailWidth(flightConfig.trailWidth)
    // 2. 物理循环启动：机体在起飞点上方待命
    sim.startFlight()
    // 3. 初始镜头按配置生效（先只改界面状态，场景等过渡结束再接管）
    sim.setFollowMode(flightConfig.followMode, { apply: false, snap: false })
    go('flight')
    // 4. 镜头从俯视全景推进到追尾 / 云台位姿
    await s.flyIntoFlight({ mode: flightConfig.followMode })
  } finally {
    entering.value = false
  }
}

/** 飞行页 → 配置页：停物理、镜头交回自由视角 */
function backToConfig() {
  sim.stopFlight()
  go('config')
}

/** 回首页：三维地球组件随之卸载，场景资源释放 */
function backHome() {
  sim.stopFlight()
  go('home')
}
</script>

<template>
  <div class="app">
    <HomeView v-if="stage === 'home'" @start="go('config')" />

    <template v-else>
      <CesiumViewer @ready="onReady" @fail="onFail" @zoom="onZoom" @pick="onPick" />

      <ConfigView
        v-if="stage === 'config'"
        :sim="sim"
        :ready="ready"
        @start="startFlight"
        @back="backHome"
      />
      <FlightView v-else :sim="sim" :ready="ready" @configure="backToConfig" @home="backHome" />

      <div v-if="error" class="error">场景初始化失败：{{ error }}</div>
    </template>
  </div>
</template>

<style scoped>
.app {
  position: fixed;
  inset: 0;
  overflow: hidden;
  color: #dbe9f5;
}
.error {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 20;
  padding: 14px 20px;
  border-radius: 10px;
  background: rgba(80, 20, 24, 0.92);
  border: 1px solid rgba(255, 120, 120, 0.5);
  color: #ffd9d9;
  font-size: 13px;
}
</style>
