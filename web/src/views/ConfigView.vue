<script setup lang="ts">
// 飞行配置页：机型 / 轨迹 / 初始视角 / 音效 + 起飞点选取。
//
// 左侧是「怎么飞」，右下是「从哪飞」，中间的三维地球既是预览也是选点工具：
// 直接点地球任意位置即可把那里设为起飞点。
import { computed, nextTick, onMounted, ref } from 'vue'
import type { DroneSim } from '../composables/useDroneSim'
import { DRONE_TYPES, getDroneType } from '../config/droneTypes'
import { TRAIL_COLORS, flightConfig, resetFlightConfig } from '../config/flightConfig'
import { parseLatLon, type Place } from '../geo/locate'
import type { FollowMode } from '../cesium/CesiumScene'

const props = defineProps<{ sim: DroneSim; ready?: boolean }>()
const emit = defineEmits<{ start: [payload: { droneId: string; serverUrl: string }]; back: [] }>()

const query = ref('')
const searching = ref(false)
const results = ref<Place[]>([])
const searched = ref(false)
const coordText = ref('')
const coordError = ref('')
const showPresets = ref(false)

/** 开始飞行前的无人机 ID 弹框：确认前不切页、不动地球 */
const showIdDialog = ref(false)
const droneIdInput = ref(localStorage.getItem('drone-mp-name') || '')
const serverUrlInput = ref(localStorage.getItem('drone-mp-url') || props.sim.mp.url)
const idError = ref('')
const joining = ref(false)
const idInputEl = ref<HTMLInputElement | null>(null)

const FOLLOW_OPTIONS: { key: FollowMode; label: string; desc: string }[] = [
  { key: 'chase', label: '追尾镜头', desc: '跟在机尾后方，最适合看姿态与高度' },
  { key: 'world', label: '固定方位', desc: '锁定世界坐标，方位不随机身转' },
  { key: 'fpv', label: '云台第一视角', desc: '机载镜头画面，地平线始终水平' },
]

const drone = computed(() => getDroneType(flightConfig.droneTypeId))
// 场景没就绪前所有选点操作都要挡住：预览要靠场景层搬原点与取景
const busy = computed(
  () => props.sim.takeoff.loading || props.sim.takeoff.locating || !props.ready,
)
const coordView = computed(() => {
  const { lon, lat } = props.sim.takeoff.place
  return `${lat.toFixed(4)}, ${lon.toFixed(4)}`
})
const placeLabel = computed(() => {
  const s = props.sim.takeoff.place.source
  return { ip: 'IP 属地', gps: '浏览器定位', search: '地名搜索', manual: '地图点选', preset: '预设城市' }[s]
})

/** 把配置页的设置整体落到仿真与场景上（进入配置页时先应用一次持久化的配置） */
function applyAll() {
  props.sim.setDroneType(flightConfig.droneTypeId)
  props.sim.setTrailVisible(flightConfig.trailVisible)
  props.sim.setTrailRecording(flightConfig.trailRecording)
  props.sim.setTrailColor(flightConfig.trailColor)
  props.sim.setTrailWidth(flightConfig.trailWidth)
  props.sim.setSound(flightConfig.sound)
}

onMounted(applyAll)

function pickDrone(id: string) {
  flightConfig.droneTypeId = id
  props.sim.setDroneType(id)
}

function toggleTrailVisible() {
  flightConfig.trailVisible = !flightConfig.trailVisible
  props.sim.setTrailVisible(flightConfig.trailVisible)
}

function toggleTrailRecording() {
  flightConfig.trailRecording = !flightConfig.trailRecording
  props.sim.setTrailRecording(flightConfig.trailRecording)
}

function setTrailColor(hex: string) {
  flightConfig.trailColor = hex
  props.sim.setTrailColor(hex)
}

function setTrailWidth(v: number) {
  flightConfig.trailWidth = v
  props.sim.setTrailWidth(v)
}

function setFollow(mode: FollowMode) {
  flightConfig.followMode = mode
}

function toggleSound() {
  flightConfig.sound = !flightConfig.sound
  props.sim.setSound(flightConfig.sound)
}

function restoreDefaults() {
  resetFlightConfig()
  applyAll()
}

async function doSearch() {
  const q = query.value.trim()
  if (!q || searching.value) return
  const coord = parseLatLon(q)
  if (coord) {
    query.value = ''
    results.value = []
    searched.value = false
    await props.sim.pickPreview(coord.lon, coord.lat)
    return
  }
  searching.value = true
  searched.value = true
  try {
    results.value = await props.sim.findPlaces(q)
  } finally {
    searching.value = false
  }
}

async function pick(place: Place) {
  results.value = []
  query.value = ''
  searched.value = false
  await props.sim.previewPlace(place)
}

async function useIp() {
  results.value = []
  await props.sim.previewByIp()
}

async function useGps() {
  results.value = []
  await props.sim.previewByGps()
}

async function applyCoord() {
  coordError.value = ''
  const p = parseLatLon(coordText.value)
  if (!p) {
    coordError.value = '无法识别，示例：39.9026, 116.4602'
    return
  }
  coordText.value = ''
  await props.sim.pickPreview(p.lon, p.lat)
}

/** 点「开始飞行」：先弹 ID 框，确认前仍然停在配置页 */
function requestStart() {
  if (busy.value || !props.ready || showIdDialog.value) return
  droneIdInput.value = localStorage.getItem('drone-mp-name') || ''
  serverUrlInput.value = localStorage.getItem('drone-mp-url') || props.sim.mp.url
  idError.value = ''
  showIdDialog.value = true
  void nextTick(() => idInputEl.value?.focus())
}

function cancelStart() {
  showIdDialog.value = false
  idError.value = ''
  // 连接中取消：把半途的 socket / 面板状态收干净，回到纯单机选点
  if (props.sim.mp.joining || props.sim.mp.status === 'connecting') void props.sim.mpLeave(true)
}

async function confirmStart() {
  if (joining.value) return
  const id = droneIdInput.value.trim()
  if (!id) {
    idError.value = '请输入无人机 ID'
    void nextTick(() => idInputEl.value?.focus())
    return
  }
  const serverUrl = serverUrlInput.value.trim()
  const droneId = id.slice(0, 16)
  const place = props.sim.takeoff.place
  joining.value = true
  idError.value = ''
  try {
    // 先把当前地图选点作为空域原点提交；首个玩家的原点即全服原点，加入成功后才起飞
    const ok = await props.sim.mpJoin(droneId, serverUrl, {
      lon: place.lon,
      lat: place.lat,
      placeName: place.name,
    })
    if (!ok) {
      idError.value = props.sim.mp.error || '加入空域失败，请检查服务器地址或换一个 ID'
      return
    }
    localStorage.setItem('drone-mp-name', droneId)
    localStorage.setItem('drone-mp-url', serverUrl)
    showIdDialog.value = false
    emit('start', { droneId, serverUrl })
  } finally {
    joining.value = false
  }
}
</script>

<template>
  <div class="config">
    <!-- 左侧：飞行配置 -->
    <aside class="panel">
      <header class="head">
        <div>
          <h1>飞行配置</h1>
          <p>配置完成后在地球上选点，镜头会自动推进到机载视角</p>
        </div>
        <button class="ghost" title="返回首页" @click="emit('back')">← 首页</button>
      </header>

      <section class="block">
        <h2>无人机类型</h2>
        <div class="drones">
          <button
            v-for="d in DRONE_TYPES"
            :key="d.id"
            class="drone"
            :class="{ on: flightConfig.droneTypeId === d.id }"
            :style="{ '--accent': d.accent }"
            @click="pickDrone(d.id)"
          >
            <div class="d1">
              <b>{{ d.name }}</b>
              <em>{{ d.tag }}</em>
            </div>
            <p class="desc">{{ d.desc }}</p>
            <div class="specs">
              <span v-for="s in d.specs" :key="s.k"><i>{{ s.k }}</i>{{ s.v }}</span>
            </div>
            <div class="barwrap">
              <span class="bar" :style="{ width: `${(d.maxThrustN / 30) * 100}%`, background: d.accent }" />
            </div>
          </button>
        </div>
        <p class="tip">
          机型决定质量、推重比与角速率上限：穿越机窜升快但难稳住，重载机平缓但笨重。
          悬停油门按机型自动换算。
        </p>
      </section>

      <section class="block">
        <h2>飞行轨迹</h2>
        <div class="row2">
          <button :class="{ on: flightConfig.trailVisible }" @click="toggleTrailVisible">
            轨迹显示
          </button>
          <button :class="{ on: flightConfig.trailRecording }" @click="toggleTrailRecording">
            轨迹记录
          </button>
        </div>
        <div class="colors">
          <button
            v-for="c in TRAIL_COLORS"
            :key="c.value"
            class="swatch"
            :class="{ on: flightConfig.trailColor.toLowerCase() === c.value.toLowerCase() }"
            :style="{ background: c.value }"
            :title="c.label"
            @click="setTrailColor(c.value)"
          />
          <label class="custom" title="自定义颜色">
            <input type="color" :value="flightConfig.trailColor" @input="setTrailColor(($event.target as HTMLInputElement).value)" />
            <span>自定义</span>
          </label>
        </div>
        <label class="slider">
          <span>线宽</span>
          <input
            type="range"
            min="1"
            max="6"
            step="0.2"
            :value="flightConfig.trailWidth"
            @input="setTrailWidth(Number(($event.target as HTMLInputElement).value))"
          />
          <b>{{ flightConfig.trailWidth.toFixed(1) }} px</b>
        </label>
      </section>

      <section class="block">
        <h2>初始视角</h2>
        <div class="views">
          <button
            v-for="v in FOLLOW_OPTIONS"
            :key="v.key"
            :class="{ on: flightConfig.followMode === v.key }"
            @click="setFollow(v.key)"
          >
            <b>{{ v.label }}</b>
            <i>{{ v.desc }}</i>
          </button>
        </div>
      </section>

      <section class="block">
        <h2>音效</h2>
        <div class="row2">
          <button :class="{ on: flightConfig.sound }" @click="toggleSound">
            {{ flightConfig.sound ? '声音开' : '静音' }}
          </button>
          <button class="ghost" @click="restoreDefaults">恢复默认配置</button>
        </div>
      </section>
    </aside>

    <!-- 右下：起飞点 -->
    <section class="place">
      <div class="pl-head">
        <div class="pl-title">
          <b>起飞点</b>
          <span class="src">{{ placeLabel }}</span>
        </div>
        <span class="coord">{{ coordView }}</span>
      </div>
      <p class="pl-name">{{ sim.takeoff.place.name }}</p>

      <div class="pl-btns">
        <button :disabled="busy" @click="useIp">IP 属地</button>
        <button :disabled="busy" @click="useGps">我的位置</button>
        <button class="ghost" @click="showPresets = !showPresets">预设城市</button>
      </div>

      <form class="pl-search" @submit.prevent="doSearch">
        <input
          v-model="query"
          type="text"
          placeholder="搜索地点 / 山峰 / 坐标，如「玉龙雪山」"
          spellcheck="false"
          :disabled="busy"
        />
        <button type="submit" :disabled="searching || busy || !query.trim()">
          {{ searching ? '…' : '搜索' }}
        </button>
      </form>

      <ul v-if="results.length" class="pl-results">
        <li v-for="(r, i) in results" :key="`${r.lon}-${r.lat}-${i}`" @click="pick(r)">
          <b>{{ r.name }}</b>
          <em v-if="r.kind">{{ r.kind }}</em>
          <small>{{ r.lat.toFixed(3) }}, {{ r.lon.toFixed(3) }}</small>
        </li>
      </ul>
      <p v-else-if="searched && !searching" class="pl-hint">没有找到匹配地点，换个关键词或直接输入坐标。</p>

      <div v-if="showPresets" class="pl-presets">
        <button
          v-for="c in sim.presets"
          :key="c.name"
          :disabled="busy"
          @click="pick(c)"
        >
          {{ c.name.split(' · ')[0] }}
        </button>
      </div>

      <details class="pl-fold">
        <summary>输入经纬度</summary>
        <div class="pl-coord">
          <input v-model="coordText" type="text" placeholder="39.9026, 116.4602" spellcheck="false" @keydown.enter.prevent="applyCoord" />
          <button @click="applyCoord">应用</button>
        </div>
        <p v-if="coordError" class="pl-err">{{ coordError }}</p>
      </details>

      <button class="launch" :disabled="busy || !ready" @click="requestStart">
        <span>{{ ready ? '开始飞行' : '三维地球加载中…' }}</span>
        <em>{{ drone.name }} · {{ flightConfig.followMode === 'fpv' ? '云台第一视角' : flightConfig.followMode === 'world' ? '固定方位' : '追尾镜头' }}</em>
      </button>
      <p class="pl-tip">在三维地球上直接点击任意位置即可设定起飞点</p>
      <p v-if="sim.takeoff.error" class="pl-err">{{ sim.takeoff.error }}</p>
      <p v-else-if="sim.takeoff.note" class="pl-hint">{{ sim.takeoff.note }}</p>
    </section>

    <div class="maphint">
      <span class="pin">◎</span>
      <span>点击三维地球任意位置设为起飞点 · 左键拖动可环绕 · 滚轮缩放（可拉远至全球）</span>
    </div>

    <!-- 无人机 ID / 空域名称：起飞前确认，取消时地球与选点原样保留 -->
    <Transition name="modal">
      <div v-if="showIdDialog" class="modal-mask" @click.self="cancelStart">
        <div class="id-dialog" role="dialog" aria-modal="true" aria-labelledby="id-title">
          <div class="id-icon">ID</div>
          <h2 id="id-title">输入无人机 ID</h2>
          <p class="id-desc">
            作为你在全球空域里的唯一名称。确认后从当前选点
            <b>{{ sim.takeoff.place.name }}</b> 起飞；你是首个加入者时，这个点就是全服空域原点。
          </p>
          <form @submit.prevent="confirmStart">
            <label for="drone-id">无人机 ID</label>
            <input
              id="drone-id"
              ref="idInputEl"
              v-model="droneIdInput"
              type="text"
              maxlength="16"
              placeholder="例如：MINI3-001"
              autocomplete="off"
              spellcheck="false"
              @keydown.esc.prevent="cancelStart"
            />
            <label class="server-label" for="mp-url">服务器（留空 = 同源）</label>
            <input
              id="mp-url"
              v-model="serverUrlInput"
              type="text"
              placeholder="http://127.0.0.1:5190"
              autocomplete="off"
              spellcheck="false"
            />
            <p v-if="idError" class="id-err">{{ idError }}</p>
            <p class="id-note">名称全局唯一，重名会被服务器拒绝；加入状态在飞行页侧栏查看。</p>
            <div class="id-actions">
              <button type="button" class="ghost" :disabled="joining" @click="cancelStart">返回选点</button>
              <button type="submit" class="confirm" :disabled="joining">
                {{ joining ? '连接中…' : '加入空域并开始飞行' }}
              </button>
            </div>
          </form>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.config {
  position: absolute;
  inset: 0;
  z-index: 10;
  pointer-events: none;
  color: #dbe9f5;
}
.panel {
  pointer-events: auto;
  position: absolute;
  top: 16px;
  left: 16px;
  bottom: 16px;
  width: 372px;
  overflow-y: auto;
  padding: 18px 18px 22px;
  border-radius: 14px;
  border: 1px solid rgba(110, 170, 210, 0.22);
  background: linear-gradient(180deg, rgba(9, 22, 33, 0.94), rgba(7, 16, 25, 0.96));
  box-shadow: 0 22px 60px rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(12px);
}
.panel::-webkit-scrollbar {
  width: 6px;
}
.panel::-webkit-scrollbar-thumb {
  background: rgba(110, 170, 210, 0.3);
  border-radius: 3px;
}
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}
.head h1 {
  margin: 0 0 4px;
  font-size: 18px;
  letter-spacing: 0.1em;
  color: #f1f8ff;
}
.head p {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: #7e9cb4;
}
.block {
  padding-top: 14px;
  margin-top: 14px;
  border-top: 1px solid rgba(90, 140, 180, 0.16);
}
.block h2 {
  margin: 0 0 10px;
  font-size: 11px;
  letter-spacing: 0.2em;
  color: #7fb4d8;
  font-weight: 600;
}
.drones {
  display: grid;
  gap: 8px;
}
.drone {
  text-align: left;
  padding: 11px 12px 12px;
  border-radius: 10px;
  background: rgba(20, 40, 58, 0.6);
  border: 1px solid rgba(110, 170, 215, 0.18);
  color: inherit;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.16s ease;
}
.drone:hover {
  border-color: color-mix(in srgb, var(--accent) 55%, transparent);
}
.drone.on {
  border-color: var(--accent);
  background: rgba(22, 48, 68, 0.85);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent) inset;
}
.d1 {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.d1 b {
  font-size: 13.5px;
  color: #eaf6ff;
}
.d1 em {
  font-style: normal;
  font-size: 10px;
  color: var(--accent);
  border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
  border-radius: 999px;
  padding: 1px 6px;
}
.desc {
  margin: 6px 0 8px;
  font-size: 11px;
  line-height: 1.6;
  color: #89a9c0;
}
.specs {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 4px;
  margin-bottom: 8px;
}
.specs span {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 11px;
  color: #d5e8f6;
  font-variant-numeric: tabular-nums;
}
.specs i {
  font-style: normal;
  font-size: 9.5px;
  color: #6f8ba1;
}
.barwrap {
  height: 3px;
  border-radius: 2px;
  background: rgba(140, 190, 225, 0.16);
  overflow: hidden;
}
.bar {
  display: block;
  height: 100%;
  border-radius: 2px;
}
.tip {
  margin: 10px 0 0;
  font-size: 10.5px;
  line-height: 1.6;
  color: #6f8ba1;
}
.row2 {
  display: flex;
  gap: 6px;
}
.colors {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 10px 0 8px;
  flex-wrap: wrap;
}
.swatch {
  width: 24px;
  height: 24px;
  border-radius: 7px;
  border: 2px solid rgba(255, 255, 255, 0.14);
  cursor: pointer;
  padding: 0;
  transition: transform 0.14s ease;
}
.swatch:hover {
  transform: scale(1.12);
}
.swatch.on {
  border-color: #fff;
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.18);
}
.custom {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10.5px;
  color: #8fb0c6;
  cursor: pointer;
}
.custom input {
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid rgba(110, 170, 215, 0.3);
  border-radius: 7px;
  background: transparent;
  cursor: pointer;
}
.slider {
  display: grid;
  grid-template-columns: 40px 1fr 52px;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  color: #9ab3c7;
}
.slider b {
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
input[type='range']::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #57c8ff;
  box-shadow: 0 0 8px rgba(87, 200, 255, 0.7);
  cursor: pointer;
}
.views {
  display: grid;
  gap: 6px;
}
.views button {
  display: grid;
  gap: 3px;
  text-align: left;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(20, 40, 58, 0.6);
  border: 1px solid rgba(110, 170, 215, 0.18);
  color: inherit;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.16s ease;
}
.views button b {
  font-size: 12.5px;
  color: #e2f0fa;
}
.views button i {
  font-style: normal;
  font-size: 10.5px;
  color: #7e9cb4;
}
.views button.on {
  border-color: rgba(120, 200, 250, 0.6);
  background: rgba(24, 58, 84, 0.85);
}
.views button.on b {
  color: #8fe6ff;
}
button {
  font-family: inherit;
}
.panel button,
.place button {
  flex: 1 1 auto;
  padding: 7px 9px;
  font-size: 12px;
  color: #b9d3e6;
  background: rgba(28, 54, 76, 0.72);
  border: 1px solid rgba(110, 170, 215, 0.22);
  border-radius: 7px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.panel button:hover:not(:disabled),
.place button:hover:not(:disabled) {
  border-color: rgba(120, 200, 250, 0.55);
  color: #eaf6ff;
}
button.on {
  color: #04131d;
  background: linear-gradient(180deg, #7fe0ff, #35a9e0);
  border-color: #8fe6ff;
  font-weight: 600;
}
button.ghost {
  background: transparent;
  color: #8fb0c6;
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}

/* —— 起飞点卡片 —— */
.place {
  pointer-events: auto;
  position: absolute;
  right: 16px;
  bottom: 16px;
  width: 360px;
  padding: 14px 15px 15px;
  border-radius: 14px;
  border: 1px solid rgba(110, 170, 210, 0.22);
  background: linear-gradient(180deg, rgba(9, 22, 33, 0.94), rgba(7, 16, 25, 0.96));
  box-shadow: 0 22px 60px rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(12px);
}
.pl-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}
.pl-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.pl-title b {
  font-size: 13px;
  letter-spacing: 0.12em;
  color: #7fb4d8;
}
.src {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  color: #8fd2ff;
  background: rgba(70, 150, 205, 0.22);
}
.coord {
  font-size: 11px;
  color: #8fb0c6;
  font-variant-numeric: tabular-nums;
}
.pl-name {
  margin: 4px 0 10px;
  font-size: 15px;
  color: #eef7ff;
  font-weight: 600;
}
.pl-btns {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
}
.pl-search {
  display: flex;
  gap: 6px;
}
.pl-search input,
.pl-coord input {
  flex: 1;
  min-width: 0;
  padding: 7px 9px;
  font-size: 12px;
  font-family: inherit;
  color: #dceaf5;
  background: rgba(14, 30, 44, 0.8);
  border: 1px solid rgba(110, 170, 215, 0.22);
  border-radius: 7px;
  outline: none;
}
.pl-search input:focus,
.pl-coord input:focus {
  border-color: rgba(120, 200, 250, 0.55);
}
.pl-search input::placeholder,
.pl-coord input::placeholder {
  color: #5f7b90;
}
.pl-results {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: grid;
  gap: 2px;
  max-height: 168px;
  overflow-y: auto;
}
.pl-results li {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: baseline;
  gap: 4px 8px;
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(24, 46, 66, 0.6);
  cursor: pointer;
}
.pl-results li:hover {
  background: rgba(45, 85, 120, 0.75);
}
.pl-results b {
  font-size: 12px;
  font-weight: 500;
  color: #e2f0fa;
}
.pl-results em {
  font-style: normal;
  font-size: 9.5px;
  color: #8fd2ff;
  background: rgba(70, 150, 205, 0.22);
  border-radius: 3px;
  padding: 0 4px;
}
.pl-results small {
  grid-column: 1 / -1;
  font-size: 10px;
  color: #7c96ab;
  font-variant-numeric: tabular-nums;
}
.pl-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 8px;
}
.pl-presets button {
  flex: 0 0 auto;
  min-width: 0;
  padding: 4px 8px;
  font-size: 11px;
}
.pl-fold {
  margin-top: 8px;
}
.pl-fold summary {
  font-size: 11px;
  color: #8fb0c6;
  cursor: pointer;
  list-style: none;
}
.pl-fold summary::-webkit-details-marker {
  display: none;
}
.pl-fold summary::before {
  content: '＋ ';
  color: #6f8ba1;
}
.pl-fold[open] summary::before {
  content: '－ ';
}
.pl-coord {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}
.pl-hint {
  margin: 8px 0 0;
  font-size: 11px;
  color: #8fb0c6;
  line-height: 1.5;
}
.pl-err {
  margin: 8px 0 0;
  font-size: 11px;
  color: #ffb08a;
}
.launch {
  width: 100%;
  margin-top: 12px;
  padding: 11px 12px !important;
  display: grid;
  gap: 2px;
  font-size: 14px !important;
  font-weight: 600;
  color: #04131d !important;
  background: linear-gradient(180deg, #7fe0ff, #35a9e0) !important;
  border-color: #8fe6ff !important;
  border-radius: 9px !important;
}
.launch em {
  font-style: normal;
  font-size: 10px;
  font-weight: 400;
  color: rgba(4, 19, 29, 0.66);
}
.launch:disabled {
  opacity: 0.5;
}
.pl-tip {
  margin: 7px 0 0;
  text-align: center;
  font-size: 10.5px;
  color: #5f7b90;
}
.maphint {
  pointer-events: none;
  position: absolute;
  left: 50%;
  top: 18px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 14px;
  border-radius: 999px;
  border: 1px solid rgba(110, 210, 255, 0.4);
  background: rgba(10, 34, 48, 0.82);
  font-size: 12px;
  color: #d8f2ff;
  backdrop-filter: blur(8px);
}
.maphint .pin {
  color: #7fe0ff;
}

/* —— 无人机 ID 弹框 —— */
.modal-mask {
  pointer-events: auto;
  position: absolute;
  inset: 0;
  z-index: 30;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgba(3, 10, 16, 0.68);
  backdrop-filter: blur(4px);
}
.id-dialog {
  width: min(420px, 100%);
  padding: 24px 26px 22px;
  border-radius: 14px;
  background: linear-gradient(180deg, rgba(13, 30, 44, 0.98), rgba(8, 19, 29, 0.98));
  border: 1px solid rgba(120, 200, 250, 0.42);
  box-shadow: 0 28px 80px rgba(0, 0, 0, 0.62);
}
.id-icon {
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  margin-bottom: 12px;
  border-radius: 10px;
  color: #04131d;
  background: linear-gradient(180deg, #7fe0ff, #35a9e0);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
}
.id-dialog h2 {
  margin: 0 0 8px;
  font-size: 18px;
  letter-spacing: 0.06em;
  color: #f1f8ff;
}
.id-desc {
  margin: 0 0 18px;
  font-size: 12px;
  line-height: 1.7;
  color: #9ab8cd;
}
.id-desc b {
  color: #8fe6ff;
  font-weight: 600;
}
.id-dialog label {
  display: block;
  margin-bottom: 6px;
  font-size: 11px;
  letter-spacing: 0.12em;
  color: #7fb4d8;
}
.id-dialog label.server-label {
  margin-top: 12px;
}
.id-dialog input {
  width: 100%;
  padding: 10px 12px;
  font-size: 13px;
  font-family: inherit;
  color: #eaf6ff;
  background: rgba(14, 30, 44, 0.9);
  border: 1px solid rgba(110, 170, 215, 0.4);
  border-radius: 8px;
  outline: none;
}
.id-dialog input:focus {
  border-color: #8fe6ff;
  box-shadow: 0 0 0 3px rgba(87, 200, 255, 0.14);
}
.id-err {
  margin: 10px 0 0;
  font-size: 11px;
  color: #ffb08a;
}
.id-note {
  margin: 10px 0 0;
  font-size: 10.5px;
  line-height: 1.6;
  color: #6f8ba1;
}
.id-actions {
  display: flex;
  gap: 8px;
  margin-top: 18px;
}
.id-actions button {
  flex: 1 1 auto;
  padding: 10px 12px !important;
  font-family: inherit;
  font-size: 12px;
  border-radius: 8px;
  cursor: pointer;
}
.id-actions .ghost {
  color: #9ab8cd !important;
  background: rgba(28, 54, 76, 0.6) !important;
  border: 1px solid rgba(110, 170, 215, 0.32) !important;
}
.id-actions .confirm {
  color: #04131d !important;
  background: linear-gradient(180deg, #7fe0ff, #35a9e0) !important;
  border-color: #8fe6ff !important;
  font-weight: 600;
}
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.18s ease;
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
@media (max-width: 1080px) {
  .panel {
    width: 320px;
  }
  .place {
    width: 320px;
  }
}
</style>
