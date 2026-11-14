// 多人联机客户端：socket.io 封装。纯逻辑无 DOM / 无 Vue —— 状态回调交给 useDroneSim 写进 reactive。
// 协议契约见 docs/multiplayer-plan.md 第 6 节。
import { io, type Socket } from 'socket.io-client'
import type { MpChatMsg, MpPlayer, Snapshot } from './snapshot'

export type MpStatus = 'idle' | 'connecting' | 'joined' | 'reconnecting'

/** 默认服务器地址：.env.local 里 VITE_MP_URL 可覆盖。
 *  dev 缺省 http://127.0.0.1:5190（与 vite dev server 并存）；
 *  生产构建缺省空串 = 同源直连（Docker 单端口部署：静态页与 Socket.IO 同端口）。 */
export const DEFAULT_MP_URL =
  (import.meta.env?.VITE_MP_URL as string | undefined) ||
  (import.meta.env?.DEV ? 'http://127.0.0.1:5190' : '')

export interface MpOrigin {
  lon: number
  lat: number
  placeName: string
}

export interface JoinPayload {
  /** 无人机唯一名称（服务器全局查重，重名拒绝） */
  name: string
  droneTypeId: string
}

export interface JoinResult {
  self: MpPlayer
  origin: MpOrigin
  players: MpPlayer[]
}

export interface ClientHandlers {
  /** 进入确认（断线重连成功后也会再收到一次，带最新名单与空域原点） */
  onJoined: (self: MpPlayer, origin: MpOrigin, players: MpPlayer[]) => void
  onPlayerJoined: (player: MpPlayer) => void
  onPlayerLeft: (id: string, reason: string) => void
  onSnap: (id: string, snap: Snapshot) => void
  onChat: (msg: MpChatMsg) => void
  /** 服务器下发的错误（重名 / 空域满 / 状态超时等） */
  onError: (code: string, message: string) => void
  /** 连接层状态变化（发起连接 / 掉线） */
  onTransport: (state: 'connecting' | 'disconnected') => void
}

export class MultiplayerClient {
  private socket: Socket | null = null
  private handlers: ClientHandlers
  /** 最近一次 join 载荷：断线重连成功后自动重新加入用 */
  private lastJoin: JoinPayload | null = null
  /** 重连后重新加入是否有未完成的尝试 */
  private rejoining = false

  status: MpStatus = 'idle'

  constructor(handlers: ClientHandlers) {
    this.handlers = handlers
  }

  get connected(): boolean {
    return !!this.socket?.connected
  }

  /** 建立连接（幂等）：只连不加，加入由 join() 负责。url 为空串 = 同源直连 */
  connect(url: string): void {
    if (this.socket) return
    this.status = 'connecting'
    this.handlers.onTransport('connecting')
    this.socket = io(url || undefined, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 800,
      reconnectionDelayMax: 5000,
      timeout: 8000,
    })
    const s = this.socket
    /** 是否至少连接过一次：connect 事件区分「首次连接」与「断线重连」 */
    let everConnected = false
    s.on('connect', () => {
      // 断线重连 = 新 socket.id = 服务器侧全新玩家：自动补一次加入。
      // 首次连接不能走这里（此时 join() 的显式加入已经在路上），否则会发出重复 join
      if (this.lastJoin && everConnected && !this.rejoining) {
        this.rejoining = true
        this.doJoin(this.lastJoin)
      }
      everConnected = true
    })
    s.on('disconnect', (reason) => {
      if (this.status === 'joined') {
        this.status = 'reconnecting'
        // socket.io 会自动重连；房间 membership 已丢，重连成功后走 lastJoin 补加
        this.handlers.onTransport('disconnected')
      }
      if (reason === 'io server disconnect') {
        // 服务器主动踢（超时等）：socket.io 不会自动重连，这里手动发起
        s.connect()
      }
    })
    s.on('mp:joined', (data: { self: MpPlayer; origin: MpOrigin; players: MpPlayer[] }) => {
      this.rejoining = false
      this.status = 'joined'
      this.handlers.onJoined(data.self, data.origin, data.players)
    })
    s.on('mp:player-joined', (data: { player: MpPlayer }) => this.handlers.onPlayerJoined(data.player))
    s.on('mp:player-left', (data: { id: string; reason: string }) =>
      this.handlers.onPlayerLeft(data.id, data.reason),
    )
    s.on('mp:snap', (data: { id: string; s: Snapshot }) => this.handlers.onSnap(data.id, data.s))
    s.on('mp:chat', (msg: MpChatMsg) => this.handlers.onChat(msg))
    s.on('mp:error', (data: { code: string; message: string }) => {
      this.handlers.onError(data.code, data.message)
      // 状态超时等不可恢复错误：回空闲态（UI 引导重新加入）
      if (data.code === 'timeout' && this.status !== 'idle') this.status = 'idle'
    })
  }

  /**
   * 进入空域。resolve 携带 ack 里的完整结果（self/origin/players）——
   * 不要依赖 'mp:joined' 事件先于 ack 处理：两包可能分批到达。
   * resolve(null) = 服务器拒绝（错误已通过 onError 通知）。
   */
  join(payload: JoinPayload): Promise<JoinResult | null> {
    this.lastJoin = payload
    if (!this.socket) this.connect(DEFAULT_MP_URL)
    this.status = this.status === 'joined' ? 'joined' : 'connecting'
    return this.doJoin(payload)
  }

  private doJoin(payload: JoinPayload): Promise<JoinResult | null> {
    const s = this.socket
    if (!s) return Promise.resolve(null)
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => resolve(null), 8000)
      s.emit('mp:join', payload, (res: { ok: boolean; self: MpPlayer; origin: MpOrigin; players: MpPlayer[] } | undefined) => {
        window.clearTimeout(timer)
        resolve(res?.ok ? { self: res.self, origin: res.origin, players: res.players } : null)
      })
    })
  }

  /** 20Hz 快照发布 */
  publish(snap: Snapshot): void {
    this.socket?.emit('mp:state', snap)
  }

  chat(text: string): void {
    this.socket?.emit('mp:chat', { text })
  }

  /** 主动退出房间（连接保留，下次 join 直接复用） */
  leave(): void {
    this.lastJoin = null
    this.rejoining = false
    this.socket?.emit('mp:leave')
    this.status = 'idle'
  }

  /** 彻底断开并释放（回首页 / 组件销毁时） */
  dispose(): void {
    this.socket?.removeAllListeners()
    this.socket?.disconnect()
    this.socket = null
    this.lastJoin = null
    this.status = 'idle'
  }
}
