<script setup lang="ts">
// 飞行界面：顶栏、侧栏（起飞点 / 飞行控制）、屏幕内遥测、云台取景框与撞毁提示。
import { computed } from 'vue'
import ControlPanel from '../components/ControlPanel.vue'
import FlightHud from '../components/FlightHud.vue'
import MultiplayerPanel from '../components/MultiplayerPanel.vue'
import TakeoffPanel from '../components/TakeoffPanel.vue'
import TouchControls from '../components/TouchControls.vue'
import type { DroneSim } from '../composables/useDroneSim'
import type { ImageryKind } from '../cesium/CesiumScene'

const props = defineProps<{ sim: DroneSim; ready?: boolean }>()
const emit = defineEmits<{ configure: []; home: [] }>()

const IMAGERY_LABEL: Record<ImageryKind, string> = {
  'google-3d': 'Google 3D 实景',
  esri: 'Esri 卫星',
  'esri-street': 'Esri 街道',
  tianditu: '天地图影像',
  'tianditu-vec': '天地图矢量',
  'tianditu-ter': '天地图地形',
}
const imageryLabel = computed(() => IMAGERY_LABEL[props.sim.ui.imagery])
const followLabel = computed(
  () =>
    ({ chase: '追尾镜头', world: '固定方位', fpv: '云台 FPV', free: '自由视角' })[
      props.sim.ui.followMode
    ],
)
const fpvMode = computed(() => props.sim.ui.followMode === 'fpv' && !props.sim.crash.active)
const gimbalLabel = computed(
  () => `${props.sim.ui.gimbalPitch.toFixed(0)}° / ${props.sim.ui.gimbalYaw.toFixed(0)}°`,
)
const modeLabel = computed(() => {
  const mode = props.sim.ui.stabilize ? '增稳' : '手动特技'
  return props.sim.ui.threeD ? `${mode} · 3D` : mode
})
/** 多人状态徽标：只在联机相关状态时出现，不占单机玩家的视觉空间 */
const mpChip = computed(() => {
  const s = props.sim.mp
  if (s.status === 'joined') return { text: `全球空域 · ${s.players.length} 人`, cls: 'ok' }
  if (s.status === 'reconnecting') return { text: '空域重连中…', cls: 'wait' }
  if (s.status === 'connecting' || s.joining) return { text: '空域连接中…', cls: 'wait' }
  return null
})
</script>

<template>
  <div class="flight">
    <header class="topbar">
      <div class="brand">
        <span class="pulse" />
        <div class="titles">
          <strong>无人机模拟器</strong>
          <small>{{ sim.takeoff.place.name }} · 3D 建筑 {{ sim.takeoff.buildings }} 栋</small>
        </div>
      </div>
      <div class="status">
        <span v-if="mpChip" class="chip" :class="mpChip.cls">{{ mpChip.text }}</span>
        <span class="chip" :class="sim.crash.active ? 'bad' : ready ? 'ok' : 'wait'">
          {{ sim.crash.active ? '机体已损毁' : ready ? '场景就绪' : '加载中' }}
        </span>
        <span class="chip">{{ followLabel }}</span>
        <span class="chip" :class="{ manual: !sim.ui.stabilize || sim.ui.threeD }">{{ modeLabel }}</span>
        <button
          class="fpv-toggle"
          :class="{ on: sim.ui.followMode === 'fpv' }"
          title="云台第一视角（快捷键 F）"
          @click="sim.toggleFpv()"
        >
          {{ sim.ui.followMode === 'fpv' ? '退出云台视角' : '云台第一视角' }}
        </button>
        <button class="toggle" :class="{ on: sim.ui.hud && !fpvMode }" title="屏幕内飞行遥测（快捷键 H）" @click="sim.setHud(!sim.ui.hud)">
          {{ sim.ui.hud ? 'HUD 开' : 'HUD 关' }}
        </button>
        <button
          class="toggle"
          :class="{ on: sim.ui.touchControls }"
          title="虚拟摇杆（触屏设备默认开启）"
          @click="sim.setTouchControls(!sim.ui.touchControls)"
        >
          摇杆
        </button>
        <button
          class="toggle"
          :class="{ on: sim.ui.panelOpen }"
          title="展开 / 收起侧栏面板（手机端收起后地图全屏）"
          @click="sim.setPanelOpen(!sim.ui.panelOpen)"
        >
          面板
        </button>
        <button class="toggle" @click="emit('configure')" title="回到飞行配置页">
          重新配置
        </button>
        <button class="toggle" @click="emit('home')" title="返回首页">首页</button>
        <button class="toggle" @click="sim.reset()">复位</button>
        <button
          class="toggle sound-toggle"
          :class="{ on: sim.ui.sound }"
          title="声音开关（快捷键 M）"
          @click="sim.setSound(!sim.ui.sound)"
        >
          {{ sim.ui.sound ? '声音开' : '静音' }}
        </button>
      </div>
    </header>

    <aside class="sidebar" :class="{ closed: !sim.ui.panelOpen }">
      <MultiplayerPanel :sim="sim" />
      <TakeoffPanel :sim="sim" />
      <ControlPanel :sim="sim" />
    </aside>

    <!-- 屏幕内遥测：直接叠在画面上，FPV 时由取景框自带的读数接管 -->
    <FlightHud
      v-if="sim.ui.hud && !fpvMode"
      :tele="sim.tele"
      :buildings="sim.takeoff.buildings"
      :imagery="imageryLabel"
      :gimbal="gimbalLabel"
    />

    <!-- 触屏虚拟摇杆（Mode 2）：触屏设备默认显示，桌面可从顶栏开启 -->
    <TouchControls v-if="sim.ui.touchControls" :sim="sim" />

    <!-- 地图点选：临时模式，点一次即设点 -->
    <Transition name="pick">
      <div v-if="sim.ui.picking" class="pickbar">
        <span class="pin">◎</span>
        <span>拖动 / 缩放地图，点击任意位置设为起飞点</span>
        <button @click="sim.cancelPick()">取消 · Esc</button>
      </div>
    </Transition>

    <div class="hintbar">
      <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 姿态 ·
      <kbd>空格</kbd>/<kbd>Shift</kbd> 油门 ·
      <kbd>Q</kbd><kbd>E</kbd> 偏航 ·
      <kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd> 云台 ·
      <kbd>F</kbd> 云台视角 · <kbd>X</kbd> 云台回中 ·
      <kbd>C</kbd> 镜头 · <kbd>V</kbd> 归位 ·
      <kbd>Z</kbd> 3D 油门 · <kbd>K</kbd> 横滚 · <kbd>L</kbd> 倒飞 ·
      <kbd>G</kbd> 阵风 · <kbd>I</kbd> 扰动 · <kbd>R</kbd> 复位 ·
      <kbd>H</kbd> HUD · <kbd>M</kbd> 静音 · 滚轮调距离
    </div>

    <!-- 云台第一视角取景框：只做视觉参考，不拦截鼠标 -->
    <div v-if="fpvMode" class="fpv">
      <div class="fpv-vignette" />
      <i class="corner tl" /><i class="corner tr" /><i class="corner bl" /><i class="corner br" />
      <div class="reticle"><span class="ring" /><span class="h" /><span class="v" /></div>
      <div class="fpv-hud">
        <b>GIMBAL FPV</b>
        <b v-if="sim.tele.inverted" class="inv">倒飞</b>
        <span>俯仰 {{ sim.ui.gimbalPitch.toFixed(0) }}° · 偏航 {{ sim.ui.gimbalYaw.toFixed(0) }}°</span>
        <span>高度 {{ sim.tele.altitude.toFixed(1) }} m · {{ sim.tele.speed.toFixed(1) }} m/s</span>
        <span>油门 {{ (sim.tele.throttle * 100).toFixed(0) }}%</span>
      </div>
      <div class="fpv-tip"><kbd>F</kbd> 退出云台视角 · <kbd>X</kbd> 云台回中 · <kbd>↑</kbd><kbd>↓</kbd> 俯仰</div>
    </div>

    <!-- 撞击：全屏闪光 + 溢出提示 -->
    <div v-if="sim.crash.active" :key="`flash-${sim.crash.time}`" class="flash" />
    <Transition name="crash">
      <div v-if="sim.crash.prompt" class="crash">
        <div class="card">
          <div class="badge">!</div>
          <h3>机体撞毁</h3>
          <p class="cause">撞击对象：{{ sim.crash.target }}</p>
          <p class="num">
            法向撞击速度 <b>{{ sim.crash.impact.toFixed(1) }}</b> m/s
            <span>（阈值 5.0 m/s）</span>
          </p>
          <p class="tip">飞行已终止。请从起始点重新开始。</p>
          <button @click="sim.restart()">从起始点重新飞行</button>
          <small>也可按 R 复位</small>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.flight {
  position: absolute;
  inset: 0;
  pointer-events: none;
  color: #dbe9f5;
}
.topbar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 18px;
  background: linear-gradient(180deg, rgba(8, 18, 28, 0.86), rgba(8, 18, 28, 0));
  pointer-events: none;
  z-index: 6;
}
.brand {
  display: flex;
  align-items: center;
  gap: 12px;
}
.pulse {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #57ffb0;
  box-shadow: 0 0 0 0 rgba(87, 255, 176, 0.55);
  animation: pulse 2.4s ease-out infinite;
}
@keyframes pulse {
  70% {
    box-shadow: 0 0 0 9px rgba(87, 255, 176, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(87, 255, 176, 0);
  }
}
.titles strong {
  display: block;
  font-size: 15px;
  letter-spacing: 0.06em;
  color: #f1f8ff;
}
.titles small {
  font-size: 11px;
  color: #8fb0c8;
  letter-spacing: 0.04em;
}
.status {
  display: flex;
  align-items: center;
  gap: 8px;
  pointer-events: auto;
}
.chip {
  font-size: 11px;
  padding: 3px 9px;
  border-radius: 999px;
  border: 1px solid rgba(120, 180, 220, 0.28);
  color: #a9c8dd;
  background: rgba(12, 28, 40, 0.66);
}
.chip.ok {
  color: #7ff0b8;
  border-color: rgba(90, 230, 165, 0.5);
}
.chip.bad {
  color: #ff8a8a;
  border-color: rgba(255, 110, 110, 0.6);
  background: rgba(70, 14, 18, 0.72);
}
.chip.wait {
  color: #ffce7a;
  border-color: rgba(255, 190, 90, 0.45);
}
.chip.manual {
  color: #ffce7a;
  border-color: rgba(255, 190, 90, 0.45);
}

/* —— 撞击闪光 / 毁伤提示 —— */
.flash {
  position: absolute;
  inset: 0;
  z-index: 8;
  pointer-events: none;
  background: radial-gradient(circle at 50% 48%, rgba(255, 246, 214, 0.92) 0%, rgba(255, 138, 60, 0.55) 32%, rgba(255, 60, 20, 0) 68%);
  animation: flashOut 0.55s ease-out forwards;
}
@keyframes flashOut {
  from {
    opacity: 1;
  }
  to {
    opacity: 0;
  }
}
.crash {
  position: absolute;
  inset: 0;
  z-index: 9;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding-bottom: 9vh;
  background: linear-gradient(180deg, rgba(6, 12, 18, 0) 45%, rgba(6, 12, 18, 0.34));
  pointer-events: none;
}
.crash .card {
  pointer-events: auto;
}
.card {
  width: min(420px, calc(100vw - 48px));
  padding: 26px 28px 22px;
  border-radius: 14px;
  text-align: center;
  background: linear-gradient(180deg, rgba(46, 16, 16, 0.96), rgba(20, 12, 14, 0.97));
  border: 1px solid rgba(255, 120, 90, 0.45);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 150, 90, 0.12) inset;
  animation: cardIn 0.32s cubic-bezier(0.2, 1.2, 0.4, 1);
}
@keyframes cardIn {
  from {
    opacity: 0;
    transform: translateY(14px) scale(0.96);
  }
}
.badge {
  width: 46px;
  height: 46px;
  margin: 0 auto 12px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 26px;
  font-weight: 700;
  color: #2b0b06;
  background: radial-gradient(circle at 40% 35%, #ffd28a, #ff6a24 70%);
  box-shadow: 0 0 26px rgba(255, 120, 50, 0.55);
}
.card h3 {
  margin: 0 0 10px;
  font-size: 20px;
  letter-spacing: 0.1em;
  color: #ffe2d6;
}
.card .cause {
  margin: 0 0 6px;
  font-size: 13px;
  color: #ffb8a3;
}
.card .num {
  margin: 0 0 10px;
  font-size: 12px;
  color: #e6c4b8;
  font-variant-numeric: tabular-nums;
}
.card .num b {
  font-size: 16px;
  color: #ffd3a8;
}
.card .num span {
  color: #b49084;
}
.card .tip {
  margin: 0 0 16px;
  font-size: 12px;
  color: #c9a99e;
}
.card button {
  width: 100%;
  padding: 10px 14px;
  font-family: inherit;
  font-size: 14px;
  font-weight: 600;
  color: #2a0d06;
  background: linear-gradient(180deg, #ffc98c, #ff8a3c);
  border: 1px solid #ffcf9a;
  border-radius: 8px;
  cursor: pointer;
}
.card button:hover {
  filter: brightness(1.06);
}
.card small {
  display: block;
  margin-top: 9px;
  font-size: 11px;
  color: #a3817a;
}
.crash-enter-active,
.crash-leave-active {
  transition: opacity 0.25s ease;
}
.crash-enter-from,
.crash-leave-to {
  opacity: 0;
}
.toggle {
  font-family: inherit;
  font-size: 12px;
  color: #cfe6f5;
  padding: 5px 11px;
  border-radius: 6px;
  border: 1px solid rgba(120, 180, 220, 0.3);
  background: rgba(18, 40, 58, 0.8);
  cursor: pointer;
}
.toggle.on {
  color: #8fe6ff;
  border-color: rgba(110, 210, 255, 0.55);
  background: rgba(20, 62, 90, 0.86);
}

/* —— 地图点选提示条 —— */
.pickbar {
  position: absolute;
  left: 50%;
  top: 76px;
  transform: translateX(-50%);
  z-index: 8;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px 8px 14px;
  border-radius: 999px;
  border: 1px solid rgba(110, 210, 255, 0.5);
  background: rgba(10, 34, 48, 0.92);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
  font-size: 12px;
  color: #d8f2ff;
  backdrop-filter: blur(8px);
}
.pickbar .pin {
  color: #7fe0ff;
  font-size: 15px;
  line-height: 1;
}
.pickbar button {
  font-family: inherit;
  font-size: 11px;
  color: #bcd8e8;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid rgba(120, 180, 220, 0.32);
  background: rgba(20, 44, 62, 0.9);
  cursor: pointer;
}
.pickbar button:hover {
  color: #fff;
  border-color: rgba(140, 220, 255, 0.6);
}
.pick-enter-active,
.pick-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.pick-enter-from,
.pick-leave-to {
  opacity: 0;
  transform: translate(-50%, -6px);
}
.fpv-toggle {
  font-family: inherit;
  font-size: 12px;
  color: #d8f2ff;
  padding: 5px 12px;
  border-radius: 6px;
  border: 1px solid rgba(90, 200, 255, 0.45);
  background: rgba(18, 58, 84, 0.78);
  cursor: pointer;
  transition: all 0.15s ease;
}
.fpv-toggle:hover {
  border-color: rgba(140, 225, 255, 0.9);
  color: #f2fbff;
}
.fpv-toggle.on {
  color: #04131d;
  background: linear-gradient(180deg, #7fe0ff, #35a9e0);
  border-color: #8fe6ff;
  font-weight: 600;
}
.sidebar {
  position: absolute;
  top: 68px;
  right: 16px;
  width: 320px;
  max-height: calc(100vh - 150px);
  overflow-y: auto;
  pointer-events: auto;
  border-radius: 12px;
  border: 1px solid rgba(110, 170, 210, 0.22);
  background: linear-gradient(180deg, rgba(10, 24, 36, 0.92), rgba(8, 19, 29, 0.94));
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(10px);
  z-index: 7;
  /* 收合动画：桌面端与手机端共用「面板」开关 */
  transition: transform 0.24s ease, opacity 0.18s ease;
}
.sidebar.closed {
  transform: translateX(112%);
  opacity: 0;
  pointer-events: none;
}
.sidebar::-webkit-scrollbar {
  width: 6px;
}
.sidebar::-webkit-scrollbar-thumb {
  background: rgba(110, 170, 210, 0.3);
  border-radius: 3px;
}
.hintbar {
  position: absolute;
  left: 18px;
  bottom: 16px;
  z-index: 6;
  font-size: 11px;
  color: #a8c4d8;
  letter-spacing: 0.02em;
  background: rgba(8, 20, 30, 0.72);
  border: 1px solid rgba(110, 170, 210, 0.18);
  border-radius: 8px;
  padding: 8px 12px;
  max-width: min(720px, calc(100vw - 390px));
  line-height: 1.9;
  backdrop-filter: blur(6px);
}
/* —— 云台第一视角取景框 —— */
.fpv {
  position: absolute;
  inset: 0;
  z-index: 5;
  pointer-events: none;
  overflow: hidden;
}
.fpv-vignette {
  position: absolute;
  inset: 0;
  background: radial-gradient(
    ellipse at 50% 50%,
    rgba(0, 0, 0, 0) 56%,
    rgba(3, 9, 14, 0.34) 100%
  );
}
.corner {
  position: absolute;
  width: 26px;
  height: 26px;
  border: 0 solid rgba(150, 220, 255, 0.62);
  filter: drop-shadow(0 0 6px rgba(60, 170, 230, 0.35));
}
.corner.tl {
  left: 22px;
  top: 72px;
  border-left-width: 2px;
  border-top-width: 2px;
  border-top-left-radius: 4px;
}
.corner.tr {
  right: 22px;
  top: 72px;
  border-right-width: 2px;
  border-top-width: 2px;
  border-top-right-radius: 4px;
}
.corner.bl {
  left: 22px;
  bottom: 66px;
  border-left-width: 2px;
  border-bottom-width: 2px;
  border-bottom-left-radius: 4px;
}
.corner.br {
  right: 22px;
  bottom: 66px;
  border-right-width: 2px;
  border-bottom-width: 2px;
  border-bottom-right-radius: 4px;
}
.reticle {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 46px;
  height: 46px;
  transform: translate(-50%, -50%);
}
.reticle .ring {
  position: absolute;
  inset: 12px;
  border: 1px solid rgba(205, 240, 255, 0.86);
  border-radius: 50%;
  box-shadow: 0 0 12px rgba(80, 190, 245, 0.45);
}
.reticle .h,
.reticle .v {
  position: absolute;
  background: rgba(185, 235, 255, 0.72);
}
.reticle .h {
  left: 0;
  right: 0;
  top: 50%;
  height: 1px;
  mask-image: linear-gradient(90deg, #000 0 30%, transparent 30% 70%, #000 70% 100%);
}
.reticle .v {
  top: 0;
  bottom: 0;
  left: 50%;
  width: 1px;
  mask-image: linear-gradient(180deg, #000 0 30%, transparent 30% 70%, #000 70% 100%);
}
.fpv-hud {
  position: absolute;
  left: 50%;
  top: 74px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 7px 14px;
  border-radius: 8px;
  background: rgba(6, 16, 24, 0.62);
  border: 1px solid rgba(120, 200, 240, 0.28);
  backdrop-filter: blur(6px);
  font-size: 11px;
  color: #b6d8ec;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.fpv-hud b {
  font-size: 10px;
  letter-spacing: 0.16em;
  color: #7fe0ff;
}
.fpv-hud b.inv {
  color: #ffcf6a;
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid rgba(255, 190, 90, 0.55);
  background: rgba(90, 50, 8, 0.5);
}
.fpv-tip {
  position: absolute;
  right: 22px;
  bottom: 22px;
  font-size: 11px;
  color: #9dc0d6;
  background: rgba(6, 16, 24, 0.6);
  border: 1px solid rgba(110, 170, 210, 0.2);
  border-radius: 7px;
  padding: 6px 10px;
}
@media (max-width: 900px) {
  .corner,
  .fpv-tip {
    display: none;
  }
}

kbd {
  display: inline-block;
  min-width: 16px;
  text-align: center;
  padding: 1px 4px;
  margin: 0 1px;
  font-size: 10px;
  font-family: ui-monospace, Consolas, monospace;
  color: #d7ecfb;
  background: rgba(60, 110, 150, 0.35);
  border: 1px solid rgba(140, 200, 240, 0.3);
  border-radius: 4px;
}
@media (max-width: 900px) {
  /* 手机端：侧栏变成右侧抽屉（面板按钮开合），地图 / 摇杆占据全屏 */
  .sidebar {
    top: calc(52px + var(--safe-top));
    right: 0;
    bottom: 0;
    width: min(86vw, 360px);
    max-height: none;
    border-radius: 12px 0 0 0;
    padding-bottom: var(--safe-bottom);
  }
  .hintbar {
    display: none;
  }
}
@media (max-width: 640px) {
  /* 窄屏顶栏：贴安全区、允许换行、小按钮；遥测类 chip 让位 */
  .topbar {
    padding: var(--safe-top) 10px 0;
    height: auto;
    min-height: 48px;
    flex-wrap: wrap;
    gap: 6px;
  }
  .brand .titles strong {
    font-size: 13px;
  }
  .brand .titles small {
    display: none;
  }
  .status {
    gap: 5px;
  }
  .status .chip:not(.ok):not(.bad):not(.wait) {
    display: none; /* 镜头/模式 chip 在窄屏让位给按钮 */
  }
  .toggle,
  .fpv-toggle {
    font-size: 11px;
    padding: 4px 8px;
  }
}
</style>
