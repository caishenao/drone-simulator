<script setup lang="ts">
// 多人联机面板：进入全球空域（全世界一张地图，无房间概念）、在线名单、文字聊天。
// 规则：无人机名称全局唯一（重名拒绝）；关闭页面即自动退出。
// 状态全部来自 sim.mp（useDroneSim 维护），本组件只做表单与展示。
import { nextTick, ref, watch } from 'vue'
import type { DroneSim } from '../composables/useDroneSim'

const props = defineProps<{ sim: DroneSim }>()

const STORE_NAME = 'drone-mp-name'
const STORE_URL = 'drone-mp-url'

const serverUrl = ref(localStorage.getItem(STORE_URL) || props.sim.mp.url)
const nickname = ref(localStorage.getItem(STORE_NAME) || '')
const chatText = ref('')
const chatBox = ref<HTMLDivElement | null>(null)

watch(nickname, (v) => localStorage.setItem(STORE_NAME, v))
watch(serverUrl, (v) => localStorage.setItem(STORE_URL, v))

/** 聊天流自动滚底：有新消息就滚到底 */
watch(
  () => props.sim.mp.chat.length,
  async () => {
    await nextTick()
    const el = chatBox.value
    if (el) el.scrollTop = el.scrollHeight
  },
)

function join() {
  // 名称必填：它是玩家在空域里的唯一身份标识
  if (!nickname.value.trim() || props.sim.mp.joining) return
  void props.sim.mpJoin(nickname.value.trim(), serverUrl.value.trim())
}

function leave() {
  void props.sim.mpLeave()
}

function sendChat() {
  const t = chatText.value.trim()
  if (!t) return
  props.sim.mpSendChat(t)
  chatText.value = ''
}

function onChatKey(e: KeyboardEvent) {
  // 回车发送；其余键不让飞控的键盘监听接手（输入框 tagName 已被过滤，这里再兜一层）
  if (e.key === 'Enter') {
    e.preventDefault()
    sendChat()
  }
  e.stopPropagation()
}
</script>

<template>
  <section class="panel mp">
    <h2>全球空域</h2>

    <!-- 未进入：表单 -->
    <template v-if="sim.mp.status === 'idle' || sim.mp.status === 'connecting'">
      <label class="frow">
        <span>服务器</span>
        <input v-model="serverUrl" type="text" spellcheck="false" placeholder="留空 = 本站同源" />
      </label>
      <label class="frow">
        <span>名称</span>
        <input
          v-model="nickname"
          type="text"
          maxlength="16"
          placeholder="给无人机起一个唯一名称"
          @keydown.enter="join"
        />
      </label>
      <button class="join" :disabled="sim.mp.joining || !nickname.trim()" @click="join">
        {{ sim.mp.joining ? '连接中…' : '进入全球空域' }}
      </button>
      <p v-if="sim.mp.error" class="hint err">{{ sim.mp.error }}</p>
      <p class="hint">
        全世界共用一张地图：没有房间，进入后自动移动到空域统一起飞点。
        无人机名称全局唯一，重复会被拒绝；关闭页面即自动退出。
        本机联调直接用默认地址；局域网联机请在服务器端设 <code>MP_HOST=0.0.0.0</code>。
      </p>
    </template>

    <!-- 进入中 / 已进入：空域视图 -->
    <template v-else>
      <div class="roomline">
        <span class="dot" :style="{ background: sim.mp.selfColor }" />
        <b>全球空域</b>
        <span class="count">{{ sim.mp.players.length }} 人在线</span>
        <button class="leave" :disabled="sim.mp.status === 'reconnecting'" @click="leave">退出</button>
      </div>
      <ul class="players">
        <li v-for="p in sim.mp.players" :key="p.id">
          <span class="dot" :style="{ background: p.color }" />
          <span class="pname">{{ p.name }}<i v-if="p.id === sim.mp.selfId">（我）</i></span>
          <span class="ptype" :class="{ dead: p.crashed }">{{ p.crashed ? '已撞毁' : '飞行中' }}</span>
        </li>
      </ul>
      <div ref="chatBox" class="chat">
        <p
          v-for="(m, i) in sim.mp.chat"
          :key="`${m.ts}-${i}`"
          :class="{ sys: m.id === 'sys' }"
        >
          <b v-if="m.id !== 'sys'" :style="{ color: m.color }">{{ m.name }}</b>
          <span>{{ m.text }}</span>
        </p>
      </div>
      <div class="chatin">
        <input
          v-model="chatText"
          type="text"
          maxlength="200"
          placeholder="发送消息…（Enter）"
          @keydown="onChatKey"
        />
        <button :disabled="!chatText.trim()" @click="sendChat">发送</button>
      </div>
      <p v-if="sim.mp.error" class="hint err">{{ sim.mp.error }}</p>
      <p v-else-if="sim.mp.note" class="hint">{{ sim.mp.note }}</p>
    </template>
  </section>
</template>

<style scoped>
.mp .frow {
  display: grid;
  grid-template-columns: 42px 1fr;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #9ab3c7;
}
.frow input,
.chatin input {
  padding: 6px 9px;
  font-size: 12px;
  font-family: inherit;
  color: #e7f2fa;
  background: rgba(14, 32, 48, 0.85);
  border: 1px solid rgba(110, 170, 215, 0.28);
  border-radius: 6px;
  outline: none;
  min-width: 0;
}
.frow input:focus,
.chatin input:focus {
  border-color: rgba(120, 205, 255, 0.6);
}
.frow input::placeholder,
.chatin input::placeholder {
  color: #51708a;
}
.join {
  width: 100%;
  padding: 8px 10px;
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  color: #04131d;
  background: linear-gradient(180deg, #7fe0ff, #35a9e0);
  border: 1px solid #8fe6ff;
  border-radius: 7px;
  cursor: pointer;
}
.join:disabled {
  filter: grayscale(0.5);
  opacity: 0.6;
  cursor: default;
}
.roomline {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: #dceaf5;
}
.roomline b {
  letter-spacing: 0.04em;
}
.count {
  color: #7fa5c0;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.leave {
  margin-left: auto;
  font-size: 11px;
  font-family: inherit;
  color: #ffb0a0;
  padding: 3px 9px;
  border-radius: 999px;
  border: 1px solid rgba(255, 130, 110, 0.4);
  background: rgba(70, 22, 18, 0.6);
  cursor: pointer;
}
.leave:disabled {
  opacity: 0.55;
  cursor: default;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
  box-shadow: 0 0 6px rgba(120, 200, 255, 0.45);
}
.players {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 4px;
}
.players li {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: #cfe2f1;
}
.players .pname i {
  font-style: normal;
  color: #7fa5c0;
  font-size: 11px;
}
.ptype {
  margin-left: auto;
  font-size: 10px;
  color: #7ff0b8;
}
.ptype.dead {
  color: #ff8a8a;
}
.chat {
  height: 108px;
  overflow-y: auto;
  padding: 6px 8px;
  border-radius: 7px;
  border: 1px solid rgba(110, 170, 210, 0.2);
  background: rgba(9, 20, 30, 0.72);
  font-size: 11px;
  line-height: 1.7;
  color: #cfe2f1;
  scrollbar-width: thin;
}
.chat::-webkit-scrollbar {
  width: 5px;
}
.chat::-webkit-scrollbar-thumb {
  background: rgba(110, 170, 210, 0.3);
  border-radius: 3px;
}
.chat p {
  margin: 0;
  overflow-wrap: anywhere;
}
.chat p.sys {
  color: #6f93ad;
}
.chat p.sys span::before {
  content: '· ';
}
.chat b {
  margin-right: 5px;
  font-weight: 600;
}
.chatin {
  display: flex;
  gap: 6px;
}
.chatin input {
  flex: 1;
}
.chatin button {
  font-size: 12px;
  font-family: inherit;
  color: #b9d3e6;
  padding: 0 12px;
  border-radius: 6px;
  border: 1px solid rgba(110, 170, 215, 0.28);
  background: rgba(28, 54, 76, 0.72);
  cursor: pointer;
}
.chatin button:disabled {
  opacity: 0.5;
  cursor: default;
}
.hint {
  margin: 0;
  font-size: 11px;
  color: #6f8ba1;
  line-height: 1.6;
}
.hint.err {
  color: #ff9d8a;
}
.hint code {
  padding: 0 3px;
  border-radius: 3px;
  background: rgba(120, 170, 210, 0.13);
  font-size: 10px;
}
</style>
