<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { CesiumScene } from '../cesium/CesiumScene'

const emit = defineEmits<{
  ready: [scene: CesiumScene, stats: { buildings: number }]
  zoom: [deltaY: number]
  fail: [message: string]
  pick: [point: { lon: number; lat: number }]
}>()

const host = ref<HTMLDivElement | null>(null)
const scene = shallowRef<CesiumScene | null>(null)
const loading = ref(true)
const message = ref('初始化三维地球…')

// —— 触屏双指捏合 → 跟随镜头距离（桌面端走 wheel，手机端走这里）——
// 单指拖动不拦截：自由视角下 Cesium 自己的触摸手势照常工作
const pts = new Map<number, { x: number; y: number }>()
let pinchDist = 0

function onPointerDown(e: PointerEvent) {
  if (e.pointerType !== 'touch') return
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (pts.size === 2) {
    const [a, b] = [...pts.values()]
    pinchDist = Math.hypot(a.x - b.x, a.y - b.y)
  }
}

function onPointerMove(e: PointerEvent) {
  if (e.pointerType !== 'touch' || !pts.has(e.pointerId)) return
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (pts.size !== 2 || pinchDist <= 0) return
  const [a, b] = [...pts.values()]
  const dist = Math.hypot(a.x - b.x, a.y - b.y)
  // 捏合（指尖靠近）= 拉远镜头；张开 = 推近。系数把像素差折算到 wheel 的量纲
  emit('zoom', (pinchDist - dist) * 2.2)
  pinchDist = dist
}

function onPointerUp(e: PointerEvent) {
  if (e.pointerType !== 'touch') return
  pts.delete(e.pointerId)
  if (pts.size < 2) pinchDist = 0
}

onMounted(async () => {
  if (!host.value) return
  try {
    // ?terrain=0 关掉真实高程：无头软件渲染下地形会把帧率压到 1 FPS 以下，
    // 飞行回归自检用这个开关绕开它（地形本身另有一份自检）
    const qs = new URLSearchParams(location.search)
    const s = new CesiumScene(host.value, { terrain: qs.get('terrain') !== '0' })
    scene.value = s
    // 点选模式由 useDroneSim 开关，命中后把经纬度交给应用层设起飞点
    s.onGlobePick = (lon, lat) => emit('pick', { lon, lat })
    message.value = '加载地形高程…'
    // 等真实高程接上、原点落在地表再对外宣布就绪：
    // 否则首帧会按椭球高度摆飞机，地形一到位整架机就埋进山里
    await s.ready
    message.value = '加载无人机模型…'
    await s.loadDrone('/models/drone_mini3pro.glb')
    // 周边 3D 建筑由 useDroneSim 按起飞点（IP 属地 / 用户选择）在线拉取，
    // 这里不再固定加载某一处的离线数据
    loading.value = false
    emit('ready', s, { buildings: 0 })
  } catch (err) {
    loading.value = false
    const text = err instanceof Error ? err.message : String(err)
    message.value = text
    emit('fail', text)
    console.error('[cesium] 场景初始化失败', err)
  }
})

onBeforeUnmount(() => {
  scene.value?.destroy()
  scene.value = null
})

function onWheel(e: WheelEvent) {
  emit('zoom', e.deltaY)
}

defineExpose({ scene })
</script>

<template>
  <div
    ref="host"
    class="cesium-host"
    @wheel.prevent="onWheel"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <div v-if="loading" class="loading">
      <span class="spinner" />
      <span>{{ message }}</span>
    </div>
  </div>
</template>

<style scoped>
.cesium-host {
  position: absolute;
  inset: 0;
  background: #0b1520;
  /* 双指捏合与单指手势由 Cesium / 应用层接管：掐掉浏览器的平移缩放 */
  touch-action: none;
}
.cesium-host :deep(.cesium-viewer) {
  position: absolute;
  inset: 0;
}
.cesium-host :deep(.cesium-viewer-bottom) {
  left: 14px;
  bottom: 8px;
  opacity: 0.55;
}
.loading {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 12px;
  justify-content: center;
  color: #cfe2f2;
  font-size: 14px;
  letter-spacing: 0.04em;
  background: radial-gradient(circle at 50% 45%, #16283a 0%, #0b1520 70%);
}
.spinner {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid rgba(120, 200, 255, 0.25);
  border-top-color: #57c8ff;
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
