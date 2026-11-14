<script setup lang="ts">
// 移动端虚拟摇杆（遥控器 Mode 2 布局）：
//   · 左摇杆：竖向 = 油门（松手保持，与真遥控器一致），横向 = 偏航（松手回中）
//   · 右摇杆：竖向 = 俯仰，横向 = 横滚（松手回中）
//  多点触控：每个摇杆用 Pointer Events + setPointerCapture 锁定自己的指针，
//  双手同时操作互不串扰；中央快捷键给高频动作（复位 / 镜头 / 云台视角）。
import { computed, onBeforeUnmount, reactive } from 'vue'
import type { DroneSim } from '../composables/useDroneSim'

const props = defineProps<{ sim: DroneSim }>()

/** 摇杆死区：中心附近的微小抖动不产生杆量 */
const DEAD_ZONE = 0.07

interface StickState {
  active: boolean
  /** 指针相对摇杆中心的偏移（-1..1，已含死区切除） */
  x: number
  y: number
  /** 跟踪中的 pointerId（多点触控关键：同一手指始终驱动同一摇杆） */
  pointerId: number | null
  /** 中心相对视口的坐标（pointerdown 时快照，避免布局抖动） */
  cx: number
  cy: number
  /** 摇杆可拖半径（px） */
  radius: number
}

function newStick(): StickState {
  return { active: false, x: 0, y: 0, pointerId: null, cx: 0, cy: 0, radius: 56 }
}

const left = reactive(newStick())
const right = reactive(newStick())

const knobStyle = (s: StickState) => ({
  transform: `translate(${s.x * s.radius}px, ${s.y * s.radius}px)`,
})

/** 把指针偏移归一化到 -1..1 并切死区 */
function normalize(dx: number, dy: number, radius: number) {
  const len = Math.hypot(dx, dy)
  const k = len > radius ? radius / len : 1
  let nx = (dx * k) / radius
  let ny = (dy * k) / radius
  if (Math.hypot(nx, ny) < DEAD_ZONE) {
    nx = 0
    ny = 0
  }
  return { nx, ny }
}

function onLeftDown(e: PointerEvent) {
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture(e.pointerId)
  const r = el.getBoundingClientRect()
  left.cx = r.left + r.width / 2
  left.cy = r.top + r.height / 2
  left.pointerId = e.pointerId
  left.active = true
  onLeftMove(e)
}

function onLeftMove(e: PointerEvent) {
  if (left.pointerId !== e.pointerId) return
  // 左摇杆：y 越往上油门越大（屏幕坐标 y 向下，取负）；油门松手保持
  const { nx, ny } = normalize(e.clientX - left.cx, e.clientY - left.cy, left.radius)
  left.x = nx
  left.y = ny
  props.sim.touchInput.yaw = nx
  // 油门杆量 = 0.5（中位）+ 上偏量：默认悬停油门附近起步，上推加油、下拉减油
  props.sim.touchInput.throttle = -ny
}

function onLeftUp(e: PointerEvent) {
  if (left.pointerId !== e.pointerId) return
  left.pointerId = null
  left.active = false
  // 偏航回中；油门保持当前位置（真遥控器左杆不自动回中）
  left.x = 0
  left.y = 0
  props.sim.touchInput.yaw = 0
  props.sim.touchInput.throttle = 0
}

function onRightDown(e: PointerEvent) {
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture(e.pointerId)
  const r = el.getBoundingClientRect()
  right.cx = r.left + r.width / 2
  right.cy = r.top + r.height / 2
  right.pointerId = e.pointerId
  right.active = true
  onRightMove(e)
}

function onRightMove(e: PointerEvent) {
  if (right.pointerId !== e.pointerId) return
  const { nx, ny } = normalize(e.clientX - right.cx, e.clientY - right.cy, right.radius)
  right.x = nx
  right.y = ny
  // 与键盘同向：W（上推）= 俯仰向前（-1）
  props.sim.touchInput.pitch = -ny
  props.sim.touchInput.roll = nx
}

function onRightUp(e: PointerEvent) {
  if (right.pointerId !== e.pointerId) return
  right.pointerId = null
  right.active = false
  right.x = 0
  right.y = 0
  props.sim.touchInput.pitch = 0
  props.sim.touchInput.roll = 0
}

/** 离开页面时兜底清零：别让杆量卡在某个值上 */
function resetAll() {
  left.pointerId = null
  left.active = false
  left.x = 0
  left.y = 0
  right.pointerId = null
  right.active = false
  right.x = 0
  right.y = 0
  props.sim.touchInput.pitch = 0
  props.sim.touchInput.roll = 0
  props.sim.touchInput.yaw = 0
  props.sim.touchInput.throttle = 0
}
window.addEventListener('pagehide', resetAll)
onBeforeUnmount(() => {
  window.removeEventListener('pagehide', resetAll)
  resetAll()
})

const throttlePct = computed(() => `${(props.sim.ui.throttle * 100).toFixed(0)}%`)
</script>

<template>
  <div class="sticks" :class="{ 'panel-open': sim.ui.panelOpen }" aria-hidden="false">
    <!-- 左摇杆：油门 + 偏航 -->
    <div
      class="stick left"
      :class="{ active: left.active }"
      @pointerdown.prevent="onLeftDown"
      @pointermove.prevent="onLeftMove"
      @pointerup.prevent="onLeftUp"
      @pointercancel.prevent="onLeftUp"
    >
      <div class="ring throttle-ring">
        <i class="mid" />
      </div>
      <div class="knob" :style="knobStyle(left)">
        <span class="axis-h">◀ 偏航 ▶</span>
        <b>{{ throttlePct }}</b>
        <span class="axis-v">▲油门<br />▼油门</span>
      </div>
    </div>

    <!-- 中央快捷键：高频动作不进抽屉 -->
    <div class="quick">
      <button title="复位（R）" @click="sim.reset()">复位</button>
      <button title="切换镜头（C）" @click="sim.cycleCamera()">镜头</button>
      <button
        title="云台第一视角（F）"
        :class="{ on: sim.ui.followMode === 'fpv' }"
        @click="sim.toggleFpv()"
      >
        FPV
      </button>
    </div>

    <!-- 右摇杆：俯仰 + 横滚 -->
    <div
      class="stick right"
      :class="{ active: right.active }"
      @pointerdown.prevent="onRightDown"
      @pointermove.prevent="onRightMove"
      @pointerup.prevent="onRightUp"
      @pointercancel.prevent="onRightUp"
    >
      <div class="ring" />
      <div class="knob" :style="knobStyle(right)">
        <span class="axis-h">◀ 横滚 ▶</span>
        <span class="axis-v">▲俯仰<br />▼俯仰</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sticks {
  position: absolute;
  inset: 0;
  z-index: 7;
  pointer-events: none; /* 容器不拦截：面板/地图照常可点，只有摇杆自己吃指针 */
}
.stick {
  position: absolute;
  bottom: calc(18px + var(--safe-bottom));
  width: 132px;
  height: 132px;
  touch-action: none; /* 掐掉浏览器手势，指针事件连续 */
  pointer-events: auto;
  border-radius: 50%;
  background: radial-gradient(circle at 50% 50%, rgba(16, 40, 60, 0.4) 0%, rgba(10, 24, 36, 0.28) 100%);
  border: 1px solid rgba(120, 190, 235, 0.3);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(4px);
}
.stick.left {
  left: 14px;
}
.stick.right {
  right: 14px;
}
.stick.active {
  border-color: rgba(140, 215, 255, 0.65);
}
.ring {
  position: absolute;
  inset: 14px;
  border-radius: 50%;
  border: 1px dashed rgba(120, 190, 235, 0.28);
}
.throttle-ring .mid {
  position: absolute;
  left: 8px;
  right: 8px;
  top: 50%;
  height: 1px;
  background: rgba(160, 215, 245, 0.4);
}
.knob {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 56px;
  height: 56px;
  margin: -28px 0 0 -28px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  text-align: center;
  color: #cfe8f8;
  font-size: 8px;
  line-height: 1.35;
  background: radial-gradient(circle at 38% 32%, rgba(150, 220, 255, 0.5), rgba(40, 110, 160, 0.85));
  border: 1px solid rgba(160, 220, 255, 0.55);
  box-shadow: 0 0 14px rgba(80, 180, 240, 0.35);
  pointer-events: none; /* 指针事件落在底座上，knob 纯视觉 */
  transition: box-shadow 0.15s ease;
}
.stick.active .knob {
  box-shadow: 0 0 20px rgba(120, 210, 255, 0.7);
}
.knob b {
  font-size: 11px;
  color: #eaf7ff;
  font-variant-numeric: tabular-nums;
}
.axis-h {
  position: absolute;
  top: 3px;
  white-space: nowrap;
}
.axis-v {
  position: absolute;
  bottom: 3px;
  white-space: nowrap;
}
.quick {
  position: absolute;
  bottom: calc(64px + var(--safe-bottom));
  left: 50%;
  transform: translateX(-50%);
  display: grid;
  gap: 8px;
  justify-items: center;
  pointer-events: auto;
}
.quick button {
  width: 52px;
  height: 34px;
  font-size: 11px;
  font-family: inherit;
  color: #cfe6f5;
  background: rgba(18, 40, 58, 0.8);
  border: 1px solid rgba(120, 180, 220, 0.35);
  border-radius: 8px;
  cursor: pointer;
}
.quick button.on {
  color: #04131d;
  background: linear-gradient(180deg, #7fe0ff, #35a9e0);
  border-color: #8fe6ff;
  font-weight: 600;
}
@media (max-height: 560px) {
  /* 横屏矮视口：摇杆缩一格，别盖住 HUD */
  .stick {
    width: 108px;
    height: 108px;
    bottom: calc(10px + var(--safe-bottom));
  }
  .ring {
    inset: 10px;
  }
  .knob {
    width: 48px;
    height: 48px;
    margin: -24px 0 0 -24px;
  }
  .quick {
    bottom: calc(48px + var(--safe-bottom));
  }
}
@media (max-width: 900px) {
  /* 手机端抽屉打开时隐藏摇杆：面板压在摇杆区上方，两层同时可点会互相误触。
     收起面板（顶栏「面板」按钮）即恢复操控 */
  .sticks.panel-open {
    display: none;
  }
}
</style>
