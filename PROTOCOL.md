# 云端同步 Wire 协议（v0.3.0）

`dsh-cloud-sync` 插件（客户端）与 `dsh-cloud-sync-server`（服务端）之间通过**单一 WebSocket 连接**（路径 `/ws`）通信。所有消息都是 UTF-8 的 JSON 对象，`type` 字段区分类型。客户端主动外连（适配 NAT）；服务端被动接收。

## 客户端 → 服务端

### `hello`（连接后必发）

```json
{
  "type": "hello",
  "deviceId": "desktop@my-pc",
  "instanceId": "9f1c2...",
  "token": "my-token",
  "clientVersion": "0.3.0",
  "hostname": "my-pc",
  "profile": "desktop",
  "time": 1730000000000
}
```

### `session.upsert`（完整快照，幂等覆盖）

连接后、重连后、以及每次 `session/created` 时发送；`events` 为该 session 的完整事件日志。

```json
{
  "type": "session.upsert",
  "session": {
    "header": { "id": "abc123", "version": 1, "createdAt": 1730000000000 },
    "seq": 42,
    "events": [
      { "type": "user/message", "seq": 0, "time": 1730000000000, "data": {} }
    ]
  }
}
```

### `session.append`（增量事件）

每次 `session/event` 时发送；服务端按 `seq` 去重合并。

```json
{
  "type": "session.append",
  "sessionId": "abc123",
  "event": { "type": "assistant/message", "seq": 41, "time": 1730000000001, "data": {} }
}
```

### `session.close`（标记会话结束，保留云端记录）

```json
{ "type": "session.close", "sessionId": "abc123", "finalSeq": 42 }
```

### `session.delete`（从云端删除会话）

```json
{ "type": "session.delete", "sessionId": "abc123" }
```

### `sync.list`（请求「跨设备续接候选」列表）

```json
{ "type": "sync.list" }
```

### `sync.pull`（拉取另一个设备的某会话完整日志）

```json
{ "type": "sync.pull", "deviceId": "desktop@other-pc", "sessionId": "abc123" }
```

### `ping`（心跳保活）

```json
{ "type": "ping", "time": 1730000000000 }
```

## 服务端 → 客户端

- `welcome`：`{ "type": "welcome", "ok": true, "serverVersion": "0.3.0", "deviceId": "..." }`（`ok:false` 且 `error:"unauthorized"` 时会立即关闭连接）
- `ack`：`{ "type": "ack", "ok": true|false, "error"?: "...", "sessionId"?: "..." }`
- `pong`：`{ "type": "pong", "time": ... }`
- `sync.list`（响应）：`{ "type": "sync.list", "sessions": [{ "deviceId", "sessionId", "seq", "closed", "updatedAt" }] }` —— 只含**同租户、非本设备**的会话摘要
- `sync.session`（`sync.pull` 的响应）：`{ "type": "sync.session", "deviceId", "sessionId", "session": { "header", "seq", "events" } | null }` —— `null` 表示会话不存在或跨租户

## 序列化约定

DSH 事件 `data` 里的 `Buffer`/`ArrayBuffer` → `{ "__bytes": "<base64>" }`，`BigInt` → `{ "__bigint": "<str>" }`，`Error` → `{ "__error": { "name", "message", "stack" } }`；函数与 `symbol` 丢弃。服务端按原样存储（JSON）；客户端在续接重建前用逆向 `revive()` 还原。

## 鉴权与租户隔离

- 服务端设 `AUTH_TOKEN` 或 `AUTH_TOKENS`（逗号分隔多个）时启用鉴权：`hello.token` 必须是其中之一，否则 `welcome.ok:false` 并关闭连接。
- 每个 token 对应一个**租户** `tenantOf(token) = sha256(token)`。设备按 token 归属租户；`sync.list` / `sync.pull` 只返回**同租户**设备的数据（跨租户 `sync.pull` 返回 `null`）。
- REST 用 `Authorization: Bearer <token>`（或 `?token=`）鉴权；`/health` 免鉴权；设备/会话/事件查询只返回同租户数据。
- 未设 token（鉴权关闭）时所有设备同属默认租户，可互相拉取。

## 重连语义

客户端断线后按 `reconnectMinMs * 2^n`（封顶 `reconnectMaxMs`）退避重连；重连成功后重新 `hello`、对所有仍存活的 session 重新 `session.upsert` 全量快照、并在启用 `resume` 时重新 `sync.list` 拉取远端会话。因此断线期间丢失的增量会被快照覆盖，最终一致。
