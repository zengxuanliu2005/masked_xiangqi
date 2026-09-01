# 覆子 REST API v1

Base URL：`http://127.0.0.1:3001/api/v1`

服务默认只接受 loopback Host 和真实 loopback socket 对端。开启局域网模式后，LAN Host 必须是服务器当前真实网卡的私网 **IP 字面量**，socket 对端也必须是 loopback 或私网地址；域名、其他私网 Host 与公网对端均拒绝。LAN 浏览器 Origin 还必须与请求 Host 的 IP **及端口**一致，只有 loopback 开发环境允许 Vite 跨端口。`Forwarded`、`X-Forwarded-For`、`X-Real-IP` 不参与来源授权。`POST /games`、`POST /rooms`、`GET /ai/models`、`ai-move`、`agent-session*` 与 `POST /network` **始终仅限真实 loopback**；`human-human` / `human-ai` 的 `moves`、`resign`、`undo` 也只接受 loopback。请求体必须是 UTF-8 `application/json`，上限 16 KiB；所有对象 Schema 为 strict，未知字段返回 `400 INVALID_REQUEST`。错误统一为：

```json
{ "error": { "code": "STALE_REVISION", "message": "…", "details": {} } }
```

## 坐标与公开投影

左上角为 `(0,0)`，`x=0..8`，`y=0..9`。红方先行。

未翻棋子包含 `id`、`position`、`faceUp:false`、`publicIdentity` 和 `controller`，绝不包含 `identity`。已翻或被吃棋子才包含真实 `identity`。

`PublicGameState.seed` 的类型为 `string | null`：活动局始终是 `null`，终局后公开归一化后的真实 Seed。指定 Seed 的创建者当然已经知道输入值；API 不会再把它传播给浏览器状态、Runner Prompt 或日志。

## 公共端点

### `GET /health`

`200`：`{ "ok": true, "apiVersion": "v1" }`

### `GET /ai/models`

仅限 loopback；成功时返回 `200` 的 Ollama 可用性描述。模型项可含：

```json
{
  "name": "qwen3:8b",
  "family": "qwen",
  "parameterSize": "8B",
  "size": 123,
  "capabilities": ["completion", "thinking"],
  "supportsThinking": true,
  "supportsCompletion": true
}
```

能力查询失败时相关字段省略，表示未知；不会把未知伪装成 `false`。`supportsCompletion:false` 的 embedding-only 模型不可选。

### `POST /games`

仅限 loopback。

```json
{
  "mode": "standard",
  "allowDraw": true,
  "allowUndo": true,
  "matchType": "human-human",
  "player1Side": "red",
  "seed": "optional-seed"
}
```

人机局还必须提供 `"aiModel":"qwen3:8b"`。`player1Side` 和 `seed` 可省略。创建人机局时再次确认模型存在且不是 embedding-only。

- `201`：`PublicGameState`
- `404 MODEL_NOT_FOUND`
- `422 MODEL_NOT_GENERATIVE`
- `503 CAPACITY_EXCEEDED`（最多 512 局且没有满足 TTL 的可清理对象）

### `GET /games/:id`

- `200`：`PublicGameState`
- `404 GAME_NOT_FOUND`

### `GET /games/:id/legal-moves[?pieceId=…]`

```json
{
  "gameId": "uuid",
  "revision": 3,
  "turn": "black",
  "moves": [
    {
      "pieceId": "piece-1",
      "from": { "x": 0, "y": 6 },
      "to": { "x": 0, "y": 5 },
      "captures": false
    }
  ]
}
```

客户端必须只提交与当前公开局面相同 `revision` 和 `turn` 的列表项。

### `POST /games/:id/moves`

```json
{ "from": { "x": 0, "y": 6 }, "to": { "x": 0, "y": 5 }, "expectedRevision": 3 }
```

`200` 返回新 `PublicGameState`。规则错误包括 `STALE_REVISION`、`GAME_FINISHED`、`INVALID_POSITION`、`NO_PIECE`、`WRONG_SIDE` 和 `ILLEGAL_MOVE`。

### `POST /games/:id/undo`

### `POST /games/:id/resign`

请求均为 `{ "expectedRevision": 3 }`，成功返回新 `PublicGameState`。悔棋还可能返回 `UNDO_DISABLED` 或 `NO_UNDO_AVAILABLE`。

### `POST /games/:id/ai-move`

兼容入口，不供网页 Runner 主流程使用：`{ "expectedRevision": 3 }`。

每局只允许一个模型决策在飞；并发者返回 `409 AI_DECISION_IN_PROGRESS`。局面、停止状态或客户端连接变化会取消旧请求，旧决定不能提交。成功响应：

```json
{
  "game": {},
  "decision": { "model": "qwen3:8b", "source": "model", "note": "简短理由" }
}
```

其他错误：`NOT_AI_GAME`、`NOT_AI_TURN`、`NO_LEGAL_MOVES`、`OLLAMA_UNAVAILABLE`、`OLLAMA_MODEL_ERROR`、`OLLAMA_BAD_RESPONSE`。

## Agent 会话端点

浏览器可用：

- `POST /games/:id/agent-session`：创建或读取唯一会话
- `GET /games/:id/agent-session`：读取脱敏状态
- `POST /games/:id/agent-session/restart`：重启 paused/exited/stopped/finished 会话
- `DELETE /games/:id/agent-session`：停止

状态为 `starting`、`waiting-human`、`thinking`、`submitting`、`paused`、`finished`、`stopped` 或 `exited`。公开状态不含 token；`manualCommand` 在自动终端失败时会包含本机会话文件路径。

Runner 内部端点：

- `GET /games/:id/agent-session/runner`
- `PATCH /games/:id/agent-session/runner`

它们要求 `Authorization: Bearer <session-token>`。PATCH body 为 `{ "status": "thinking", "error": null }`。token 只来自权限为 0600 的会话文件，不得进入 URL、Prompt、日志或浏览器状态。

## 局域网房间与座位

局域网对局只能由 `POST /rooms` 创建——`POST /games` 的 `matchType` 不接受 `lan-human`，因此不会出现没有房间的局域网对局。

`PublicGameState` 在局域网对局上多出可选的 `lan` 字段：

```json
{
  "roomCode": "ABC234",
  "host": "red",
  "seats": {
    "red": { "claimed": true, "online": true },
    "black": { "claimed": true, "online": false }
  },
  "undoRequest": {
    "id": "4b6c1acfee2e177a0d52343ee3a2be25",
    "requestedBy": "red",
    "atRevision": 7,
    "expiresAt": "…"
  },
  "viewer": { "status": "valid", "color": "red" }
}
```

`roomCode` 只投影给房主座位，终局后不再下发。`online` 由座位心跳推导，原始时间戳不下发。带 bearer token 的读取还会得到仅描述该凭证的 `viewer`：有效时为 `{ status:"valid", color }`，旧凭证为 `{ status:"revoked" }`，其他错误凭证为 `{ status:"invalid" }`；匿名读取省略它。两个座位收到完全相同的棋盘公开信息，只有房间码与凭证状态等 LAN 元数据按请求授权投影。

### `POST /rooms`

仅限 loopback。体为 `{ mode?, allowDraw?, allowUndo?, hostSide?, seed? }`（strict）。`201` 返回 `{ game, roomCode, seat: { color, token } }`。**座位令牌只在这里出现一次**，之后不会再随任何响应下发。

### `POST /rooms/:code/join`

体为空对象。`200` 返回 `{ game, seat: { color, token } }`，颜色恒为房主的对面。

### `POST /games/:id/invite`

需房主座位令牌，体为 `{ expectedRevision, expectedRoomCode }`。服务同时匹配当前局面版本与当前房间码，才会作废客人座位并签发新码；延迟或重复请求返回 `409 STALE_REVISION` / `LAN_INVITE_STALE`，不能撤销后来入座的替补。`200` 返回 `{ game, roomCode }`。

### `POST /games/:id/undo-request` 与 `.../resolve`

局域网对局的 `POST /games/:id/undo` 恒为 `403 LAN_UNDO_REQUIRES_CONSENT`，必须走协商：

- `POST /games/:id/undo-request`，体 `{ expectedRevision }`。只有**刚走完那一步**的一方可以发起（即 `turn` 的对方），且双方座位都必须已认领；等待替补入座时返回 `409 LAN_WAITING_FOR_OPPONENT`。
- `POST /games/:id/undo-request/resolve`，体 `{ expectedRevision, requestId, accept }`。`requestId` 必须等于投影中当前请求的 128-bit 随机 `id`。批准与执行是同一个同步步骤，不存在「已批准但未执行」的中间态。请求方自己 `accept: true` 会被拒绝。

请求在 `revision` 前进、超时（默认 60 秒）或终局时自动失效，**永远不会阻塞对局**：任一方都可以在请求挂起期间落子或认输。ID 与 revision 同时匹配，保证旧请求的延迟回应不能处理同一 revision 上的后续请求。

### 座位鉴权

`moves`、`resign` 与上述房间端点在 `matchType === "lan-human"` 时要求 `Authorization: Bearer <seat-token>`；其他对局类型无需座位令牌，但写入只允许真实 loopback。**读取对局始终开放**——被移出的设备通过读取响应的 `lan.viewer.status` 稳定发现自己已被移出，即使同一颜色已有替补入座；客户端不得再把 `revoked` / `invalid` 凭据的旧颜色作为「你」的视角。

## 网络模式

- `GET /network`：返回 `{ mode, targetMode, port, addresses, error, pending, listening, local }`。`mode` 始终是当前真实 listener 的模式；切换中由 `pending:true` 与 `targetMode` 表示目标。非本机来源会隐藏 `port`、`addresses` 与 `error`，但仍得到真实的模式/过渡状态及 `local:false`。
- `POST /network`：体 `{ "mode": "loopback" | "lan" }`，**仅限真实 loopback**。响应保留当前 `mode`，返回 `local:true`，并以 `pending:true`、`targetMode` 表示已接受。服务在响应完成后把关闭、绑定和失败回滚放入单一 FIFO；客户端应重试 `GET /network`，直到 `pending:false` 且 `listening:true`，或读取到明确错误。内置界面前台每 150 ms 确认、5 秒后每秒后台对账，并每 5 秒/窗口聚焦时刷新模式与网卡地址。进程关机后控制器永久关闭，任何晚到的切换回调都不会重新监听。

## HTTP 与错误码

- `400 INVALID_JSON`：JSON 语法错误
- `400 INVALID_REQUEST`：Schema 或未知字段错误
- `403 HOST_FORBIDDEN` / `ORIGIN_FORBIDDEN` / `LOOPBACK_ONLY`
- `404 GAME_NOT_FOUND` / `ENDPOINT_NOT_FOUND` / `MODEL_NOT_FOUND`
- `409 STALE_REVISION` / `GAME_FINISHED` / `AI_DECISION_IN_PROGRESS` / `NOT_AI_TURN`
- `413 PAYLOAD_TOO_LARGE`
- `415 UNSUPPORTED_MEDIA_TYPE`
- `422`：规则语义错误、`NOT_AI_GAME`、`MODEL_NOT_GENERATIVE`
- `502 OLLAMA_MODEL_ERROR` / `OLLAMA_BAD_RESPONSE`
- `503 OLLAMA_UNAVAILABLE` / `CAPACITY_EXCEEDED`

局域网相关错误码：

- `401 LAN_SEAT_TOKEN_INVALID`：缺少或不匹配的座位令牌
- `401 LAN_SEAT_REVOKED`：你的座位已被房主重新邀请作废
- `403 LAN_NOT_YOUR_SEAT`：不是你的回合、非房主重新邀请、或请求撤回不属于你的着法
- `403 LAN_CANNOT_SELF_APPROVE` / `403 LAN_UNDO_REQUIRES_CONSENT`
- `404 LAN_ROOM_NOT_FOUND` / `410 LAN_CODE_REVOKED` / `409 LAN_ROOM_FULL`
- `409 LAN_WAITING_FOR_OPPONENT` / `409 LAN_UNDO_REQUEST_EXISTS` / `409 LAN_UNDO_REQUEST_NOT_FOUND` / `409 LAN_INVITE_STALE`
- `422 NOT_LAN_GAME`、`429 LAN_JOIN_THROTTLED`、`503 CAPACITY_EXCEEDED`
- `403 LOOPBACK_ONLY`：创建游戏/房间、AI、Agent、网络开关或非 LAN 对局写入被非 loopback 对端调用

相同 revision 的并发写操作恰好一个可成功；其余返回 `409 STALE_REVISION`，必须重新读取局面和合法着法，不得重放旧决定。LAN 写入会先验证座位令牌，再在房间就绪和回合授权之前检查 revision，避免重复请求因首个请求已翻转回合而误报 `LAN_NOT_YOUR_SEAT`。
