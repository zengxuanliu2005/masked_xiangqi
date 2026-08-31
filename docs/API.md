# 覆子 REST API v1

Base URL：`http://127.0.0.1:3001/api/v1`

服务只接受 loopback Host 和本机浏览器 Origin。请求体必须是 UTF-8 `application/json`，上限 16 KiB；所有对象 Schema 为 strict，未知字段返回 `400 INVALID_REQUEST`。错误统一为：

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

始终返回 `200` 的 Ollama 可用性描述。模型项可含：

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

## HTTP 与错误码

- `400 INVALID_JSON`：JSON 语法错误
- `400 INVALID_REQUEST`：Schema 或未知字段错误
- `403 HOST_FORBIDDEN` / `ORIGIN_FORBIDDEN`
- `404 GAME_NOT_FOUND` / `ENDPOINT_NOT_FOUND` / `MODEL_NOT_FOUND`
- `409 STALE_REVISION` / `GAME_FINISHED` / `AI_DECISION_IN_PROGRESS` / `NOT_AI_TURN`
- `413 PAYLOAD_TOO_LARGE`
- `415 UNSUPPORTED_MEDIA_TYPE`
- `422`：规则语义错误、`NOT_AI_GAME`、`MODEL_NOT_GENERATIVE`
- `502 OLLAMA_MODEL_ERROR` / `OLLAMA_BAD_RESPONSE`
- `503 OLLAMA_UNAVAILABLE` / `CAPACITY_EXCEEDED`

相同 revision 的并发写操作恰好一个可成功；其余必须重新读取局面和合法着法，不得重放旧决定。
