<script setup lang="ts">
import { computed, ref } from 'vue'
import type { DroneSim } from '../composables/useDroneSim'
import { parseLatLon, type Place } from '../geo/locate'

const props = defineProps<{ sim: DroneSim }>()

const query = ref('')
const searching = ref(false)
const results = ref<Place[]>([])
const open = ref(true)
const searched = ref(false)
const coordText = ref('')
const coordError = ref('')

const sourceLabel = computed(() => {
  const s = props.sim.takeoff.place.source
  return { ip: 'IP 属地', gps: '浏览器定位', search: '地名搜索', manual: '手动选点', preset: '预设城市' }[s]
})
const busy = computed(
  () =>
    props.sim.takeoff.loading ||
    props.sim.takeoff.locating ||
    // 联机中锁起飞点：房间绑定了原点，所有换点入口一起禁用（函数内还有兜底）
    props.sim.mp.status === 'joined' ||
    props.sim.mp.status === 'reconnecting',
)
const picking = computed(() => props.sim.ui.picking)
const coordView = computed(() => {
  const { lon, lat } = props.sim.takeoff.place
  return `${lat.toFixed(4)}, ${lon.toFixed(4)}`
})

async function doSearch() {
  const q = query.value.trim()
  if (!q || searching.value) return
  // 输入本身就是坐标时直接跳过去，不必再走一次地名服务
  const coord = parseLatLon(q)
  if (coord) {
    query.value = ''
    results.value = []
    searched.value = false
    await props.sim.pickTakeoff(coord.lon, coord.lat, '已按输入坐标设定起飞点')
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

function pick(place: Place) {
  results.value = []
  query.value = ''
  searched.value = false
  void props.sim.setTakeoff(place)
}

async function useIp() {
  results.value = []
  await props.sim.locateIp()
}

async function useGps() {
  results.value = []
  await props.sim.locateGps()
}

/** 坐标输入：支持「纬度, 经度」或「经度, 纬度」，也接受带 N/E 后缀 */
async function applyCoord() {
  coordError.value = ''
  const p = parseLatLon(coordText.value)
  if (!p) {
    coordError.value = '无法识别，示例：39.9026, 116.4602'
    return
  }
  coordText.value = ''
  await props.sim.pickTakeoff(p.lon, p.lat, '已按输入坐标设定起飞点')
}
</script>

<template>
  <section class="panel">
    <header class="head" @click="open = !open">
      <h2>起飞点</h2>
      <span class="chev" :class="{ up: open }">⌃</span>
    </header>

    <template v-if="open">
      <div class="current">
        <div class="line1">
          <b>{{ sim.takeoff.place.name }}</b>
          <span class="src">{{ sourceLabel }}</span>
        </div>
        <div class="coord">{{ coordView }}</div>
        <div class="meta">
          <span v-if="sim.takeoff.loading">正在生成周边 3D 建筑…</span>
          <span v-else-if="sim.takeoff.buildings">
            {{ sim.takeoff.buildings }} 栋 3D 建筑 · {{ sim.takeoff.tiles }} 张瓦片
          </span>
          <span v-else>周边无 3D 建筑，仍可自由飞行</span>
        </div>
      </div>

      <div class="btns">
        <button :disabled="busy" @click="useIp">IP 属地</button>
        <button :disabled="busy" @click="useGps">我的位置</button>
        <button class="pick" :class="{ on: picking }" :disabled="busy" @click="sim.startPick()">
          {{ picking ? '取消点选' : '地图点选' }}
        </button>
      </div>

      <form class="search" @submit.prevent="doSearch">
        <input
          v-model="query"
          type="text"
          placeholder="搜索地点 / 山峰 / 坐标"
          spellcheck="false"
          :disabled="busy"
        />
        <button type="submit" :disabled="searching || !query.trim()">
          {{ searching ? '…' : '搜索' }}
        </button>
      </form>

      <ul v-if="results.length" class="results">
        <li v-for="(r, i) in results" :key="`${r.lon}-${r.lat}-${i}`" @click="pick(r)">
          <div class="r1">
            <b>{{ r.name }}</b>
            <em v-if="r.kind">{{ r.kind }}</em>
          </div>
          <small>{{ r.detail }}</small>
          <span class="rc">{{ r.lat.toFixed(3) }}, {{ r.lon.toFixed(3) }}</span>
        </li>
      </ul>
      <p v-else-if="searched && !searching" class="hint">没有找到匹配地点，换个关键词或直接输入坐标。</p>

      <details class="fold">
        <summary>输入经纬度</summary>
        <div class="coordrow">
          <input
            v-model="coordText"
            type="text"
            placeholder="39.9026, 116.4602"
            spellcheck="false"
            @keydown.enter.prevent="applyCoord"
          />
          <button @click="applyCoord">应用</button>
        </div>
        <p class="hint dim">纬度在前；首个数值大于 90 时按「经度, 纬度」解析。</p>
        <p v-if="coordError" class="err">{{ coordError }}</p>
      </details>

      <details class="fold">
        <summary>预设城市</summary>
        <div class="presets">
          <button v-for="c in sim.presets" :key="c.name" :disabled="busy" @click="pick(c)">
            {{ c.name.split(' · ')[0] }}
          </button>
        </div>
      </details>

      <p v-if="sim.takeoff.error" class="err">{{ sim.takeoff.error }}</p>
      <p v-else-if="sim.takeoff.note" class="hint">{{ sim.takeoff.note }}</p>
      <p class="hint dim">可定位到地球任意位置：城市、山峰、湖泊或无人区。非城市区域没有 3D 建筑，地形按椭球处理。</p>
    </template>
  </section>
</template>

<style scoped>
.panel {
  padding: 12px 14px 14px;
  display: grid;
  gap: 8px;
  border-bottom: 1px solid rgba(90, 140, 180, 0.16);
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  user-select: none;
}
h2 {
  margin: 0;
  font-size: 11px;
  letter-spacing: 0.18em;
  color: #7fb4d8;
  font-weight: 600;
}
.chev {
  font-size: 11px;
  color: #6f8ba1;
  transform: rotate(180deg);
  transition: transform 0.18s ease;
}
.chev.up {
  transform: rotate(0deg);
}
.current {
  padding: 8px 10px;
  border-radius: 7px;
  background: rgba(20, 40, 58, 0.66);
  border: 1px solid rgba(100, 160, 205, 0.2);
  display: grid;
  gap: 3px;
}
.line1 {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.line1 b {
  font-size: 13px;
  color: #eaf6ff;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.src {
  flex: none;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  color: #8fd2ff;
  background: rgba(70, 150, 205, 0.2);
}
.coord {
  font-size: 11px;
  color: #9ab3c7;
  font-variant-numeric: tabular-nums;
}
.meta {
  font-size: 10.5px;
  color: #6f8ba1;
  font-variant-numeric: tabular-nums;
}
.btns {
  display: flex;
  gap: 6px;
}
.pick.on {
  color: #ffd08a;
  border-color: rgba(255, 190, 90, 0.55);
  background: rgba(70, 48, 14, 0.7);
}
.search {
  display: flex;
  gap: 6px;
}
.search input,
.coordrow input {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  font-size: 12px;
  font-family: inherit;
  color: #dceaf5;
  background: rgba(14, 30, 44, 0.8);
  border: 1px solid rgba(110, 170, 215, 0.22);
  border-radius: 6px;
  outline: none;
}
.search input:focus,
.coordrow input:focus {
  border-color: rgba(120, 200, 250, 0.55);
}
.search input::placeholder,
.coordrow input::placeholder {
  color: #5f7b90;
}
.results {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 2px;
  max-height: 186px;
  overflow-y: auto;
}
.results li {
  padding: 5px 8px;
  border-radius: 5px;
  background: rgba(24, 46, 66, 0.6);
  cursor: pointer;
  display: grid;
  gap: 1px;
}
.results li:hover {
  background: rgba(45, 85, 120, 0.75);
}
.r1 {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.r1 b {
  font-size: 12px;
  color: #e2f0fa;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.r1 em {
  flex: none;
  font-style: normal;
  font-size: 9.5px;
  padding: 0 4px;
  border-radius: 3px;
  color: #8fd2ff;
  background: rgba(70, 150, 205, 0.22);
}
.results small {
  font-size: 10.5px;
  color: #7c96ab;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rc {
  font-size: 9.5px;
  color: #5f7b90;
  font-variant-numeric: tabular-nums;
}
.fold summary {
  font-size: 11px;
  color: #8fb0c6;
  cursor: pointer;
  user-select: none;
  list-style: none;
  padding: 2px 0;
}
.fold summary::-webkit-details-marker {
  display: none;
}
.fold summary::before {
  content: '＋ ';
  color: #6f8ba1;
}
.fold[open] summary::before {
  content: '－ ';
}
.coordrow {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}
.presets {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}
.presets button {
  flex: 0 0 auto;
  min-width: 0;
  padding: 4px 8px;
  font-size: 11px;
}
.hint {
  margin: 0;
  font-size: 11px;
  color: #8fb0c6;
  line-height: 1.45;
}
.hint.dim {
  color: #5f7b90;
  font-size: 10.5px;
}
.err {
  margin: 0;
  font-size: 11px;
  color: #ffb08a;
  line-height: 1.45;
}
button {
  flex: 1 1 auto;
  min-width: 56px;
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
button:hover:not(:disabled) {
  border-color: rgba(120, 200, 250, 0.55);
  color: #eaf6ff;
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
</style>
