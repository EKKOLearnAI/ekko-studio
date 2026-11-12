# 插件需要回传给 Studio 什么

所有 JSON 值都必须可序列化：禁止 undefined、NaN、Infinity、函数、BigInt、循环引用和未编码的二进制。
生命周期回调允许返回 void，这是与普通 JSON RPC 的区别。错误使用 Error 或对应的明确失败结构，不能伪造成功。

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
| ui.emit | 传事件名、JSON data、可选 audience；没有业务返回值。 |

工具 inputSchema 使用 SDK 的 Schema 子集（type/properties/items/required/enum 等）；
它与项目 harness 的描述型 schema 分开，宿主 Schema 不支持 description/$ref 等任意 JSON Schema 关键字。
不要把 `contracts/plugin.json` 中带 description 的模型直接当 inputSchema 传给宿主。

```js
return { ok: true, content: '已保存', data: { id: 'note-1' } }
// 明确失败：
return { ok: false, content: '无法保存', error: '目标记录不存在' }
```

## Agent 管理与生命周期

| 入口 | 返回结构 |
| --- | --- |
| getStatus | `{ installed, version, source?, path?, error? }` |
| management.settings | `{ viewId, query? }`；必须是本插件声明的 settings 视图。 |
| management.checkUpdate | `{ currentVersion, latestVersion, updateAvailable, message? }` |
| management.upgrade | `{ installedVersion, message? }`；输入含 version/expectedVersion，插件自行处理引擎恢复。 |
| modes.global.listModels | `{ status, source, scope, models, message? }`；状态和模型字段见 sdk/src/agents.ts。 |
| runtime.createSession | `{ run, dispose, checkpoint? }`；声明 resume=true 时必须实现 checkpoint。 |
| checkpoint | `{ schemaVersion: 正整数, data: Json }`，变更格式需要兼容或迁移说明。 |
| session.dispose | void/Promise<void>，释放引擎进程、监听、连接和缓存句柄。 |

## Agent 运行的事件与最终结果

`run(input, ctx)` 的 input 含本轮 input、历史 history（不含本轮）、instructions、options。
文本 `{type:'text',text}`，图片/文件 `{type:'image'|'file',assetId,name,mediaType}`。
宿主已有历史不要再次当作本轮输入重复提交。

标准事件：

```js
await ctx.events.emit({ type: 'text.delta', text: '你好' })
await ctx.events.emit({ type: 'reasoning.summary.delta', text: '正在检查输入' })
await ctx.events.emit({ type: 'status', phase: 'working', message: '读取文件' })
await ctx.events.emit({ type: 'tool.started', callId: 'call-1', name: 'read', input: { path: 'a.txt' } })
await ctx.events.emit({ type: 'tool.completed', callId: 'call-1', result: { text: '内容' } })
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
