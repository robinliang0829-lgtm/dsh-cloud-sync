# dsh-cloud-sync-server（参考云端服务）

`dsh-cloud-sync` 插件对应的参考云端中继。自部署的一个 Node.js 进程：接收各本地 DSH 主动发来的 WebSocket 连接，集中存储每台设备的**完整会话事件日志**，并用 REST API 供查询 / 回溯 / 跨设备拉取。

## 运行

```bash
cd cloud-server
npm install
npm start
```

环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | HTTP/WS 监听端口 |
| `HOST` | `0.0.0.0` | 绑定地址 |
| `DATA_DIR` | `./data` | 状态落盘目录（`store.json`） |
| `AUTH_TOKEN` | 空 | 共享密钥；非空时 WS `hello.token` 与 REST `Authorization: Bearer <token>`（或 `?token=`）必须一致 |
| `AUTH_TOKENS` | 空 | 逗号分隔的多 token（与 `AUTH_TOKEN` 合并）。每个 token 一个**租户** `sha256(token)`：`sync.list`/`sync.pull` 只跨同租户设备拉取，REST 只返回同租户数据 |

依赖：仅 `ws`（WebSocket server 实现）。

## REST API（均在鉴权通过后可用，且按租户过滤）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 存活 + 设备/会话计数（免鉴权） |
| GET | `/devices` | 本租户所有设备摘要（connected / hostname / lastSeen / sessionCount） |
| GET | `/devices/:deviceId` | 单设备摘要 |
| GET | `/devices/:deviceId/sessions` | 该设备全部会话摘要 |
| GET | `/devices/:deviceId/sessions/:sid` | 会话头 + seq + eventCount |
| GET | `/devices/:deviceId/sessions/:sid/events?from=&to=&format=json\|ndjson` | 事件日志（回溯/续接数据源） |
| GET | `/sessions` | 跨设备列出本租户所有会话 |
| DELETE | `/devices/:deviceId/sessions/:sid` | 从云端删除该会话（本租户内） |

示例：

```bash
curl http://localhost:8080/health
curl http://localhost:8080/devices
curl -H "Authorization: Bearer my-token" http://localhost:8080/devices
curl "http://localhost:8080/devices/desktop@my-pc/sessions/abc123/events?format=ndjson"
```

## WebSocket 协议

路径 `/ws`，消息为 JSON，见根目录 `PROTOCOL.md`。客户端（DSH 插件）发 `hello` / `session.upsert` / `session.append` / `session.close` / `session.delete` / `sync.list` / `sync.pull` / `ping`；服务端回 `welcome` / `ack` / `pong` / `sync.list`（续接候选）/ `sync.session`（拉取结果）。

## 存储

- 内存 + `DATA_DIR/store.json`（防抖 250ms 落盘，进程退出时强制落盘）。
- `session.upsert` 幂等覆盖该会话的完整快照；`session.append` 按 `seq` 去重增量合并；`session.delete` 从存储移除该会话。
- 断线只把设备标记为 `connected:false`，状态不丢；重连后插件会重新全量 `upsert`。

> 说明：这是**参考实现**——单进程、单文件 JSON 存储，适合自托管与开发验证。生产可替换为 Redis/Postgres，并给 `/events` 加鉴权与分页。
