<script setup lang="ts">
// 首页：功能入口卡片。当前只有「3D 地图飞行」是可用入口，
// 其余卡片先占位，等对应模块落地再接。
const emit = defineEmits<{ start: [] }>()

interface Feature {
  id: string
  name: string
  desc: string
  tag: string
  enabled: boolean
  accent: string
}

const features: Feature[] = [
  {
    id: 'map-flight',
    name: '3D 地图飞行',
    desc: '在真实三维地球上选点起飞，配置机型与飞行轨迹，镜头一路推进到机载视角。',
    tag: '可进入',
    enabled: true,
    accent: '#5ad1ff',
  },
  {
    id: 'route',
    name: '航线规划',
    desc: '按测绘任务编排航点与参数，自动生成最优航线。',
    tag: '建设中',
    enabled: false,
    accent: '#57ffb0',
  },
  {
    id: 'fleet',
    name: '机队管理',
    desc: '多机编队、任务分发与状态回传。',
    tag: '建设中',
    enabled: false,
    accent: '#ffb547',
  },
  {
    id: 'replay',
    name: '数据回放',
    desc: '导入飞行日志与点云，事后复盘每一次姿态与落点。',
    tag: '建设中',
    enabled: false,
    accent: '#9d7bff',
  },
]
</script>

<template>
  <div class="home">
    <div class="grid-bg" />
    <header class="bar">
      <div class="brand">
        <span class="logo">
          <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true">
            <g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
              <circle cx="16" cy="16" r="4.2" />
              <circle cx="7" cy="7" r="3" />
              <circle cx="25" cy="7" r="3" />
              <circle cx="7" cy="25" r="3" />
              <circle cx="25" cy="25" r="3" />
              <path d="M9.4 9.4 13.6 13.6M22.6 9.4 18.4 13.6M9.4 22.6 13.6 18.4M22.6 22.6 18.4 18.4" />
            </g>
          </svg>
        </span>
        <div class="titles">
          <strong>无人机模拟器</strong>
          <small>Drone Simulator · 六自由度飞行与地形碰撞</small>
        </div>
      </div>
      <div class="meta">
        <span class="chip">Cesium 三维地球</span>
        <span class="chip">真实高程碰撞</span>
        <span class="chip">Web Audio 音效</span>
      </div>
    </header>

    <main class="main">
      <section class="hero">
        <p class="eyebrow">FLIGHT CONSOLE</p>
        <h1>选一处起飞点，<br />把整机交给三维地球。</h1>
        <p class="lead">
          配置机型与飞行轨迹，在全球任意角落（城市、山区、无人区）选定起飞位置，
          镜头自动从俯视全景推进到无人机第一视角。
        </p>
        <button class="cta" @click="emit('start')">
          <span>进入 3D 地图飞行</span>
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path
              d="M5 12h13M13 6l6 6-6 6"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </section>

      <section class="cards">
        <button
          v-for="f in features"
          :key="f.id"
          class="card"
          :class="{ disabled: !f.enabled, active: f.enabled }"
          :style="{ '--accent': f.accent }"
          :disabled="!f.enabled"
          @click="f.enabled && emit('start')"
        >
          <span class="tag" :class="{ live: f.enabled }">{{ f.tag }}</span>
          <h2>{{ f.name }}</h2>
          <p>{{ f.desc }}</p>
          <span v-if="f.enabled" class="go">进入配置 →</span>
          <span v-else class="go dim">敬请期待</span>
        </button>
      </section>
    </main>

    <footer class="foot">
      <span>无人机模拟器 v0.2 · 前端 Vue 3 + Cesium</span>
      <span>键盘飞行：W/A/S/D 姿态 · 空格/Shift 油门 · Q/E 偏航 · 方向键云台</span>
    </footer>
  </div>
</template>

<style scoped>
.home {
  position: fixed;
  inset: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  color: #dbe9f5;
  background:
    radial-gradient(1100px 620px at 78% -8%, rgba(46, 132, 190, 0.28), transparent 62%),
    radial-gradient(760px 520px at 8% 108%, rgba(28, 108, 96, 0.22), transparent 60%),
    linear-gradient(180deg, #0a1520 0%, #070e16 100%);
}
.grid-bg {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image:
    linear-gradient(rgba(120, 190, 230, 0.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(120, 190, 230, 0.05) 1px, transparent 1px);
  background-size: 46px 46px;
  mask-image: radial-gradient(ellipse at 50% 32%, #000 30%, transparent 78%);
}
.bar {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 30px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 12px;
}
.logo {
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border-radius: 11px;
  color: #7fe0ff;
  background: linear-gradient(160deg, rgba(38, 96, 132, 0.9), rgba(14, 34, 50, 0.9));
  border: 1px solid rgba(120, 200, 250, 0.32);
  box-shadow: 0 0 22px rgba(60, 170, 230, 0.25);
}
.titles strong {
  display: block;
  font-size: 16px;
  letter-spacing: 0.08em;
  color: #f1f8ff;
}
.titles small {
  font-size: 11px;
  color: #7e9cb4;
  letter-spacing: 0.04em;
}
.meta {
  display: flex;
  gap: 8px;
}
.chip {
  font-size: 11px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid rgba(120, 180, 220, 0.24);
  color: #9dbdd2;
  background: rgba(12, 28, 40, 0.6);
}
.main {
  position: relative;
  z-index: 1;
  flex: 1;
  width: 100%;
  max-width: 1180px;
  margin: 0 auto;
  padding: 40px 30px 50px;
  display: grid;
  grid-template-columns: minmax(320px, 460px) 1fr;
  gap: 46px;
  align-items: center;
  align-content: center;
}
.hero .eyebrow {
  margin: 0 0 14px;
  font-size: 11px;
  letter-spacing: 0.34em;
  color: #5f9dc4;
}
.hero h1 {
  margin: 0 0 18px;
  font-size: clamp(28px, 3.4vw, 42px);
  line-height: 1.24;
  letter-spacing: 0.01em;
  color: #f2f9ff;
  font-weight: 650;
}
.lead {
  margin: 0 0 26px;
  font-size: 13.5px;
  line-height: 1.85;
  color: #92b2c8;
}
.cta {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 13px 22px;
  font-family: inherit;
  font-size: 14px;
  font-weight: 600;
  color: #04131d;
  background: linear-gradient(180deg, #7fe0ff, #33a7de);
  border: 1px solid #8fe6ff;
  border-radius: 10px;
  cursor: pointer;
  box-shadow: 0 12px 30px rgba(30, 140, 200, 0.32);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.cta:hover {
  transform: translateY(-1px);
  box-shadow: 0 16px 36px rgba(30, 150, 210, 0.4);
}
.cards {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
.card {
  position: relative;
  text-align: left;
  padding: 18px 18px 16px;
  border-radius: 14px;
  background: linear-gradient(180deg, rgba(17, 36, 52, 0.9), rgba(10, 22, 33, 0.92));
  border: 1px solid rgba(110, 170, 210, 0.18);
  color: inherit;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.18s ease;
  min-height: 158px;
}
.card.active {
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.42);
}
.card.active:hover {
  transform: translateY(-2px);
  border-color: var(--accent);
}
.card.disabled {
  opacity: 0.5;
  cursor: default;
}
.tag {
  position: absolute;
  top: 16px;
  right: 16px;
  font-size: 10px;
  padding: 2px 7px;
  border-radius: 999px;
  color: #8fb0c8;
  border: 1px solid rgba(120, 180, 220, 0.26);
  background: rgba(14, 30, 44, 0.8);
}
.tag.live {
  color: #04131d;
  background: var(--accent);
  border-color: var(--accent);
  font-weight: 600;
}
.card h2 {
  margin: 0 0 8px;
  font-size: 16px;
  color: #eef7ff;
  letter-spacing: 0.04em;
}
.card p {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 1.7;
  color: #86a7bf;
}
.go {
  font-size: 12px;
  color: var(--accent);
  font-weight: 600;
}
.go.dim {
  color: #6f8ba1;
  font-weight: 400;
}
.foot {
  position: relative;
  z-index: 1;
  display: flex;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  max-width: 1180px;
  margin: 0 auto;
  padding: 0 30px 26px;
  font-size: 11px;
  color: #5f7b90;
}
@media (max-width: 940px) {
  .main {
    grid-template-columns: 1fr;
    gap: 30px;
  }
  .meta {
    display: none;
  }
}
</style>
