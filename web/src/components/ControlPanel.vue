<script setup lang="ts">
import type { DroneSim } from '../composables/useDroneSim'
import { hasGoogleMapsKey } from '../cesium/CesiumScene'
import type { FollowMode, ImageryKind } from '../cesium/CesiumScene'

const props = defineProps<{ sim: DroneSim }>()

/** 没配 key 时给按钮一个可解释的状态，而不是让用户点了没反应 */
const hasKey = hasGoogleMapsKey
const googleHint =
  'Google Photorealistic 3D Tiles：摄影测量实景。' +
  '需要 Map Tiles API key（web/.env.local 的 VITE_GOOGLE_MAPS_KEY）；' +
  '覆盖 49 国 2500+ 城市，不含中国大陆，境内直连需要代理'

const cameraModes: { key: FollowMode; label: string }[] = [
  { key: 'chase', label: '追尾' },
  { key: 'world', label: '固定方位' },
  { key: 'fpv', label: '云台视角' },
  { key: 'free', label: '自由' },
]
const imageryModes: { key: ImageryKind; label: string }[] = [
  { key: 'google-3d', label: 'Google 3D 实景' },
  { key: 'esri', label: 'Esri 卫星' },
  { key: 'tianditu', label: '天地图影像' },
  { key: 'tianditu-vec', label: '天地图矢量' },
  { key: 'tianditu-ter', label: '天地图地形' },
]

function onThrottle(e: Event) {
  props.sim.setThrottle(Number((e.target as HTMLInputElement).value) / 100)
}
function onDistance(e: Event) {
  props.sim.setDistance(Number((e.target as HTMLInputElement).value))
}
function onScale(e: Event) {
  props.sim.setDroneScale(Number((e.target as HTMLInputElement).value))
}
function onGimbalPitch(e: Event) {
  props.sim.setGimbal(Number((e.target as HTMLInputElement).value), props.sim.ui.gimbalYaw)
}
function onGimbalYaw(e: Event) {
  props.sim.setGimbal(props.sim.ui.gimbalPitch, Number((e.target as HTMLInputElement).value))
}
function onVolume(e: Event) {
  props.sim.setVolume(Number((e.target as HTMLInputElement).value) / 100)
}
</script>

<template>
  <section class="panel">
    <h2>飞行控制</h2>
    <label class="row">
      <span>油门</span>
      <input
        type="range"
        :min="sim.ui.threeD ? -100 : 0"
        max="100"
        step="0.5"
        :value="sim.ui.throttle * 100"
        :class="{ signed: sim.ui.threeD }"
        @input="onThrottle"
      />
      <b>{{ (sim.ui.throttle * 100).toFixed(0) }}%</b>
    </label>
    <div class="btns">
      <button :class="{ on: sim.ui.stabilize }" @click="sim.setStabilize(true)">增稳</button>
      <button :class="{ on: !sim.ui.stabilize }" @click="sim.setStabilize(false)">手动特技</button>
      <button :class="{ on: sim.ui.threeD }" @click="sim.setThreeD(!sim.ui.threeD)">3D 双向油门</button>
      <button @click="sim.hoverTrim()">悬停配平</button>
      <button :disabled="sim.crash.active || sim.ui.flipping" @click="sim.roll360()">一键横滚</button>
      <button :disabled="sim.crash.active || sim.ui.flipping" @click="sim.invertFlight()">一键倒飞</button>
      <button :class="{ on: sim.ui.wind }" @click="sim.setWind(!sim.ui.wind)">持续侧风</button>
      <button @click="sim.gust()">阵风</button>
      <button @click="sim.impulse()">偏心扰动</button>
      <button :class="{ on: sim.ui.airflow }" @click="sim.setAirflow(!sim.ui.airflow)">空气流场</button>
      <button class="wide" @click="sim.reset()">复位到起始点</button>
    </div>
    <p class="hint">
      增稳：松杆自动改平（倾角受限）。手动特技：角速率直控，按住 A/D 可连续横滚，
      滚到 180° 再给负油门就是倒飞（需打开 3D 双向油门）。建筑与地面为刚体：低速撞击会弹开，
      法向速度 &gt; 5 m/s 时机体解体。
    </p>

    <h2>镜头</h2>
    <div class="btns">
      <button
        v-for="m in cameraModes"
        :key="m.key"
        :class="{ on: sim.ui.followMode === m.key }"
        @click="sim.setFollowMode(m.key)"
      >
        {{ m.label }}
      </button>
      <button @click="sim.snapCamera()">归位</button>
    </div>
    <label class="row">
      <span>距离</span>
      <input type="range" min="3" max="120" step="1" :value="sim.ui.distance" @input="onDistance" />
      <b>{{ sim.ui.distance.toFixed(0) }} m</b>
    </label>

    <h2>云台</h2>
    <label class="row">
      <span>俯仰</span>
      <input
        type="range"
        min="-90"
        max="30"
        step="1"
        :value="sim.ui.gimbalPitch"
        @input="onGimbalPitch"
      />
      <b>{{ sim.ui.gimbalPitch.toFixed(0) }}°</b>
    </label>
    <label class="row">
      <span>偏航</span>
      <input
        type="range"
        min="-90"
        max="90"
        step="1"
        :value="sim.ui.gimbalYaw"
        @input="onGimbalYaw"
      />
      <b>{{ sim.ui.gimbalYaw.toFixed(0) }}°</b>
    </label>
    <div class="btns">
      <button
        class="wide"
        :class="{ on: sim.ui.followMode === 'fpv' }"
        @click="sim.setFollowMode('fpv')"
      >
        云台第一视角飞行
      </button>
      <button @click="sim.resetGimbal()">云台回中</button>
      <button @click="sim.setGimbal(-90)">垂直俯视</button>
    </div>
    <p class="hint">
      云台视角下 ↑↓ 调俯仰、←→ 环视，WASD 照常飞行；三轴增稳保持地平线水平。
    </p>

    <h2>飞行轨迹</h2>
    <div class="btns">
      <button :class="{ on: sim.ui.trail }" @click="sim.setTrailVisible(!sim.ui.trail)">显示轨迹</button>
      <button :class="{ on: sim.ui.trailRecording }" @click="sim.setTrailRecording(!sim.ui.trailRecording)">
        {{ sim.ui.trailRecording ? '记录中' : '已暂停' }}
      </button>
      <button @click="sim.clearTrail()">清空</button>
    </div>
    <p class="hint">已记录 {{ sim.ui.trailPoints }} 点 · 快捷键 T 显隐</p>

    <h2>地图图层</h2>
    <div class="btns">
      <button
        v-for="m in imageryModes"
        :key="m.key"
        :class="{ on: sim.ui.imagery === m.key, unkeyed: m.key === 'google-3d' && !hasKey }"
        :title="m.key === 'google-3d' ? googleHint : ''"
        @click="sim.setImagery(m.key)"
      >
        {{ m.label }}
      </button>
      <button :class="{ on: sim.ui.buildings }" @click="sim.setBuildings(!sim.ui.buildings)">OSM 建筑</button>
    </div>
    <div class="btns">
      <button
        :class="{ on: sim.ui.terrainCollision }"
        title="开启后无人机会与山体、坡面发生真实碰撞（按地表法向弹开并顺坡下滑）"
        @click="sim.setTerrainCollision(!sim.ui.terrainCollision)"
      >
        地形碰撞
      </button>
    </div>
    <p class="hint">
      {{
        sim.ui.terrainCollision
          ? '机体按真实高程与山体碰撞：撞山会沿坡面弹开并顺坡下滑'
          : '已关闭地形碰撞：地面退回水平面，机体可飞进山体'
      }}
    </p>
    <p v-if="sim.ui.mapNote" class="hint warn">{{ sim.ui.mapNote }}</p>
    <p v-else-if="!hasKey" class="hint">
      Google 3D 实景未启用：在 <code>web/.env.local</code> 配 <code>VITE_GOOGLE_MAPS_KEY</code> 后重启
    </p>
    <label class="row">
      <span>机体缩放</span>
      <input type="range" min="1" max="20" step="1" :value="sim.ui.droneScale" @input="onScale" />
      <b>×{{ sim.ui.droneScale.toFixed(0) }}</b>
    </label>

    <h2>声音</h2>
    <div class="btns">
      <button
        class="sound-master"
        :class="{ on: sim.ui.sound }"
        title="总开关（快捷键 M）"
        @click="sim.setSound(!sim.ui.sound)"
      >
        {{ sim.ui.sound ? '声音开' : '已静音' }}
      </button>
      <button :class="{ on: sim.ui.motorSound }" @click="sim.setMotorSound(!sim.ui.motorSound)">电机</button>
      <button :class="{ on: sim.ui.windSound }" @click="sim.setWindSound(!sim.ui.windSound)">风噪</button>
      <button :class="{ on: sim.ui.fxSound }" @click="sim.setFxSound(!sim.ui.fxSound)">撞击</button>
    </div>
    <label class="row">
      <span>音量</span>
      <input type="range" min="0" max="100" step="1" :value="sim.ui.volume * 100" @input="onVolume" />
      <b>{{ (sim.ui.volume * 100).toFixed(0) }}</b>
    </label>
    <p class="hint">
      电机声随四桨转速连续合成（悬停 6000 rpm ≈ 200 Hz，满油 ≈ 300 Hz），
      风噪随空速上升。浏览器策略要求先点一下画面或按任意键才出声。
    </p>
  </section>
</template>

<style scoped>
.panel {
  padding: 12px 14px 16px;
  display: grid;
  gap: 8px;
}
h2 {
  margin: 8px 0 2px;
  font-size: 11px;
  letter-spacing: 0.18em;
  color: #7fb4d8;
  font-weight: 600;
}
h2:first-child {
  margin-top: 0;
}
.row {
  display: grid;
  grid-template-columns: 44px 1fr 42px;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #9ab3c7;
}
.row b {
  text-align: right;
  font-size: 11px;
  color: #e7f2fa;
  font-variant-numeric: tabular-nums;
}
input[type='range'] {
  -webkit-appearance: none;
  height: 3px;
  border-radius: 2px;
  background: rgba(140, 190, 225, 0.25);
  outline: none;
}
/* 3D 双向油门：在滑杆中点画一道零位刻线，负油门一眼可辨 */
input[type='range'].signed {
  background-image: linear-gradient(
    90deg,
    transparent calc(50% - 1px),
    rgba(170, 210, 235, 0.65) calc(50% - 1px),
    rgba(170, 210, 235, 0.65) calc(50% + 1px),
    transparent calc(50% + 1px)
  );
}
/* 3D 双向油门：在滑杆中点画一道零位刻线，负油门一眼可辨 */
input[type='range'].signed {
  background-image: linear-gradient(
    90deg,
    transparent calc(50% - 1px),
    rgba(170, 210, 235, 0.65) calc(50% - 1px),
    rgba(170, 210, 235, 0.65) calc(50% + 1px),
    transparent calc(50% + 1px)
  );
}
input[type='range']::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #57c8ff;
  box-shadow: 0 0 8px rgba(87, 200, 255, 0.7);
  cursor: pointer;
}
.btns {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.hint {
  margin: 0;
  font-size: 11px;
  color: #6f8ba1;
  font-variant-numeric: tabular-nums;
}
.hint.warn {
  color: #ffb454;
}
.hint code {
  padding: 0 3px;
  border-radius: 3px;
  background: rgba(120, 170, 210, 0.13);
  font-size: 10px;
}
/* 未配置 key 的选项：虚线边 + 低调透明度，点下去会给出明确原因 */
button.unkeyed {
  border-style: dashed;
  opacity: 0.72;
}
button {
  flex: 1 1 auto;
  min-width: 62px;
  padding: 6px 8px;
  font-size: 12px;
  color: #b9d3e6;
  background: rgba(28, 54, 76, 0.72);
  border: 1px solid rgba(110, 170, 215, 0.22);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
  font-family: inherit;
}
button:hover {
  border-color: rgba(120, 200, 250, 0.55);
  color: #eaf6ff;
}
button.on {
  color: #04131d;
  background: linear-gradient(180deg, #6fd3ff, #35a9e0);
  border-color: #7fdcff;
  font-weight: 600;
}
button.wide {
  flex-basis: 100%;
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
</style>
