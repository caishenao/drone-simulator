# 多人在线模拟飞行方案（WebSocket / Socket.IO · 全球单一空域）

> 状态：已实现。本文档是方案设计与协议契约，代码落在 `server/` 与 `web/src/net/`、`web/src/components/MultiplayerPanel.vue`。
> v2 变更：房间制改为**全球单一空域**——全世界一张地图、无房间概念、无人机名称全局唯一、关闭页面即退出。

## 1. 现状与结论

全库检索 `websocket / socket.io / multiplayer / 多人 / 联机` 无任何命中：当前项目是**纯单机**——

- 物理在客户端本地跑（`web/src/composables/useDroneSim.ts` 里 `DroneRigidBody.step()`，`requestAnimationFrame` 驱动）；
- 场景渲染只认一台机体（`CesiumScene.updateDrone()`，把本地 ENU 位姿写进 GLB 模型矩阵）；
- 没有任何网络层。

因此需要从零新建一套多人层。本文档给出方案，并按第 8 节的分期落地。

## 2. 目标与非目标

**目标（P0/P1）**

1. 全世界的人都在**同一张地图、同一套坐标系**中飞行（全球单一空域，无房间/建房间概念），互相能看到对方的机体（含旋翼转动、云台角度、倒飞姿态）。
2. 在线名单（无人机名称 / 颜色 / 机型 / 状态）、空域内文字聊天、进出提示。
3. **无人机名称全局唯一**：进入时必须设置，重名由服务器拒绝。
4. **连接即在场**：关闭浏览器页面 / 断网即从空域移除，无任何持久化。
5. 掉线自动重连、中途进入直接看到在场所有机体、撞毁状态同步。

**非目标（P2 及以后）**

- 服务器权威物理 / 反作弊校验（当前物理本身就是客户端信任模型）；
- 机体间碰撞；
- 分区 / AOI / 观战 / 回放（>16 人时再议）。

## 3. 技术选型：为什么是 Socket.IO

| 方案 | 结论 |
| --- | --- |
| 裸 WebSocket | 可行，但名单管理、断线重连、心跳探活、JSON 分帧都要手写 |
| **Socket.IO**（选定） | 基于 WebSocket（降级长轮询），自带 room、自动重连、心跳、广播 API；体积与复杂度对本项目可接受 |
| WebRTC DataChannel | 对本需求过重，还需要信令服务器 |

服务器：独立 Node 进程（`server/index.mjs`，ESM，零构建），`socket.io` 仅此一个运行时依赖；监听 `127.0.0.1:5190`（可用 `MP_PORT` 覆盖），CORS 只放行 Vite dev/preview 源。客户端依赖 `socket.io-client`，封装进 `web/src/net/MultiplayerClient.ts`，UI 不直接碰 socket。

服务器不做物理、不存盘：它是**无状态的空域中继**（memory-only），进程重启即清空——对模拟器场景足够。

## 4. 同步模型

**客户端权威 + 快照中继 + 远端插值**：

```
本机 tick()（60fps 物理环）
  └─ 每 50ms 采一次快照（20Hz）──► socket.emit('mp:state', snap) ──► 服务器
                                                                    │ 广播给空域内其他人
远端机体 ◄── socket.on('mp:snap', …) ◄──────────────────────────────┘
  └─ 120ms 插值缓冲：渲染时间取 now-120ms，在相邻两帧快照间线性插值
```

- **权威在哪**：每个玩家对自己的机体有权威（物理本来就是本地跑的），服务器不理解物理，只转发。这与现有单机架构复用度最高——不需要把 `DroneRigidBody` 搬上服务器。
- **发送频率**：20Hz（50ms）。低于渲染帧率，高于人眼对机体运动的感知需求；16 人空域带宽 ≈ 16×15×20×~110B ≈ 500KB/s，可接受。
- **插值缓冲**：远端机体永远渲染「120ms 前」的状态，两帧之间线性插值（位置、四元数 slerp、云台角度）。这是飞行模拟器标准做法：牺牲 120ms 换取平滑，本项目无对抗判定，代价为零。
- **外推**：缓冲耗尽（对端卡顿/丢包）时用最后速度做 ≤200ms 的线性外推，再往后冻结并标记「信号弱」。

## 5. 世界坐标：空域绑定统一起飞原点

这是多人层最容易出错的一块。每个客户端的场景原点不同（`CesiumScene.setOrigin` 各自搬原点），**直接互传本地 ENU 坐标是错的**。方案：

1. **空域原点由服务器统一规定**：默认北京国贸（与 web 端 `DEFAULT_PLACE` 一致），`MP_ORIGIN_LON / MP_ORIGIN_LAT / MP_ORIGIN_NAME` 可覆盖。客户端不提交起飞点，进入时服务器下发原点。
2. **进入者自动搬场景**：进入成功后走现有 `setTakeoff()` 流程把场景原点搬到空域原点（复用建筑加载、高程采样、刚体复位）。搬完后**所有玩家的本地 ENU 系完全一致**（x=东、y=上、z=南，相对同一点）。
3. **快照直接传本地 ENU + 绝对地理坐标**：`p: [x, y, z]`（空域 ENU 米）与 `g: [lon, lat, alt]`。前者用于渲染插值，后者用于调试面板与将来跨原点扩展。
4. **联机期间锁定起飞点切换**（面板禁用 + 函数兜底）：防止有人换原点后把全服的坐标系搞乱；想换点先退出空域。
5. 原点高程差异：进入者搬原点时由 `setOrigin` 自行采样，本地 ENU 的 y=0 各自贴地，无需同步。

## 6. 协议设计

JSON 事件。玩家 id 用服务器分配的 `socket.id`（短、稳定、重连后变化——重连等同重新进入）。

**客户端 → 服务器**

| 事件 | 载荷 | 说明 |
| --- | --- | --- |
| `mp:join` | `{ name, droneTypeId }` | 进入全球空域。**name 全局唯一**（大小写不敏感查重，重名拒绝 `name-taken`）；不需要提交起飞点与房间 |
| `mp:state` | 见下方快照 | 20Hz 一次，服务器原样广播给空域内其他人 |
| `mp:chat` | `{ text: string }` | ≤200 字，服务器限频 3 条/秒 |
| `mp:leave` | — | 主动退出（关闭页面时客户端先发一次；socket 断开也会触发移除） |

**服务器 → 客户端**

| 事件 | 载荷 | 说明 |
| --- | --- | --- |
| `mp:joined` | `{ self, origin, players }` | 进入确认：`origin` 为空域统一起飞点（客户端据此搬场景），`players` 为全量在线名单 |
| `mp:player-joined` | `{ player }` | 其他人收到 → 建远端机体 + 聊天条提示 |
| `mp:player-left` | `{ id, reason }` | `reason`: leave / disconnect / timeout。**disconnect 即关闭页面的等价场景** |
| `mp:snap` | `{ id, s: Snapshot }` | 状态转发（单条，服务器立即转，不做合帧——16 人规模不值得加抖动） |
| `mp:chat` | `{ id, name, color, text, ts }` | 广播聊天（含发送者自己，UI 无需本地回显） |
| `mp:error` | `{ code, message }` | `name-taken` / `world-full` / `already-joined` / `timeout` |

**快照 `Snapshot`**（字段全部缩写，压带宽；数值保留 2~3 位小数）

```ts
interface Snapshot {
  p: [number, number, number]   // 空域 ENU 位置（米，x 东 y 上 z 南）
  g: [number, number, number]   // 经纬度/海拔（度 / 度 / 米），调试与扩展用
  q: [number, number, number, number] // 姿态四元数（机体系 → ENU）
  v: [number, number, number]   // ENU 速度（外推用）
  gp: number                    // 云台俯仰（度）
  gy: number                    // 云台偏航（度）
  r: number                     // 平均旋翼转速 rpm（带符号：负 = 反桨倒飞）
  c: 0 | 1                      // 撞毁
  t: number                     // 发送方仿真时刻（秒，单调）
  d: string                     // 机型 id
  th: number                    // 油门
}
```

**Player**：`{ id, name, color, droneTypeId, joinedAt, crashed }`。颜色由服务器从 16 色调色板按加入顺序分配，避免客户端各自随机撞色。

**服务器规则**（全部在 `server/index.mjs`，无持久化）

- 空域上限 **16 人**；名称去空白后 ≤16 字符、**大小写不敏感全局唯一**，重名返回 `name-taken`。
- 心跳：Socket.IO 内置 ping/pong 探活；`disconnect`（含关闭浏览器页面）立即从名单移除并广播 `mp:player-left`；另对 `mp:state` 做 15s 静默判定 → 踢出（卡死 / 挂机的兜底）。
- `mp:state` 的 id 一律取服务端 `socket.id`，不信任客户端自报；载荷超 4KB 直接丢弃。
- 聊天限频：每连接 3 条/秒，超限静默丢弃。

## 7. 客户端与场景集成

新增文件（全部 TypeScript，走 `vue-tsc` 类型检查）：

```
web/src/net/MultiplayerClient.ts    # socket 封装：连接/进入/收发快照/聊天/重连，纯逻辑无 DOM
web/src/net/snapshot.ts             # Snapshot/Player 类型 + ENU↔经纬度换算 + 插值函数
web/src/net/RemoteDrones.ts         # 远端机体管理：Cesium Model 实例池、插值推进、标签、撞毁表现
web/src/components/MultiplayerPanel.vue  # 空域 UI：进入/退出、在线名单、聊天
```

**远端机体渲染**（`RemoteDrones.ts`，与本地机体同路径）：

- 每个在线玩家一个 `Cesium.Model.fromGltfAsync`（同一 `drone_mini3pro.glb`，Cesium 按 URL 缓存），模型矩阵用与 `updateDrone()` 相同的「本场景 ENU 轴 → ECEF」组装（`CesiumScene.composeDroneMatrix`）——**远端快照的 ENU 坐标天然就是本场景坐标**（第 5 节），不需要二次换算。
- 旋翼：与本地机体同款节点绑定（`Rotor_*` 节点 × rpm 符号方向）。
- 标签：`Cesium.Entity`（point + label，玩家颜色），3km 内可见。
- 撞毁：收到 `c:1` → 在其位置触发场景爆炸特效（复用 `CesiumScene.detonate`），隐藏模型，标签改为「已撞毁」；对方重飞（`c:0`）后恢复。
- 信号弱：3s 无快照 → 标签追加「· 信号弱」，机体冻结在最后位置。
- 倒飞/3D 油门：快照的四元数与带符号 rpm 直接表达，远端无需理解翻滚过程。

**`useDroneSim` 集成**（最小侵入）：

- `tick()` 里每 50ms 调 `client.publish(mpSnapshot(false))`（撞毁时补发一次 `c:1` 并停发位置，重飞后自动恢复）；
- 进入空域成功 → `setTakeoff(空域原点)`（带 `remember:false`），并给聊天流写系统提示；
- 联机时禁用 `setTakeoff / previewPlace / startPick` 的全部入口（面板已锁，函数内再兜底）；
- `pagehide` 时 `client.leave()`——关闭页面 / 刷新即退出（socket 随页面关闭断开是主通道，这是双保险）；
- `reset()/restart()` 不动网络层——撞毁重飞就是重新发快照，天然自愈。

**UI**（`MultiplayerPanel.vue`，嵌入 `FlightView` 侧栏顶部）：

- 未进入：服务器地址（默认 `VITE_MP_URL` 或 `http://127.0.0.1:5190`）、无人机名称（必填，唯一，localStorage 记住）→「进入全球空域」。
- 已进入：「全球空域 · N 人在线」+ 名单（颜色点 / 名称 / 状态）、聊天滚动区 + 输入框、退出。
- 连接状态徽标：未连接 / 连接中 / 已连接 / 重连中，显示在顶栏 chip。

## 8. 分期实施

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P0 | 空域服务器 + 进入/退出/名单 + 20Hz 快照中继 + 远端机体插值渲染 + UI | ✅ |
| P1 | 聊天、撞毁同步与爆炸表现、标签与颜色、掉线重连与超时清理 | ✅ |
| P1.5 | 全球单一空域化：移除房间概念、名称全局唯一、连接即在场（关闭页面即退出） | ✅ |
| P2 | 服务器合帧广播（30Hz tick）、AOI（>16 人）、观战位、机体间碰撞 | 未实施 |
| P3 | 服务器权威物理 / 延迟补偿（若将来要做竞速对抗） | 未实施 |

## 9. 验证

- `npm run typecheck`（web）；
- 冒烟脚本 `server/smoke.mjs`：三个 headless socket.io 客户端断言进入/重名拒绝/名单/转发/聊天/断连移除；
- 机器人 `server/bot.mjs [昵称] [秒数] [机型]`：绕空域原点盘旋的第二名玩家，单人即可验收渲染与聊天；
- 手工验收：开两个浏览器窗口进入空域（第二个用不同名称，重名会被拒绝），操作 A 的油门/滚转，B 应看到 A 的机体平滑跟随、旋翼转动；关闭 A 的页面，B 的名单应立即少一人。

## 10. 风险与备注

- **本机联调防火墙**：服务器默认绑 `127.0.0.1`，局域网联机需 `MP_HOST=0.0.0.0` 并放行端口；空域起飞点不在本地时用 `MP_ORIGIN_LON/LAT/NAME` 指定。
- **Cesium 多 Model 开销**：16 台机体 × 同一 GLB，共享 glTF 缓存（Cesium 按 url 缓存）；更多人数走 P2 的 AOI。
- **时钟**：快照带发送方仿真时刻 `t` 仅用于调试排序，插值只用接收方本地单调时钟，不做全网时钟同步。
- **安全**：当前模型完全信任客户端状态（与单机版一致）。接公网前需加校验（速度上限、瞬移检测），列为 P3。
- **单一地图的取舍**：所有人共用一个起飞点，进入会被搬到该点——这是「全世界一张地图」的固有代价；若要自由选点再互见，回到 P2 的跨原点方案（纯经纬度坐标交换）。
- **后台标签页限制（已知）**：快照发布用独立 20Hz 定时器（不挂 rAF），普通后台化时约 1Hz 心跳、不会掉线；但 Chrome 对隐藏超过约 5 分钟的标签页做强化节流（定时器钳到约 1 次/分钟），会被 15s 静默判定踢出空域——用户回到标签页时面板已回到进入表单，重新进入即可。前端不做 worker 保活（复杂度不成比例）。
- **快照消毒**：`sanitizeSnapshot` 把任意来源的快照载荷强制规范化成纯数字（第三方客户端发字符串 / NaN / 缺字段都不会污染渲染管线），并有 NaN 防护兜底。
