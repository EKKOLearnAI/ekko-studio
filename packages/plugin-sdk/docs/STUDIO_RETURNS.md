# 插件需要回传给 Studio 什么

所有 JSON 值都必须可序列化：禁止 undefined、NaN、Infinity、函数、BigInt、循环引用和未编码的二进制。
生命周期回调允许返回 void，这是与普通 JSON RPC 的区别。错误使用 Error 或对应的明确失败结构，不能伪造成功。
可选字段应省略，不写 undefined；JSON 边界先检查再序列化，错误值不会静默删除或转成 null。
具体字段的必填、可空、数值单位与范围见 [FIELD_REFERENCE.md](FIELD_REFERENCE.md)。
宿主定义的 Agent 状态、目录、更新、最终结果与流事件均执行字段校验；错误枚举、未知协议字段或缺少必填字段会拒绝。

## 普通插件

| 入口 | 必须回传/执行 |
| --- | --- |
| `apply(ctx)` | void，或清理函数，或二者的 Promise；注册需要的能力即可，无需返回 ctx。 |
| `mount(root, ctx)` | 渲染 root，返回 void/disposer/Promise；不返回 HTML 字符串作为协议结果。 |
| RPC handler | 返回符合本插件 output 契约的 JSON 值；失败抛 Error，前端 Promise reject。不能返回 undefined。 |
| 工具 execute | `{ ok: boolean, content: string, data?: Json, error?: string }`；失败返回 ok=false 与可读错误。 |
| 聊天命令 execute | JSON 或 void；输入是原始参数字符串。 |
| 自动化动作 execute | JSON，结构应在插件契约中声明，供工作流消费。 |
| hooks handler | `{ value?: Json, deny?: string }`；value 替换内容，deny 拒绝；不用修改时返回空对象。 |
| 业务观察 handler | void/Promise<void>；事件不能通过返回值修改原业务。 |
| messages.emit | 传事件名、JSON data、可选 audience；没有业务返回值。 |
| 前端 ui.selectModel | 宿主返回 `{profile,provider,model,apiMode?}`，关闭或取消返回 null；model 为规范 ID，不含凭证。调用方自行通过 RPC 保存；加载失败或重复打开时 Promise reject。 |

工具 inputSchema 使用 SDK 的 Schema 子集（type/properties/items/required/enum 等）；
它与项目 harness 的描述型 schema 分开，宿主 Schema 支持 description；不支持 $ref/anyOf 等未声明的 JSON Schema 关键字。
复用契约模型时，先确认所有关键字都属于 SDK Schema 子集。

```js
return { ok: true, content: '已保存', data: { id: 'note-1' } }
// 明确失败：
return { ok: false, content: '无法保存', error: '目标记录不存在' }
```

## Agent 管理与生命周期

| 入口 | 返回结构 |
| --- | --- |
| getStatus | `{ installed, version, source?, path?, error? }` |
| management.settings | `{ viewId, query? }`；必须是本插件声明的 agent-settings 视图；不要求注册任何全局侧栏入口。 |
| management.checkUpdate | `{ currentVersion, latestVersion, updateAvailable, message? }` |
| management.upgrade | `{ installedVersion, message? }`；输入含 version/expectedVersion，插件自行处理引擎恢复。 |
| management.remove | `Promise<void>`；只移除受管引擎，成功后 getStatus 必须返回 installed:false，保留源码、配置、凭证及会话数据。 |
| management.supportsAutoUpdate | `boolean` 或 `Promise<boolean>`；当前安装是否支持无人值守更新，缺省 false，外部托管或需要交互时返回 false。 |
| modes.global.listModels | `{ status, source, scope, models, message? }`；状态和模型字段见 sdk/src/agents.ts。 |
| runtime.createSession | `{ run, dispose, checkpoint? }`；声明 resume=true 时必须实现 checkpoint。 |
| checkpoint | `{ schemaVersion: 正整数, data: Json }`，变更格式需要兼容或迁移说明。 |
| session.dispose | void/Promise<void>，释放引擎进程、监听、连接和缓存句柄。 |

## Agent 运行的事件与最终结果

`run(input, ctx)` 的 input 含本轮 input、历史 history（不含本轮）、instructions、options。
文本 `{type:'text',text}`，图片/文件 `{type:'image'|'file',assetId,name,mediaType}`。
宿主已有历史不要再次当作本轮输入重复提交。

标准事件：

| type | 必填字段 | 可选字段与限制 |
| --- | --- | --- |
| text.delta | text:string | 文本增量，允许空字符串 |
| reasoning.summary.delta | text:string | 推理摘要增量，不是最终回复 |
| status | phase:thinking/working/compressing | message?:string |
| tool.started | callId:非空 string、name:非空 string、input:JSON 对象 | callId 在未结束时不可重复 |
| tool.completed | callId:非空 string、result:Json | result 可为 null，但不能缺失 |
| tool.failed | callId:非空 string、error:string | 使用与 started 相同的 callId |

这些对象都含必填 type，拒绝未知字段；每条 JSON 都受大小限制。image/file 最终内容必须提供
非空 assetId/name/mediaType；usage 的 token 计数为非负安全整数或 null，costUsd 为非负有限数或 null，
提供 usage 时 inputTokens/outputTokens/isEstimated 三项必填。

```js
await ctx.output.emit({ type: 'text.delta', text: '你好' })
await ctx.output.emit({ type: 'reasoning.summary.delta', text: '正在检查输入' })
await ctx.output.emit({ type: 'status', phase: 'working', message: '读取文件' })
await ctx.output.emit({ type: 'tool.started', callId: 'call-1', name: 'read', input: { path: 'a.txt' } })
await ctx.output.emit({ type: 'tool.completed', callId: 'call-1', result: { text: '内容' } })
// 失败时以同一 callId 结束：tool.failed + error 字符串。
```

每个 tool.started 都必须对应 completed/failed，不能重复使用正在执行的 callId。
phase 只允许 thinking/working/compressing。迟到事件不能在结束后继续发。

最终返回：

```js
return {
  content: [{ type: 'text', text: '你好，处理完成。' }],
  finishReason: 'stop', // 也可以是 length 或 tool_limit
  usage: { inputTokens: 12, outputTokens: 8, isEstimated: false },
  // 可选 checkpoint: { schemaVersion: 1, data: { sessionKey: '...' } }
}
```

content 必须是完整回复，增量仅供实时预览，宿主最终只保存一次。
usage 的 inputTokens/outputTokens 可为 null，cacheReadTokens/costUsd 可选且可为 null；
填写实际统计或明确 isEstimated，不编造用量。取消应响应 signal 并清理，错误抛出由宿主处理终态。
宿主生成运行 ID、持久化工具历史/最终消息并发布完成事件，插件无需自行伪造这些宿主事件。

## SDK v1 返回规则

资源注册统一使用 lifecycle.add/acquire；业务事件与插件消息分开，Agent 运行事件通过 output.emit 发布。
state.agentSession 是 Agent 专用会话分区，state.plugin 始终是插件全局存储。
CDP send 返回原始协议 JSON；attach 返回 cursor 和 iframe sessions；events 返回 cursor/oldestCursor/dropped/events。
每条事件含 sequence/method/params，可带 sessionId/truncated。按返回 cursor 继续轮询；dropped/truncated 时由调用者决定是否重新读取页面状态。
CDP 模块不返回宿主 token、调试端口或其他标签页的 WebContents 对象。通用 SDK JSON 值仍有 2 MB 限制。

## 单聊和 BOT 实时返回

host.sessions.connect 与 host.bots.connect 返回 HostSession：sessionId、run、stop、resume、queue、interactions、close。
控制方法 Promise<void> 只表示已分发到核心通道，最终状态由 run.started/queued/completed/failed、abort、
approval/clarify 等原始事件确认。连接故障时控制调用 reject，宿主不会把未确认的指令自动重发。
回调的 SessionEvent 包含 event/session_id 和核心协议原始 JSON 字段；文本增量位于 delta，
最终完整结果位于 run.completed.output，恢复数据位于 resumed 快照。
transport.connected/disconnected/error/closed 反映连接与交付状态，不等同于运行完成或失败。
重连重新获取快照，不能据此假定断线期间每个增量均被补发；插件按宿主快照和历史恢复。
close 只释放自身订阅，保持宿主任务继续运行；显式 stop 发出原有 abort 指令。
BOT 的普通方法保留现有服务 JSON 形状及并发 revision；校验失败直接 reject。
