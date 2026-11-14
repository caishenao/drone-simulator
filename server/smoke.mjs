// 服务器冒烟测试：三个 headless socket.io 客户端走完整协议，
// 断言全球空域的进入/唯一名称/名单/状态转发/聊天/退出各环节。
// 用法：node server/smoke.mjs [url]
import { io } from 'socket.io-client'

const URL = process.argv[2] || 'http://127.0.0.1:5190'

let failures = 0
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) failures++
}

function connect() {
  return io(URL, { transports: ['websocket'], extraHeaders: { origin: 'http://127.0.0.1:5188' } })
}

function join(socket, name, droneTypeId = 'mini3pro') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('mp:join ack 超时')), 3000)
    socket.emit('mp:join', { name, droneTypeId }, (res) => {
      clearTimeout(t)
      resolve(res)
    })
  })
}

function once(socket, event, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`等待 ${event} 超时`)), timeoutMs)
    socket.once(event, (data) => {
      clearTimeout(t)
      resolve(data)
    })
  })
}

function snap(seq, crashed = 0) {
  return {
    p: [10 + seq * 0.1, 150, 0],
    g: [0, 0, 150],
    q: [0, 0, 0, 1],
    v: [0, 0, 0],
    gp: -12,
    gy: 0,
    r: 6000,
    c: crashed,
    t: seq / 20,
    d: 'mini3pro',
    th: 0.42,
  }
}

const a = connect()
const b = connect()

try {
  // 1. A 进入空域
  const joinA = await join(a, '试飞A')
  check('A 进入成功', joinA?.ok === true)
  check('返回空域原点（服务器统一规定）', joinA?.origin?.lon === 116.4602 && joinA?.origin?.placeName === '北京国贸')
  check('名单含自己且带颜色', joinA?.players?.length === 1 && joinA?.players?.[0]?.color?.startsWith('#'))

  // 2. B 进入 → A 收到 player-joined
  const aSeesB = once(a, 'mp:player-joined')
  const joinB = await join(b, '试飞B')
  check('B 进入成功且名单 2 人', joinB?.ok === true && joinB?.players?.length === 2)
  const seenB = (await aSeesB).player
  check('A 收到 B 的 player-joined', seenB?.name === '试飞B')

  // 3. 名称唯一：重名（大小写变体）被拒
  const dup = connect()
  const dupErr = await new Promise((resolve) => {
    join(dup, '试飞a').catch(() => {})
    dup.on('mp:error', (e) => {
      dup.close()
      resolve(e)
    })
  })
  check('重名（大小写不敏感）被拒', dupErr?.code === 'name-taken')

  // 4. A 发快照 → B 收到且 id 是 A 的 socket.id
  const bSnap = once(b, 'mp:snap')
  a.emit('mp:state', snap(1))
  const relayed = await bSnap
  check('B 收到 A 的快照', relayed?.id === joinA.self.id && relayed?.s?.p?.[1] === 150)

  // 5. 聊天
  const aChat = once(a, 'mp:chat')
  b.emit('mp:chat', { text: '  你好，空域已清  ' })
  const chat = await aChat
  check('A 收到 B 的聊天（服务端改名与裁剪）', chat?.name === '试飞B' && chat?.text === '你好，空域已清')

  // 6. B 离开 → A 收到 player-left
  const aLeft = once(a, 'mp:player-left')
  b.emit('mp:state', snap(2, 1))
  await new Promise((r) => setTimeout(r, 100))
  b.emit('mp:leave')
  const left = await aLeft
  check('A 收到 B 退出', left?.id === joinB.self.id)

  // 7. 断开连接即移除（关闭浏览器等价场景）：C 进入后直接断开 socket
  const aSeesC = once(a, 'mp:player-joined')
  const aSeesCGone = once(a, 'mp:player-left', 4000)
  const c = connect()
  const joinC = await join(c, '试飞C')
  check('C 进入成功', joinC?.ok === true)
  await aSeesC
  c.disconnect()
  const cGone = await aSeesCGone
  check('C 断开连接即从名单移除', cGone?.id === joinC.self.id && cGone?.reason === 'disconnect')

  // 8. B 退出后名称释放：用「试飞B」重新进入应成功
  const b2 = connect()
  const reJoin = await join(b2, '试飞B')
  check('离开后同名可重新进入', reJoin?.ok === true && reJoin?.players?.length === 2)
  b2.emit('mp:leave')
} catch (err) {
  check(err.message, false)
} finally {
  a.close()
  b.close()
}

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
