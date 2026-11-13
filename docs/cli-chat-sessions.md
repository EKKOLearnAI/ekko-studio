# Chat Sessions 链路文档

> 状态：本文档按当前 `main` 重新整理普通 Chat 会话的完整实现链路。旧的独立
> CLI Chat 面板、`/cli-chat-run` namespace、`cli-chat.ts` 客户端和 Python
> bridge 直连命令层已经不再是产品入口。
>
> 最后重建时间：2026-06-03。

## 1. 结论先行

当前普通 Chat 的主链路是：

```text
ChatPanel / ChatInput
  -> Pinia chat store
  -> packages/client/src/api/studio/chat.ts
  -> Socket.IO namespace /chat-run
  -> ChatRunSocket
  -> handleBridgeRun()
  -> AgentBridgeClient
  -> hermes_bridge.py broker
  -> profile worker
  -> AIAgent / Hermes Agent tools
```

也就是说，当前 Web UI 普通聊天默认不是走 Hermes Gateway `/v1/responses`，
而是走 `source=cli` 的 Agent Bridge 路径。代码里仍保留 `api_server`
类型和 `handle-api-run.ts`，但 `resolveRunSource()` 当前固定返回 `cli`。

核心原则：

- UI 只有一套普通 Chat 页面，不再有单独 CLI Chat 页面。
- 所有长连接事件统一走 `/chat-run`。
- 所有普通会话都落 Web UI 自己的 SQLite `sessions/messages` 表。
- Hermes profile、model、provider、workspace、source 都是 session 级上下文。
- 多 tab / 页面刷新通过 `resume` 重新加入同一个 `session:{id}` room。
- 同一个 session 同时只跑一个 active run，后续输入进入 session 队列。
- 工具审批、用户澄清、压缩、abort、usage、slash command 都复用同一条
  `/chat-run` 事件通道。

## 2. 主要文件

### 前端

| 文件 | 职责 |
| --- | --- |
| `packages/client/src/components/hermes/chat/ChatPanel.vue` | 普通 Chat 页面容器，组合消息列表、输入框、审批条、澄清条、抽屉面板。 |
| `packages/client/src/components/hermes/chat/ChatInput.vue` | 输入框、发送、附件、停止按钮入口。 |
| `packages/client/src/components/hermes/chat/MessageList.vue` / `VirtualMessageList.vue` | 消息列表渲染和虚拟滚动。 |
| `packages/client/src/components/hermes/chat/MessageItem.vue` | 单条消息渲染，包含 assistant、tool、reasoning、附件等 UI。 |
| `packages/client/src/stores/hermes/chat.ts` | Chat 核心状态机：session 列表、发送、resume、队列、流式事件、审批、澄清、abort、压缩状态。 |
| `packages/client/src/api/studio/chat.ts` | `/chat-run` Socket.IO 客户端，负责连接、全局事件分发、run/resume/abort/approval/clarify 协议。 |
| `packages/client/src/api/studio/sessions.ts` | HTTP session API：列表、详情分页、删除、重命名、模型更新。 |
| `packages/client/src/api/studio/group-chat.ts` | `/group-chat` Socket.IO 客户端和 group-chat HTTP room/agent/config API。 |
| `packages/client/src/stores/hermes/group-chat.ts` | Group Chat 状态机：rooms、members、messages、agents、streaming、context/compression 状态。 |
| `packages/client/src/components/hermes/group-chat/*` | Group Chat 页面、输入框、消息列表、成员/agent 展示和房间创建配置。 |

### 后端

| 文件 | 职责 |
| --- | --- |
| `packages/server/src/modules/studio/sockets/chat-run.ts` | `ChatRunSocket`，`/chat-run` namespace 入口、认证、profile 校验、run/resume/abort/approval/clarify/queue 分发。 |
| `packages/server/src/modules/studio/services/chat-run/handle-bridge-run.ts` | 当前主运行路径：创建/更新本地 session，构建上下文，调用 Agent Bridge，消费 bridge 事件，落库。 |
| `packages/server/src/modules/studio/services/chat-run/session-command.ts` | slash command 解析和执行。 |
| `packages/server/src/modules/studio/services/chat-run/abort.ts` | active run 中断、状态落盘、队列衔接。 |
| `packages/server/src/modules/studio/services/chat-run/compression.ts` | DB history 构建、snapshot-aware history、上下文压缩。 |
| `packages/server/src/modules/studio/services/chat-run/bridge-message.ts` | Bridge assistant/tool 消息的内存态与 DB flush。 |
| `packages/server/src/modules/studio/services/chat-run/bridge-delta.ts` | 过滤 bridge 输出中的工具调用标记，避免 UI 文本重复或丢字符。 |
| `packages/server/src/modules/hermes/services/bridge/client.ts` | Node 到 Python bridge 的本地 socket 客户端。 |
| `packages/server/src/modules/hermes/services/bridge/manager.ts` | Python bridge broker 子进程生命周期管理。 |
| `packages/server/src/modules/hermes/services/bridge/python/hermes_bridge.py` | Python broker/worker entrypoint；实现拆分在同目录的 `bridge_*.py` 模块中，覆盖 `AIAgent` 会话池、工具审批、澄清、压缩协作、goal/plan 命令等。 |
| `packages/server/src/modules/studio/sockets/group-chat.ts` | `/group-chat` Socket.IO server、room/member/message 存储、agent 恢复、mention 分发、approval/interrupt 入口。 |
| `packages/server/src/modules/studio/services/group-chat/agent-clients.ts` | Group Chat agent socket client，经 Studio runtime port 调用具体 Agent，并同步 tool/reasoning/context 状态。 |
| `packages/server/src/modules/studio/services/group-chat/*` | Group Chat 编排、上下文投影、summary cache、relay、附件与共享工作区。 |
| `packages/server/src/modules/studio/services/context-compressor/*` | 普通 Chat 和 Group Chat 共用的 token 估算、摘要压缩和 context message 处理。 |
| `packages/server/src/modules/studio/routes/group-chat.ts` | Group Chat HTTP room/agent/config/compress/clear-context API。 |
| `packages/server/src/modules/studio/repositories/session-store.ts` | Web UI 本地 session/message SQLite 存储。 |
| `packages/server/src/modules/studio/controllers/sessions.ts` | HTTP session 列表、详情、分页、删除、导入/导出等控制器。 |

## 3. 数据模型

普通 Chat 使用 Web UI 本地 SQLite，而不是直接把 Hermes CLI 历史当作唯一状态。
核心表由 `packages/server/src/modules/studio/infrastructure/database/schemas.ts` 初始化。

### sessions

`session-store.ts` 暴露的主要字段：

| 字段 | 说明 |
| --- | --- |
| `id` | Web UI session id。前端新建时生成，发送 run 时传入。 |
| `profile` | Hermes profile。新 session 使用当前 active profile，已存在 session 优先使用 DB 中的 profile。 |
| `source` | 当前会话来源。当前普通 Chat 实际写入 `cli`。历史数据可能存在 `api_server`。 |
| `model` / `provider` | session 绑定模型。首轮发送会写入选中的模型/供应商，后续可更新。 |
| `title` / `preview` | 会话标题和预览。标题可以由 `/title` 改，也可由首条用户输入生成。 |
| `workspace` | 当前工作目录上下文，会被注入 run instructions。 |
| `message_count` / `tool_call_count` | 由 `updateSessionStats()` 从 messages 表统计。 |
| `input_tokens` / `output_tokens` | usage 统计结果。 |
| `last_active` / `started_at` / `ended_at` | 会话时间元数据。 |

### messages

主要 role：

| role | 说明 |
| --- | --- |
| `user` | 普通用户输入。 |
| `command` | 用户输入的 slash command 展示消息。 |
| `assistant` | Agent 输出文本，可带 `reasoning` / `reasoning_content`。 |
| `tool` | 工具执行结果。 |

工具调用相关字段：

- `tool_call_id`
- `tool_calls`
- `tool_name`
- `finish_reason`
- `reasoning`
- `reasoning_details`
- `reasoning_content`

前端读取历史时通过 `mapHermesMessages()` 把 DB 行映射成 UI `Message`，包括：

- assistant 文本消息
- reasoning 内容
- tool started/tool completed 的可视化行
- 队列消息
- command/system 消息

## 4. 前端状态机

`useChatStore()` 是普通 Chat 的中心状态。

常见状态：

| 状态 | 说明 |
| --- | --- |
| `sessions` | 当前加载的 session 列表和每个 session 的消息数组。 |
| `activeSessionId` / `activeSession` | 当前页面正在显示的 session。 |
| `serverWorking` | 前端认为服务端仍有 active run 的 session id 集合。 |
| `streamStates` | 当前前端已注册流式 handler 的 session。 |
| `queueLengths` / queued user messages | 每个 session 的服务端队列长度和 UI 可见队列消息。 |
| `pendingApprovals` | 工具审批请求，按 `sessionId + approvalId` 存。 |
| `pendingClarifies` | 用户澄清请求，按 `sessionId + clarifyId` 存。 |
| `compressionStates` | 上下文压缩中的临时 UI 状态。 |
| `abortState` | 当前 active run 的中断状态。 |

### 新建会话

普通新建入口最终调用：

```ts
newChat(options)
```

它会：

1. 从当前 app model/profile 状态创建本地前端 session 对象。
2. 切换到这个 session。
3. 此时 DB 里不一定已经有 session 行；真正落库发生在第一次 run 时。

历史上的 `newCliSession()` 仍存在，但普通 Chat 当前也是 `source=cli`，不再需要单独 UI 面板区分。

### 切换会话

切换 session 时，store 会优先通过 Socket.IO `resume`：

```ts
resumeSession(sessionId, onResumed, profile)
```

服务端会：

1. `socket.join("session:<id>")`
2. 如果内存 `sessionMap` 有状态，直接返回。
3. 否则从 DB 读取分页消息和 usage。
4. 如果该 session 正在运行，返回最近 transient events。

前端收到 `resumed` 后会：

- 替换/补齐本地消息。
- 恢复 `isWorking`、`isAborting`、queue、usage。
- 对 active run 重新注册 handlers。
- 重新显示审批、澄清、压缩、abort 等未完成状态。

## 5. 发送消息链路

### 前端发送

入口是 `chat.ts` store 的：

```ts
sendMessage(content, attachments?)
```

主要步骤：

1. 如果没有 active session，先创建一个。
2. 捕获发送时的 `sid`，后续所有回调都用这个 sid，避免用户切换 session 后事件写错地方。
3. 判断是否 slash command：`content.trim().startsWith("/")`。
4. 判断是否需要排队：
   - 如果服务端当前 session 正在运行；
   - 且不是可立即处理的 mid-run slash command；
   - 则 UI 先显示 queued 消息。
5. 如果有附件：
   - 先走 `/api/studio/uploads`；
   - 再组装 `ContentBlock[]`；
   - image block 包含 `type/name/path/media_type`；
   - file block 包含 `type/name/path/media_type?`。
6. 等待模型列表 ready，读取当前 session 或全局选择的 model/provider。
7. 构造 run payload。

当前 payload 形态：

```ts
{
  input,
  session_id: sid,
  profile,
  model,
  provider,
  model_groups,
  queue_id: userMsg.id,
  source: "cli",
}
```

首轮发送会带 `model/provider`，已存在 session 后通常依赖 DB 中的 session 模型。

### Socket.IO 发送

`startRunViaSocket()` 负责：

1. `connectChatRun(profile)` 建立或复用 `/chat-run` socket。
2. 注册当前 `session_id` 的事件 handlers 到 `sessionEventHandlers`。
3. 发送：

```ts
socket.emit("run", body)
```

如果同一个 session 已经有 handler，新的 run 只 emit，不重复注册，避免多 tab/多次发送造成事件重复处理。

## 6. `/chat-run` 连接和认证

前端连接：

```ts
io(`${baseUrl}/chat-run`, {
  auth: { token },
  query: { profile },
  transports: ["websocket", "polling"],
  reconnection: true,
})
```

后端 `ChatRunSocket.authMiddleware()`：

1. 如果 auth 关闭，直接放行。
2. 如果 auth 开启，使用 `authenticateUserToken()` 验证 token。
3. 如果 socket query 里带 profile，检查用户是否可访问该 profile。
4. 把 authenticated user 写入 `socket.data.user`。

每次 run 时还会调用 `resolveRunProfile()`：

- payload 显式 `profile` 优先。
- 没有 session id 时使用 socket 当前 profile。
- 有 session id 时优先用 DB 中 session.profile。
- 非 super admin 需要通过 `userCanAccessProfile()`。

## 7. 服务端 run 分发

`ChatRunSocket` 监听：

| 客户端事件 | 服务端行为 |
| --- | --- |
| `run` | 解析 profile、source、slash command、queue，然后进入 run handler。 |
| `resume` | 加入 session room，返回 DB/内存状态。 |
| `abort` | 调用 `handleAbort()`。 |
| `cancel_queued_run` | 从 session queue 删除指定 queue item。 |
| `approval.respond` | 转发到 bridge `approval_respond`。 |
| `clarify.respond` | 转发到 bridge `clarify_respond`。 |

### source 分流

当前代码：

```ts
export function resolveRunSource(_source?: string, _sessionId?: string): ChatRunSource {
  return "cli"
}
```

因此：

- payload 即使传 `source: "api_server"`，当前仍会被解析为 `cli`。
- `handleApiRun()` 是保留实现，不是当前普通 Chat 的实际路径。
- 新会话落库时 `source` 写为 `cli`。

### sessionMap

后端内存态是：

```ts
Map<string, SessionState>
```

每个 `SessionState` 包含：

- `messages`
- `isWorking`
- `isAborting`
- `events`
- `queue`
- `runId`
- `activeRunMarker`
- `profile`
- `source`
- bridge pending text/reasoning/tool 状态
- usage/context token 状态

DB 是持久层，`sessionMap` 是运行时和 resume 用的 transient 层。

## 8. Bridge run 详细链路

实际执行在：

```ts
handleBridgeRun(...)
```

### 8.1 初始化 run

服务端会：

1. 根据 session DB 和 payload 解析 model/provider。
2. 生成 `runMarker = cli_run_<...>`，用于把同一轮用户、assistant、tool 消息串起来。
3. 初始化 `SessionState`：
   - `isWorking = true`
   - `isAborting = false`
   - `source = "cli"`
   - 清空 pending assistant/reasoning/tool 状态
4. 如果需要展示用户输入：
   - 内存 `state.messages.push(...)`
   - 如果 DB session 不存在，`createSession({ source: "cli" })`
   - `addMessage()` 写入 DB
5. `socket.join("session:<id>")`
6. 向其他同 room tab 广播 `run.peer_user_message`。

### 8.2 instructions 组装

最终 instructions 包含：

- `getSystemPrompt()`
- 用户或调用方传入的 `instructions`
- 当前 Hermes profile
- session workspace
- Web UI 工具调用提示：如果工具调用 Web UI API，需要带 `X-Hermes-Profile`

### 8.3 上下文构建

run 前调用：

```ts
buildCompressedHistory(...)
```

它会基于 DB history 和 compression snapshot 构建适合本次 run 的历史：

- 读取本 session messages。
- 排除或包含当前用户输入，视调用场景决定。
- 使用 snapshot-aware history，避免已经压缩的旧上下文重复膨胀。
- 必要时触发上下文压缩。
- 对 Bridge 路径会调用 `context_estimate` 估算固定上下文开销：
  - system prompt tokens
  - tool tokens
  - tool count/names

### 8.4 调用 AgentBridgeClient

服务端发起：

```ts
bridge.chat(sessionId, bridgeInput, bridgeHistory, fullInstructions, profile, {
  storage_message,
  model,
  provider,
})
```

返回：

```ts
{
  ok: true,
  run_id,
  session_id,
  status
}
```

随后 Node 轮询：

```ts
for await (const chunk of bridge.streamOutput(run_id)) {
  applyBridgeChunkAsync(...)
}
```

`streamOutput()` 实际通过 `get_output` action，携带 `cursor` 和 `event_cursor`
增量读取文本和事件。

## 9. Python Agent Bridge

### 9.1 进程结构

`AgentBridgeManager` 启动 `hermes_bridge.py` broker 子进程：

```text
python hermes_bridge.py --endpoint <endpoint> --agent-root <root> --hermes-home <home>
```

默认 endpoint：

| 平台 | 默认 |
| --- | --- |
| Windows | `tcp://127.0.0.1:18765` |
| macOS/Linux | `ipc:///tmp/hermes-agent-bridge.sock` |

broker 会再按 profile 路由到 worker。worker 里维护实际 `AIAgent` 会话池。

### 9.2 Node/Python 协议

Node 和 Python 使用本地 socket 的单行 JSON 协议。

示例请求：

```json
{"action":"chat","session_id":"abc","message":"hello","profile":"default"}
```

示例响应：

```json
{"ok":true,"run_id":"...","session_id":"abc","status":"running"}
```

`AgentBridgeClient` 每次请求新建 socket，发送一行 JSON，读取一行 JSON。
请求默认串行化，默认 timeout 是 120 秒，connect 失败有短重试窗口。

### 9.3 常用 action

| action | 说明 |
| --- | --- |
| `chat` | 启动一轮 agent conversation。 |
| `get_output` | 根据 cursor/event_cursor 拉取增量输出。 |
| `context_estimate` | 估算 system prompt/tool 固定上下文 token。 |
| `interrupt` | 中断 session 当前 run。 |
| `steer` | 给正在运行的 session 追加 steering instruction。 |
| `command` | 执行 plan/goal/subgoal 等 bridge command。 |
| `approval_respond` | 响应工具审批。 |
| `clarify_respond` | 响应澄清请求。 |
| `compression_respond` | Node 完成本地压缩后把压缩结果交还给 bridge。 |
| `goal_evaluate` / `goal_pause` | goal continuation 的状态评估和暂停。 |
| `status` | 查询 bridge session 状态。 |
| `destroy` | 销毁指定 bridge session。 |
| `destroy_all` | 销毁全部 bridge session，主要用于进程关闭或维护。 |
| `mcp_*` | MCP 相关维护动作，例如 reload。 |

## 10. 流式事件映射

Bridge 输出 chunk 里有两类数据：

- `delta`：聚合文本增量。
- `events`：有序事件列表。

如果 `events` 中出现 `stream.delta`，Node 以事件顺序处理文本，避免再处理
聚合 `chunk.delta`，否则会重复输出。

### 事件映射

| Bridge event | `/chat-run` event | UI 结果 |
| --- | --- | --- |
| `stream.delta` / chunk `delta` | `message.delta` | assistant 文本增量。 |
| `reasoning.delta` | `reasoning.delta` | reasoning 增量。 |
| `thinking.delta` | `thinking.delta` | thinking/reasoning 增量。 |
| `reasoning.available` | `reasoning.available` | 标记 reasoning 可用。 |
| `tool.started` | `tool.started` | 显示工具开始行，先 flush pending assistant 文本。 |
| `tool.completed` | `tool.completed` | 显示工具结果和耗时/error。 |
| `subagent.*` | `subagent.*` | 显示子代理状态、工具、进度和总结。 |
| `status` | `agent.event` | 显示 agent 状态事件。 |
| `approval.requested` | `approval.requested` | 显示审批条。 |
| `approval.resolved` | `approval.resolved` | 清理审批条。 |
| `clarify.requested` | `clarify.requested` | 显示澄清输入。 |
| `clarify.resolved` | `clarify.resolved` | 清理澄清输入。 |
| `bridge.compression.requested` | `compression.started` | UI 显示压缩中，Node 执行本地压缩。 |
| `bridge.compression.completed` | `compression.completed` | UI 显示压缩结果，更新 context tokens。 |
| terminal chunk done | `run.completed` / `run.failed` | 结束 run，更新 usage，衔接队列。 |

### 消息落库

Bridge run 中不会每个字符都立即落库。Node 会维护 pending assistant/tool 状态：

- 文本增量累加到 `bridgePendingAssistantContent`。
- reasoning 累加到 `bridgePendingReasoningContent`。
- 工具开始前、turn boundary、run 结束、abort 前会 `flushBridgePendingToDb()`。
- tool started/completed 通过 `recordBridgeToolStarted()` 和
  `recordBridgeToolCompleted()` 形成 DB 可恢复的 assistant/tool 结构。

这样可以保证：

- UI 实时流式显示。
- DB 中历史可恢复。
- 刷新页面后 tool/reasoning/assistant 不丢。

## 11. run 完成和失败

当 bridge chunk `done=true`：

1. flush pending 工具标记和 assistant 文本。
2. `updateSessionStats(sessionId)`。
3. 延迟短时间等待 usage flush。
4. `calcAndUpdateUsage()` 计算 input/output tokens。
5. `refreshFinalContextUsage()` 计算 snapshot-aware context tokens。
6. `updateUsage()` 写 usage store。
7. 检测 `bridgeTerminalError()`：
   - bridge status 为 `error`
   - result 中带 error/exception
   - final_response 看起来是上游错误
8. 发送 `run.completed` 或 `run.failed`。
9. 如果队列中还有消息，自动 dequeue 下一条。

前端收到 terminal event 后：

- 关闭 streaming assistant 状态。
- 清理 `serverWorking`。
- 播放完成提示音（如果开启）。
- 更新 session title/usage/context tokens。
- 如果 `queue_remaining > 0`，保持 handler，不提前清理。

## 12. 队列

同一个 session 同时只允许一个 active run。

队列进入点：

1. 服务端收到 `run`，发现 `state.isWorking=true`。
2. 前端 `/queue <message>` command。
3. `/plan` 或 `/goal` 生成 kickoff prompt，但当前 session 正在运行。
4. abort 完成后仍有队列。

队列项类型：

```ts
interface QueuedRun {
  queue_id: string
  input: string | ContentBlock[]
  displayInput?: string | ContentBlock[] | null
  displayRole?: "user" | "command"
  storageMessage?: string
  model?: string
  provider?: string
  model_groups?: Array<{ provider: string; models: string[] }>
  instructions?: string
  profile: string
  source?: "cli" | "api_server"
  originSocketId?: string
  goalContinuation?: boolean
}
```

队列事件：

- `run.queued`：队列长度变化。
- `queued_messages`：UI 可见队列消息。
- `dequeued_queue_id`：某条队列开始执行，前端移除 queued 展示。

取消队列：

```ts
socket.emit("cancel_queued_run", { session_id, queue_id })
```

## 13. Abort

前端 stop 按钮最终调用：

```ts
socket.emit("abort", { session_id })
```

服务端 `handleAbort()`：

1. 如果没有 active run，发送 ignored 的 `abort.completed`。
2. 设置 `state.isAborting=true`。
3. 发送 `abort.started`。
4. 先 flush 当前内存 assistant/tool 状态到 DB。
5. CLI source 调用：
   - `bridge.interrupt(sessionId, "Aborted by user", profile)`
   - `bridge.goalPause(..., "user-interrupted")`
   - 移除 goal continuation 队列项
6. 标记 abort completed，更新 usage。
7. 如果队列不为空，启动下一条队列。

前端收到：

- `abort.started`：显示中断中。
- `abort.completed`：清理中断状态；如果有队列继续保持 streaming handler。

## 14. 工具审批

Bridge 里有两类审批来源：

1. Hermes 工具层直接回调，例如 terminal/本地命令审批。
2. gateway approval notify，经 `tools.approval` 按 session key 路由。

Python 侧生成：

```json
{
  "event": "approval.requested",
  "approval_id": "...",
  "command": "...",
  "description": "...",
  "choices": ["once", "session", "always", "deny"],
  "allow_permanent": true,
  "timeout_ms": 60000
}
```

Node 映射到 `/chat-run`：

```ts
approval.requested
```

前端：

- `chat.ts` store 写入 `pendingApprovals`。
- `ChatPanel.vue` 显示审批 UI。
- 用户选择后调用：

```ts
respondToolApproval(sessionId, approvalId, choice)
```

再发送：

```ts
socket.emit("approval.respond", {
  session_id,
  approval_id,
  choice, // once | session | always | deny
})
```

Python bridge 会：

- 找到对应 approval queue 或 gateway session。
- 写入选择。
- 发送 `approval.resolved`。
- 在运行开始/审批相关路径刷新 `command_allowlist` 的进程内缓存，确保“始终允许”的持久配置能被后续工具判断读到。

## 15. 用户澄清

澄清请求和审批类似，但用于 agent 主动问用户问题。

Bridge event：

```json
{
  "event": "clarify.requested",
  "clarify_id": "...",
  "question": "...",
  "choices": ["..."],
  "timeout_ms": 60000
}
```

前端显示澄清 UI，并发送：

```ts
socket.emit("clarify.respond", {
  session_id,
  clarify_id,
  response
})
```

服务端转发到：

```ts
bridge.clarifyRespond(clarifyId, response)
```

然后通过 `clarify.resolved` 清理 UI 状态。

## 16. Slash Commands

slash command 不是独立 socket 事件。它们作为普通 `run.input` 发给 `/chat-run`，
后端在 `source=cli` 时由 `session-command.ts` 解析。

当前支持：

| 命令 | 说明 |
| --- | --- |
| `/usage` | 计算并显示当前 session usage。 |
| `/status` | 显示 session/bridge/profile/model/queue/run 状态。 |
| `/abort` | 请求中断当前 run。 |
| `/queue <message>` | 当前 run 活跃时追加一条队列消息。 |
| `/plan ...` | 调用 bridge plan command，可能生成 kickoff prompt 并立即/排队运行。 |
| `/goal ...` | 设置、查询、暂停、恢复、清理 goal。 |
| `/subgoal ...` | 子目标命令。 |
| `/clear` | 清理当前显示状态，不删 DB 历史。 |
| `/clear --history` | 删除当前 session DB messages，要求 session idle。 |
| `/title <title>` | 重命名 session。 |
| `/compress` | session idle 时手动触发上下文压缩。 |
| `/steer <instruction>` | 对正在运行的 bridge run 发送 steering instruction。 |
| `/destroy` | 销毁 bridge agent，清空运行态和队列。 |
| `/reload-mcp [server]` | session idle 时重载 MCP。 |

未知 command 会返回 `session.command` error，不进入 agent run。

## 17. 上下文压缩

压缩有三种触发方式：

1. run 前 `buildCompressedHistory()` 根据上下文窗口自动判断。
2. Bridge 运行中发出 `bridge.compression.requested`。
3. 用户执行 `/compress`。

压缩结果会写 compression snapshot，并在后续 context 构建时使用
snapshot-aware history，避免重复发送完整长历史。

事件：

- `compression.started`
- `compression.completed`

前端会显示临时压缩状态，并更新 session `contextTokens`。

## 18. 多 tab 和断线恢复

多 tab 使用同一个 `session:{id}` room。

关键机制：

- 当前 tab 发出用户消息后，其他 tab 收到 `run.peer_user_message`。
- 所有服务端事件都带 `session_id`。
- 前端全局 Socket.IO listener 根据 `session_id` 分发到对应 handler。
- transient disconnect 后，前端 reconnect 会自动发 `resume`。
- `resume` 返回：
  - DB/内存 messages
  - `isWorking`
  - `isAborting`
  - transient `events`
  - usage/context tokens
  - queue length/messages

因此页面刷新、切换 session、断线重连后可以恢复：

- streaming assistant
- pending approval
- pending clarify
- compression state
- abort state
- queue state

## 19. HTTP Session API 和 Chat 的关系

Socket.IO `/chat-run` 负责 active run。HTTP API 负责静态数据读写：

| 能力 | 路径/模块 |
| --- | --- |
| session list | `modules/studio/controllers/sessions.ts` + `modules/studio/repositories/session-store.ts` |
| session detail/page | `fetchSessionMessagesPage()` 对应后端分页 detail |
| delete session | 删除 Web UI DB session/messages，同时尝试删除对应 Hermes profile 历史（如果存在） |
| rename session | `renameSession()` |
| set session model | `setSessionModel()` |
| conversation monitor | 从本地 session/conversation summary 读，不驱动 active run |

Chat 运行过程中落库由 Socket.IO run handler 做；页面历史和列表刷新使用 HTTP API。

## 20. Group Chat 链路

Group Chat 是聊天核心链路的一部分，使用独立 namespace `/group-chat`，但 agent
执行、context token、压缩、tool/reasoning 展示仍会复用 Agent Bridge 和共享
context-compressor。

主链路：

```text
GroupChatPanel / GroupChatInput
  -> group-chat Pinia store
  -> packages/client/src/api/studio/group-chat.ts
  -> Socket.IO namespace /group-chat
  -> GroupChatServer
  -> AgentClients
  -> AgentBridgeClient
  -> hermes_bridge.py broker
  -> profile worker
  -> AIAgent / Hermes Agent tools
```

核心行为：

- `GroupChatServer` 管理 room、member、typing、message、agent runtime 和 room
  runtime state。
- 普通用户通过 `/group-chat` socket 加入 room；agent 也作为 socket client 加入
  同一个 namespace，但使用 `source=agent` 和 `GROUP_CHAT_AGENT_SOCKET_SECRET`。
- `AgentClients` 根据 mention routing 选择目标 agent，构造 group history 和
  instructions，然后通过 `AgentBridgeClient` 调用对应 profile 的 bridge session。
- group-chat 消息、tool call、tool result、reasoning、context status 都写入
  group-chat 自己的 DB 表，并广播给 room。
- group-chat 有独立 room compression 配置：
  `triggerTokens`、`maxHistoryTokens`、`tailMessageCount`。
- context 压缩通过 `ContextEngine` 和共享 `context-compressor` 实现；压缩进度会
  以 room/agent 维度同步到前端。
- 用户头像、agent 成员、在线状态、邀请链接属于 group-chat member 元数据链路；
  改动这些也需要记录，因为它们会影响聊天页面展示和 room 同步。

排查 group-chat 时优先看：

- `/group-chat` socket handshake auth、`authUserId`、`source=agent`。
- `GroupChatServer.onConnection()`、room join/message/approval/interrupt handlers。
- `AgentClients` 的 mention routing、bridge context cache、tool/reasoning 映射。
- `ContextEngine` 和 room compression 配置。
- `gc_*` DB 表以及 `group-chat` 相关 server/client tests。

## 21. 启动和关闭

启动时：

1. server bootstrap 初始化 DB schema。
2. 启动 group chat Socket.IO server。
3. 尝试启动 Agent Bridge manager。
4. 创建 `ChatRunSocket(groupChatServer.getIO())` 并 `init()`。

Bridge 启动失败不会阻止 Web UI server 启动，但普通 Chat run 会在调用 bridge 时失败。

关闭时：

- `ChatRunSocket.close()` abort active response stream/清理内存态。
- `AgentBridgeManager.stop()` 默认关闭 Python broker，包括 `restart` 使用的
  `SIGUSR2`。如果需要保留 broker 和正在运行的 bridge session，可显式设置
  `HERMES_AGENT_BRIDGE_STOP_ON_SHUTDOWN=0`。
- 其他 WebSocket/Socket.IO 服务按 shutdown 流程停止。

## 22. 环境变量

| 变量 | 说明 |
| --- | --- |
| `HERMES_AGENT_BRIDGE_ENDPOINT` | Node 到 Python bridge broker 的 endpoint。Windows 默认 TCP，macOS/Linux 默认 IPC。 |
| `HERMES_AGENT_BRIDGE_WORKER_TRANSPORT` | broker 到 profile worker 的 transport，支持 `tcp`/`ipc`。 |
| `HERMES_AGENT_BRIDGE_WORKER_PORT_BASE` | TCP worker 起始端口。 |
| `HERMES_AGENT_BRIDGE_TIMEOUT_MS` | Node 等待 bridge 请求响应的超时，默认 120000ms。 |
| `HERMES_AGENT_BRIDGE_CONNECT_RETRY_MS` | Node connect bridge 的短重试窗口，默认 5000ms。 |
| `HERMES_AGENT_BRIDGE_STARTUP_TIMEOUT_MS` | bridge ready 超时，默认 120000ms。 |
| `HERMES_AGENT_BRIDGE_STOP_ON_SHUTDOWN` | Web UI shutdown/restart 是否关闭 bridge broker，默认开启。设为 `0`/`false`/`no`/`off` 才会保留 broker。 |
| `HERMES_AGENT_BRIDGE_AUTO_RESTART` | broker 意外退出是否自动重启，默认开启。 |
| `HERMES_AGENT_BRIDGE_RESTART_DELAY_MS` | 自动重启基础延迟。 |
| `HERMES_AGENT_BRIDGE_PYTHON` | 指定 Python 解释器。 |
| `HERMES_AGENT_ROOT` | 指定 hermes-agent 根目录。 |
| `HERMES_AGENT_BRIDGE_UV` / `UV` | 指定 uv。 |
| `HERMES_AGENT_BRIDGE_PLATFORM` | bridge 传给 Hermes Agent 的 platform，默认 `cli`。 |
| `HERMES_BRIDGE_PROVIDER` | 覆盖 bridge provider。 |
| `HERMES_BRIDGE_MAX_TURNS` | 覆盖 bridge 最大轮数。 |
| `HERMES_WEB_UI_DISABLE_GATEWAY_AUTOSTART` | 跳过启动时的 gateway 检查/自动启动；dashboard-only 部署可用。 |
| `HERMES_WEB_UI_DISABLE_SKILL_INJECTION` | 跳过启动时的内置 skill 注入；外部管理 skills 时可用。默认注入只更新 Web UI 管理或完全相同的内置副本，用户修改的同名 skills 会跳过。 |
| `HERMES_WEB_UI_PREVIEW_AGENT_BRIDGE_TRANSPORT` | Version Preview bridge transport。 |
| `HERMES_WEB_UI_PREVIEW_AGENT_BRIDGE_ENDPOINT` | Version Preview bridge endpoint。 |

## 23. 当前限制和注意事项

- 当前普通 Chat 实际固定走 `cli` bridge；`api_server` handler 是保留代码，不是主链路。
- Bridge 启动失败时 Web UI 仍能打开，但 Chat run 会失败。
- Bridge socket 是本地 JSON line 协议，不是浏览器直接连接 Python。
- 同一 session 只有一个 active run；并发输入走队列。
- `sessionMap` 是进程内 transient 状态，server 重启后只能从 DB 恢复已落库内容，不能恢复已丢失的 Python 内存 run。
- 工具审批依赖 Python bridge 和 Hermes tools 的审批回调；“始终允许”需要持久 allowlist 和进程内 allowlist cache 都更新。
- `workspace`、profile、model/provider 都会影响 run 上下文，排查问题时不要只看 session id。
- group-chat 是独立 namespace `/group-chat` 和独立 store/service，但属于聊天核心链路，相关改动也要更新本文变更记录。

## 24. 排查入口

常见问题和优先检查点：

| 问题 | 检查 |
| --- | --- |
| 发送后没有输出 | 看 server log 中 `[chat-run-socket] starting CLI bridge run` 和 bridge 是否 ready。 |
| Socket 认证失败 | 检查 localStorage token、`/chat-run` auth middleware、用户 profile 权限。 |
| profile 不对 | 看 socket query profile、payload profile、DB session.profile。已存在 session 优先使用 DB profile。 |
| 输出重复 | 看 `stream.delta` 和 `chunk.delta` 是否被重复处理，重点查 `bridge-delta.ts` / `applyBridgeChunkAsync()`。 |
| 工具消息丢失 | 查 `flushBridgePendingToDb()`、`recordBridgeToolStarted()`、`recordBridgeToolCompleted()`。 |
| 刷新后状态不对 | 查 `resume` payload、`state.events`、前端 `resumeServerWorkingRun()`。 |
| 队列不同步 | 查 `run.queued`、`queued_messages`、`dequeued_queue_id`。 |
| 审批一直弹 | 查 bridge approval callback、`approval.respond`、工具 allowlist 是否持久化且 cache 已刷新。 |
| abort 后仍运行 | 查 `bridge.interrupt()`、`goalPause()`、`abort.completed` 和 Python worker 状态。 |
| token/context 数不对 | 查 `context_estimate`、compression snapshot、`refreshFinalContextUsage()`。 |
