# dsh-cloud-sync

一个 DeepSeek Harness (DSH) 插件 bundle，把两件事装进一个包：

1. **OpenTelemetry GenAI 可观测性** —— 复用 [@loongsuite/dsh-plugin](https://github.com/loongsuite/dsh-plugin)，把会话 / Agent 循环 / LLM / 工具生命周期事件导出为 OTel GenAI trace 与 metric。
2. **云端状态同步** —— 新增的 Host 插件，作为 WebSocket **客户端主动外连**云端中继，把**完整会话事件日志**（session header + `snapshotEvents()`）增量推送到云端，从而把不同本地端登录的 DSH 状态集中同步；并在连接时**自动拉回并重建其他设备的会话**（跨设备续接）。

## 结构

```
dsh-cloud-sync/
├─ package.json         bundle 清单（含 dsh.bundle.patch 与依赖）
├─ cordis.patch.yml     插入两行：observability + sync
├─ index.js             云端同步插件（WebSocket 客户端）
├─ locale/en.json  locale/zh.json   显示元数据
└─ icon.svg
```

## 工作原理

- 启动时用 Node 内置 `WebSocket`（undici，无需额外依赖）连接 `config.server`。
- 连接后发送 `hello`（携带 `deviceId` / `instanceId` / `token`），随后对 `sessions.list()` 里的每个 session 推送一次**完整快照**（header + 全部事件），重连后同样重新全量同步一次。
- 监听 `session/created`（推快照）、`session/event`（推增量事件）、`session/disposed`（从云端删除该会话）。
- 启用 `resume` 时，连接后向云端 `sync.list` 拉取其他设备的会话摘要，再 `sync.pull` 逐个拉全量日志并用 `sessions.create(id, { seed })` 本地重建。
- 断线后指数退避重连，并用 `ping` 心跳保活。

事件中的 `Buffer`/`ArrayBuffer`/`BigInt`/`Error` 会被 JSON 安全序列化（`__bytes`/`__bigint`/`__error`），函数与 symbol 被丢弃；续接重建前用逆向 `revive()` 还原。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否启用云端同步 |
| `server` | `ws://127.0.0.1:8080/ws` | 云端 WebSocket 地址 |
| `token` | 空 | 云端鉴权令牌，须与云端 `AUTH_TOKEN`/`AUTH_TOKENS` 之一一致 |
| `deviceId` | 自动（`<profile>@<hostname>`） | 本机设备标识 |
| `resume` | `true` | 连接后自动拉取并重建其他设备的会话（跨设备续接） |
| `resumeOnlyFrom` | `[]` | 只拉取这些 deviceId 的会话（空 = 全部） |
| `resumeMaxSessions` | `20` | 每次连接最多重建的会话数 |
| `reconnectMinMs` / `reconnectMaxMs` | `500` / `30000` | 重连退避区间 |
| `heartbeatMs` | `30000` | 心跳间隔 |
| `debug` | `false` | 打印收发消息类型 |

环境变量可覆盖：`DSH_CLOUD_SYNC_SERVER`、`DSH_CLOUD_SYNC_TOKEN`、`DSH_CLOUD_SYNC_DEVICE`。

## 手动操作（斜杠命令）

插件注册了 `/cloud-sync` 命令：

- `/cloud-sync` 或 `/cloud-sync status` —— 显示同步状态（设备、云端、连接、本地会话数、续接开关）。
- `/cloud-sync delete <sessionId>` —— 从云端删除指定会话。
- `/cloud-sync resync` —— 立即触发一次全量重同步。

## 安装

本 bundle 用于**替换**独立的 `@loongsuite/dsh-plugin`：

1. 从 profile 的 bundle 列表中禁用（或移除）`@loongsuite/dsh-plugin`。
2. 用 Plugin Manager 安装本 bundle（它会把 `@loongsuite/dsh-plugin` 作为普通依赖拉进来，并重新插入 observability 行，同时新增 sync 行）。

> `index.js` **零第三方运行时依赖**——只用 Node 22 内置模块（`node:os`、`node:crypto` 与全局 `WebSocket`）；`@loongsuite/dsh-plugin` 作为 bundle 依赖由 DSH loader 从 profile 解析，`index.js` 不直接 import。

详见根目录 `PROTOCOL.md`（wire 协议）与 `cloud-server/`（参考云端服务）。
