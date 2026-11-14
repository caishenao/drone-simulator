// 演示用机器人飞手：进入全球空域，绕空域原点匀速盘旋并定时发言。
// 单人验收多人渲染时用它当第二名玩家：
//   node server/bot.mjs [昵称] [存活秒数] [机型id]
// 名称与其他在线玩家重复时会被服务器拒绝。
import { io } from 'socket.io-client'

const URL = process.env.MP_URL || 'http://127.0.0.1:5190'
const name = process.argv[2] || '机器人乙'
const lifetimeSec = Number(process.argv[3]) || 60
const droneTypeId = process.argv[4] || 'cinewhoop'

const socket = io(URL, { transports: ['websocket'] })

/** 空域原点由进入应答下发，盘旋圆心与快照坐标都以它为准 */
let origin = { lon: 116.4602, lat: 39.9026, placeName: '北京国贸' }

socket.on('connect', () => {
  socket.emit('mp:join', { name, droneTypeId }, (res) => {
    if (!res?.ok) {
      console.error(`[bot] 进入失败（可能重名或空域已满）`)
      process.exit(1)
    }
    origin = res.origin
    console.log(`[bot] ${name} 已进入空域（${res.players.length} 人，起飞点 ${origin.placeName}）`)
  })
})

socket.on('mp:player-joined', ({ player }) => console.log(`[bot] ${player.name} 进场`))
socket.on('mp:player-left', ({ id }) => console.log(`[bot] ${id.slice(0, 6)} 离场`))
socket.on('mp:chat', ({ name: who, text }) => console.log(`[bot] ${who}: ${text}`))

socket.on('mp:error', (e) => {
  console.error(`[bot] 服务器错误: ${e.code} ${e.message}`)
  process.exit(1)
})

// 20Hz 快照：以空域原点为圆心、半径 40 m、高 160 m 的慢速盘旋（巡逻航线）
const t0 = Date.now()
const timer = setInterval(() => {
  const t = (Date.now() - t0) / 1000
  const ang = t * 0.35
  const x = Math.cos(ang) * 40
  const z = Math.sin(ang) * 40
  // 机头沿切线方向（绕 y 轴旋转的航向四元数）；ENU 系里 yaw=90°-ang
  const yaw = (Math.PI / 2 - ang) / 2
  const tangentV = 14 // 切向线速度 m/s（ω·r = 0.35 × 40）
  const snap = {
    p: [x.toFixed(2), '160.00', z.toFixed(2)],
    g: [origin.lon.toFixed(6), origin.lat.toFixed(6), '160.0'],
    q: [0, Math.sin(yaw).toFixed(4), 0, Math.cos(yaw).toFixed(4)],
    v: [(-Math.sin(ang) * tangentV).toFixed(2), '0.00', (Math.cos(ang) * tangentV).toFixed(2)],
    gp: -15,
    gy: 0,
    r: 5200,
    c: 0,
    t: t.toFixed(2),
    d: droneTypeId,
    th: 0.5,
  }
  socket.emit('mp:state', snap)
}, 50)

// 定时报告位置，也验证聊天通路
const chatTimer = setInterval(() => {
  const t = ((Date.now() - t0) / 1000).toFixed(0)
  socket.emit('mp:chat', { text: `盘旋 ${t}s，一切正常` })
}, 8000)

setTimeout(() => {
  clearInterval(timer)
  clearInterval(chatTimer)
  socket.emit('mp:leave')
  socket.disconnect()
  console.log('[bot] 飞完收工')
  process.exit(0)
}, lifetimeSec * 1000)
