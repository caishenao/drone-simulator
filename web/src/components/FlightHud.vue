<script setup lang="ts">
// 屏幕内飞行遥测：直接叠在画面上，飞行时不必把视线移开去右侧面板。
// 只做展示（pointer-events: none），不拦截镜头拖拽与地图点选。
import { computed } from 'vue'
import type { TelemetryView } from '../composables/useDroneSim'

const props = defineProps<{
  tele: TelemetryView
  buildings: number
  imagery: string
  gimbal: string
}>()

const f = (v: number, d = 1) => v.toFixed(d)
const sign = (v: number, d = 1) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`

/** 油门条：3D 双向油门时从中线向左右伸缩，负值一眼可见 */
const throttlePct = computed(() => Math.max(-100, Math.min(100, props.tele.throttle * 100)))
const throttleStyle = computed(() => {
  const v = throttlePct.value
  return v >= 0
    ? { left: '50%', width: `${v / 2}%` }
    : { right: '50%', width: `${-v / 2}%` }
})
</script>

<template>
  <section class="hud">
    <header>
      <span class="dot" :class="{ bad: props.tele.contact }" />
      <b>FLIGHT</b>
      <span v-if="props.tele.inverted" class="inv">倒飞</span>
      <span class="fps">{{ f(props.tele.fps, 0) }} FPS</span>
    </header>

    <div class="primary">
      <div class="big">
        <b>{{ f(props.tele.altitude) }}</b>
        <small>m 高度</small>
      </div>
      <div class="big">
        <b>{{ f(props.tele.speed) }}</b>
        <small>m/s 速度</small>
      </div>
    </div>

    <div class="grid">
      <div class="kv"><span>垂速</span><b>{{ sign(props.tele.vertical) }}</b></div>
      <div class="kv"><span>航向</span><b>{{ f(props.tele.heading, 0) }}°</b></div>
      <div class="kv"><span>俯仰</span><b>{{ sign(props.tele.pitch) }}°</b></div>
      <div class="kv"><span>横滚</span><b>{{ sign(props.tele.roll) }}°</b></div>
    </div>

    <div class="throttle">
      <div class="bar">
        <span class="zero" />
        <i :style="throttleStyle" :class="{ neg: throttlePct < 0 }" />
      </div>
      <div class="row">
        <span>油门</span>
        <b>{{ f(throttlePct, 0) }}%</b>
      </div>
    </div>

    <div class="grid minor">
      <div class="kv"><span>离地</span><b>{{ f(Math.max(0, props.tele.clearance)) }} m</b></div>
      <div class="kv"><span>海拔</span><b>{{ f(props.tele.elevation, 0) }} m</b></div>
      <div class="kv"><span>桨速</span><b>{{ Math.round(props.tele.rpm).toLocaleString() }}</b></div>
    </div>

    <footer>
      <span>{{ f(props.tele.lat, 4) }}, {{ f(props.tele.lon, 4) }}</span>
      <span>{{ props.buildings }} 栋 · {{ props.imagery }} · 云台 {{ props.gimbal }}</span>
    </footer>
  </section>
</template>

<style scoped>
.hud {
  position: absolute;
  left: 18px;
  top: 74px;
  width: 232px;
  z-index: 6;
  padding: 10px 12px 9px;
  border-radius: 10px;
  border: 1px solid rgba(110, 170, 210, 0.2);
  background: linear-gradient(180deg, rgba(9, 22, 33, 0.82), rgba(7, 17, 26, 0.88));
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(8px);
  font-variant-numeric: tabular-nums;
  pointer-events: none;
  user-select: none;
}
header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}
header b {
  font-size: 9.5px;
  letter-spacing: 0.2em;
  color: #79c8f2;
  font-weight: 700;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #57ffb0;
  box-shadow: 0 0 6px rgba(87, 255, 176, 0.7);
}
.dot.bad {
  background: #ffb454;
  box-shadow: 0 0 6px rgba(255, 180, 84, 0.8);
}
.inv {
  font-size: 9.5px;
  padding: 1px 5px;
  border-radius: 3px;
  color: #ffb454;
  border: 1px solid rgba(255, 180, 84, 0.55);
  background: rgba(80, 48, 10, 0.5);
}
.fps {
  margin-left: auto;
  font-size: 9.5px;
  color: #6d8ca4;
  letter-spacing: 0.04em;
}
.primary {
  position: relative;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(110, 170, 210, 0.14);
}
/* 两列读数之间的细分隔，避免 150.0 与 0.0 连成一片 */
.primary::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 1px;
  bottom: 9px;
  width: 1px;
  background: rgba(110, 170, 210, 0.16);
}
.big b {
  display: block;
  font-size: 21px;
  line-height: 1.05;
  color: #f2f9ff;
  font-weight: 600;
  letter-spacing: -0.02em;
}
.big small {
  font-size: 9.5px;
  color: #7d9cb4;
  letter-spacing: 0.04em;
}
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px 10px;
  padding-top: 7px;
}
.kv {
  display: flex;
  justify-content: space-between;
  gap: 4px;
  font-size: 10.5px;
  color: #7f9cb1;
}
.kv b {
  color: #ddecf7;
  font-weight: 600;
}
.minor {
  padding-top: 4px;
}
.throttle {
  padding-top: 6px;
  display: grid;
  gap: 3px;
}
.throttle .bar {
  position: relative;
  height: 5px;
  border-radius: 3px;
  background: rgba(120, 170, 210, 0.16);
  overflow: hidden;
}
.throttle .bar i {
  position: absolute;
  top: 0;
  bottom: 0;
  background: linear-gradient(90deg, #3fa9e0, #7fe0ff);
  border-radius: 3px;
  transition: width 0.08s linear;
}
.throttle .bar i.neg {
  background: linear-gradient(90deg, #ffc46b, #ff8a4c);
}
.throttle .bar .zero {
  position: absolute;
  left: 50%;
  top: -1px;
  bottom: -1px;
  width: 1px;
  background: rgba(200, 230, 250, 0.5);
  z-index: 1;
}
.throttle .row {
  display: flex;
  justify-content: space-between;
  font-size: 10.5px;
  color: #7f9cb1;
}
.throttle .row b {
  color: #ddecf7;
  font-weight: 600;
}
footer {
  display: grid;
  gap: 1px;
  margin-top: 7px;
  padding-top: 6px;
  border-top: 1px solid rgba(110, 170, 210, 0.14);
  font-size: 9.5px;
  color: #648298;
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
