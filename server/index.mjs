// 多人无人机模拟飞行服务器：全球单一空域 + Socket.IO 状态中继。
//
// 定位见 docs/multiplayer-plan.md：
//   · 全世界共用一张地图：没有房间概念，所有接入的玩家都在同一个空域、同一套坐标系里；
//   · 物理在客户端本地跑（客户端权威），服务器不理解飞行状态，只做在线名单与转发；
//   · 空域起飞原点由服务器统一规定（MP_ORIGIN_* 可配），玩家进入时自行把场景搬过去；
//   · 玩家名称全局唯一（大小写不敏感），重名直接拒绝；
//   · 连接即在场：断开连接（含关闭浏览器页面）立即从空域移除，无持久化。
//
// 启动：node server/index.mjs（MP_HOST / MP_PORT / MP_ORIGINS / MP_ORIGIN_LON / MP_ORIGIN_LAT / MP_ORIGIN_NAME 可覆盖）。
import { Server } from 'socket.io'
import http from 'node:http'

// 环境变量：默认只绑本机、只放行本地 dev/preview 源；局域网联机设 MP_HOST=0.0.0.0。
const HOST = process.env.MP_HOST || '127.0.0.1'
const PORT = Number(process.env.MP_PORT) || 5190
const ORIGINS = (process.env.MP_ORIGINS || 'http://127.0.0.1:5188,http://localhost:5188,http://127.0.0.1:5199')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

// 空域上限：Cesium 多 Model 渲染与带宽都在这个量级内可控（见方案第 10 节）。
const MAX_PLAYERS = 16
// mp:state 静默超时：Socket.IO 心跳本身能探活断线，这里再兜一层「连接还在但客户端卡死」。
const STATE_TIMEOUT_MS = 15_000
// 清理间隔与聊天限频。
const SWEEP_INTERVAL_MS = 5_000
const CHAT_RATE_PER_SEC = 3

/**
 * 空域起飞原点：全服唯一，所有人进入后自动搬到这一点上，共享同一套本地 ENU 坐标。
 * 默认北京国贸（与 web 端 DEFAULT_PLACE 一致）；MP_ORIGIN_LON / MP_ORIGIN_LAT / MP_ORIGIN_NAME 可覆盖。
 */
const WORLD_ORIGIN = {
  lon: Number(process.env.MP_ORIGIN_LON) || 116.4602,
  lat: Number(process.env.MP_ORIGIN_LAT) || 39.9026,
  placeName: process.env.MP_ORIGIN_NAME || '北京国贸',
}

/** 16 色调色板：按加入顺序分配，撞色由服务器统一管，不留给客户端随机。 */
const PALETTE = [
  '#5ad1ff',
  '#ffd166',
  '#7ff0b8',
  '#ff9f77',
  '#c39bff',
  '#ff7fb2',
  '#a4ec6a',
  '#6ea8ff',
  '#ffc2f0',
  '#ffe08a',
  '#9fe8ff',
  '#ffb59f',
  '#c9ff8a',
  '#8affd4',
  '#d6b3ff',
  '#ff9fc9',
]

/**
 * @typedef {Object} Player
 * @property {string} id socket.id
 * @property {string} name 无人机唯一名称（去空白后 ≤16 字符，重名拒绝）
 * @property {string} color 调色板颜色
 * @property {string} droneTypeId 机型 id
 * @property {number} joinedAt 加入时刻（毫秒）
 * @property {boolean} crashed 最近快照的撞毁标记
 * @property {number} lastState 最近一次 mp:state 的时刻（毫秒），超时清理用
 */
/** @type {Map<string, Player>} socket.id → player */
const players = new Map()

const httpServer = http.createServer((_req, res) => {
  // 健康检查：dev 环境里用来确认服务器起来了
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, players: players.size, origin: WORLD_ORIGIN }))
})
const io = new Server(httpServer, {
  cors: { origin: ORIGINS },
  // 模拟器场景 tolerate 弱网：放宽心跳探测
  pingInterval: 10_000,
  pingTimeout: 20_000,
})

function sanitizeName(raw) {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 16)
  return name || `飞手-${Math.floor(1000 + Math.random() * 9000)}`
}

function publicPlayer(p) {
  return { id: p.id, name: p.name, color: p.color, droneTypeId: p.droneTypeId, crashed: p.crashed, joinedAt: p.joinedAt }
}

function roster() {
  return [...players.values()].map(publicPlayer)
}

function removePlayer(id, reason) {
  const player = players.get(id)
  if (!player) return
  players.delete(id)
  io.to('world').emit('mp:player-left', { id, reason })
  console.log(`[mp] ${player.name}(${id}) 离开空域（${reason}），剩余 ${players.size} 人`)
}

io.on('connection', (socket) => {
  /** 是否已在空域中 */
  let joined = false
  /** 聊天令牌桶：简单限频 */
  let chatTokens = CHAT_RATE_PER_SEC
  let chatRefillAt = Date.now() + 1000

  socket.on('mp:join', (payload, ack) => {
    if (joined) {
      io.to(socket.id).emit('mp:error', { code: 'already-joined', message: '已经在空域中' })
      if (typeof ack === 'function') ack({ ok: false })
      return
    }
    const name = sanitizeName(payload?.name)
    // 名称全局唯一（大小写不敏感）：这是进入空域的唯一门槛
    const key = name.toLowerCase()
    if (roster().some((p) => p.name.toLowerCase() === key)) {
      io.to(socket.id).emit('mp:error', {
        code: 'name-taken',
        message: `「${name}」已被占用，请给无人机换一个名称`,
      })
      if (typeof ack === 'function') ack({ ok: false })
      return
    }
    if (players.size >= MAX_PLAYERS) {
      io.to(socket.id).emit('mp:error', { code: 'world-full', message: `空域已满（${MAX_PLAYERS} 人）` })
      if (typeof ack === 'function') ack({ ok: false })
      return
    }

    const player = {
      id: socket.id,
      name,
      color: PALETTE[players.size % PALETTE.length],
      droneTypeId: String(payload?.droneTypeId ?? 'mini3pro').slice(0, 32),
      joinedAt: Date.now(),
      crashed: false,
      lastState: Date.now(),
    }
    players.set(socket.id, player)
    socket.join('world')
    joined = true

    // 加入确认：self + 空域原点 + 全量名单；客户端据此搬场景、建远端机体。
    // 先发事件再回 ack：两包可能分批到达，客户端逻辑不能依赖「ack 后事件已处理」
    socket.emit('mp:joined', { self: publicPlayer(player), origin: WORLD_ORIGIN, players: roster() })
    if (typeof ack === 'function') ack({ ok: true, self: publicPlayer(player), origin: WORLD_ORIGIN, players: roster() })
    socket.to('world').emit('mp:player-joined', { player: publicPlayer(player) })
    console.log(`[mp] ${player.name}(${socket.id}) 进入空域，当前 ${players.size} 人`)
  })

  socket.on('mp:state', (snap) => {
    const player = players.get(socket.id)
    if (!player) return
    // 载荷超 4KB 直接丢弃：快照是定长小对象，超限只可能是构造出来的
    if (JSON.stringify(snap ?? {}).length > 4096) return
    player.lastState = Date.now()
    player.crashed = snap?.c === 1
    // id 一律取服务端 socket.id，不信任客户端自报
    socket.to('world').emit('mp:snap', { id: socket.id, s: snap })
  })

  socket.on('mp:chat', (payload) => {
    const player = players.get(socket.id)
    if (!player) return
    const now = Date.now()
    if (now > chatRefillAt) {
      chatTokens = CHAT_RATE_PER_SEC
      chatRefillAt = now + 1000
    }
    if (chatTokens <= 0) return
    chatTokens--
    const text = String(payload?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
    if (!text) return
    io.to('world').emit('mp:chat', { id: player.id, name: player.name, color: player.color, text, ts: now })
  })

  socket.on('mp:leave', () => {
    if (joined) {
      joined = false
      socket.leave('world')
      removePlayer(socket.id, 'leave')
    }
  })

  // 关闭浏览器页面 / 断网：socket 断开即从空域移除 —— 连接即在场
  socket.on('disconnect', () => {
    joined = false
    removePlayer(socket.id, 'disconnect')
  })
})

// 兜底扫描：连接还在但 15s 没有任何快照的玩家按超时踢出（卡死 / 挂机的客户端）
setInterval(() => {
  const now = Date.now()
  for (const player of players.values()) {
    if (now - player.lastState > STATE_TIMEOUT_MS) {
      io.to(player.id).emit('mp:error', { code: 'timeout', message: '超过 15 秒没有同步飞行状态，已退出空域' })
      io.in(player.id).socketsLeave('world')
      removePlayer(player.id, 'timeout')
    }
  }
}, SWEEP_INTERVAL_MS)

httpServer.listen(PORT, HOST, () => {
  console.log(
    `[mp] 全球空域服务器已启动: http://${HOST}:${PORT}（起飞点 ${WORLD_ORIGIN.placeName} ` +
      `${WORLD_ORIGIN.lat}, ${WORLD_ORIGIN.lon}；CORS 放行 ${ORIGINS.join(', ')}）`,
  )
})
