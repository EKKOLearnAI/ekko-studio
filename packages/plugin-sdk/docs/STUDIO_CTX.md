# Studio SDK v1 上下文与能力

精确类型由 sdk/src/index.ts 统一导出，按 core/state/host/browser/sessions/bots/contexts/agents 组织源码。
逐字段含义、单位、必填/可空/默认与限制见 [FIELD_REFERENCE.md](FIELD_REFERENCE.md)，
宿主业务方法的输入和返回见 [HOST_API.md](HOST_API.md)。通用 Json 是开放业务数据，不代表没有业务约束。

| 上下文 | 元数据及能力 | 生命周期 |
| --- | --- | --- |
| PluginContext / apply | plugin、动态 identity、config、signal、paths.dataDir、host、extensions、state、events、scheduler、log、lifecycle | 插件启用到禁用/重载/卸载 |
| RunContext | identity、signal、config、permissions、features、host、state、session.get、workspace.read/write、tools.call、messages.notify/emit、lifecycle | RPC、命令、工具、钩子或动作本次调用，最长 120 秒 |
| ClientContext / mount | plugin、identity、locale、view/slot/location/data、signal、config、host、state、rpc.call、events.on、messages.on、ui、lifecycle | 当前 iframe 页面 |
| AgentManagementContext | identity.agentId、可选 mode、signal、log、lifecycle、progress | 单次管理调用，最长 120 秒 |
| AgentSessionContext | identity.agentId/sessionId、mode、paths、resumeState、signal、log、lifecycle | 原生 Agent 会话实例 |
| AgentRunContext | 普通 RunContext 加 paths/deadlineAt/log/lifecycle/output/mcpServers/interactions/attachments/mode/model；state.agentSession 必定存在 | 当前单轮运行，最长一小时，父任务可提前取消 |

身份来自宿主，不可信任浏览器传入的 userId/Profile。config 为插件全局配置，前端不可见 secret。
paths.dataDir 保存稳定插件私有文件；Agent paths.runtimeDir/workspaceDir 分别为原生会话运行目录和实际工作区。
权限不因 global/scoped 模式扩大；global 使用插件原生配置，scoped 使用宿主注入的短期模型代理，不暴露上游 key。
同一 Agent 会话实例串行运行，按 Agent、账号、Profile、会话和模式隔离。

## 宿主业务模块

| host 分组 | 方法 |
| --- | --- |
| models | list、respond（非流式 Responses JSON） |
| agents | list、status、models、settings |
| sessions | list/get/create/run/stop/remove/rename/archive/setModel/setWorkspace/messages；connect 实时会话 |
| bots | list/create/get/configure/clear/remove/connect；models/tasks/flows/schedules/memory/interactions，见下文 |
| groupChats | list/get/create/update/remove/send/stop/messages；agents.list/add/update/remove |
| workflows | list/get/create/update/remove/run/stop/runs/getRun；schedules.list/create/update/remove |
| files | list/read |
| browser | tabs.list/create/close；cdp.attach/send/events/release，见下文 |

host.request 仅接受相对 /api/ 路径及 JSON；GET 需要 api.read，其他请求需要 api.write，沿用真实调用者权限和固定 Profile。
账号、密钥、插件管理和原始桌面浏览器代理路径拒绝访问。普通业务结果保留 HTTP JSON 形状，不自动解包。
sessions.run 默认启动或入队后返回；wait:true 等待终态但仍受普通调用寿命约束。

## 扩展、消息和页面

extensions.agents/tools/commands/hooks/actions/rpc.register 注册插件提供给宿主的能力。
工具执行返回 ToolResult；commands 注册 /插件id:命令；hooks 只在 Ekko 支持 input.transform/context.transform/tool.before/tool.after。
Agent 注册返回带完整 id 和 dispose 的句柄，其他注册返回 disposer。
events.on 支持精确名称、前缀及 *，业务事件是有界内存观察流；离线恢复需查询历史并幂等处理。
messages.emit 默认发给当前调用者，audience=plugin 广播本插件所有账号/Profile 页面，前端通过 messages.on 接收。
messages.notify 给当前调用者提示；自定义消息不会回流后端 events 总线。
前端 rpc.call 调用本插件 extensions.rpc 注册的业务函数。
ui 提供 notify/confirm/prompt/navigate/selectModel；模型选择器返回规范模型引用或 null，不包含凭证，也不负责保存或调用模型。
页面包括 page/settings/workspace/agent-settings 和动态 workspace-sidebar，navigation.main/settings 独立声明入口。
iframe 不共享宿主 DOM、localStorage 或登录 token；使用宿主主题变量，不直接联网。

## SDK v1 规范入口

`ctx.host` 在前后端及调用上下文中使用相同业务分组：models、agents、sessions、bots、groupChats、workflows、files、browser。
宿主业务统一通过 host 分组调用。Agent 目录通过 host.agents.list/status/models/settings 访问，
注册自己的 Agent 则使用 extensions.agents.register。维护动作继续由宿主按原有管理员规则调度。
`permissions` 是实际 manifest 权限；普通 run.features 是运行环境支持项；AgentDefinition.features 是引擎声明。
后两者都不能作为授权判断。权限集合包含原十项及新增 `browser.cdp`。

`state.plugin` 是插件全局存储；user/profile/session 使用宿主绑定身份的独立命名空间。
不存在当前会话时 state.session 缺省。Agent 专用的 state.agentSession 按 Agent、账号、Profile、会话与模式分区。
Agent 不再覆盖默认存储。根 ctx.state 在回调内动态绑定真实身份；调用结束不能继续使用取出的存储句柄。
前端选择 plugin/user/profile/session 范围仍需要 storage.client；它表示允许访问插件全部数据，并非用户数据授权边界。

注册统一使用 extensions.agents/tools/commands/hooks/actions/rpc；每个注册返回清理句柄。
定时执行使用 scheduler.every；资源使用 lifecycle.add/acquire，按所在上下文寿命清理。
前端 events.on 订阅业务事件，messages.on 接收插件自定义页面消息；Agent output.emit 发布运行事件。

## 单聊实时会话

```js
const live = await ctx.host.sessions.connect(sessionId, event => {
  if (event.event === 'message.delta') appendText(event.delta)
  if (event.event === 'resumed') restoreSnapshot(event)
  if (event.event === 'run.completed') showFinalReply(event.output)
})
await live.run('你好')
// await live.queue.insert(queueId)
// await live.queue.cancel(queueId)
// await live.interactions.approve(approvalId, choice)
// await live.interactions.clarify(clarifyId, response)
// await live.stop()
await live.close()
```

connect 需要 api.read，控制指令需要 api.write；resume 只需 api.read。
listener 接收核心 `/chat-run` 协议中目标会话的原始事件字段，含 event/session_id。
包括 message.delta/interim、reasoning/thinking、tool/subagent、run/queue、approval/clarify、
usage、plan、compression、workspace、session 更新，以及 resumed 恢复快照。
transport.connected/disconnected/error/closed 描述连接状态。调用监听器应快速处理，不承担业务回执。
首次连接与重连自动请求 resume；插件按快照恢复显示，不应把快照重复拼接到已有增量。
断线期间的指令明确失败，不缓冲或自动重放。close 释放订阅，stop 才会停止宿主运行。
指令 Promise 表示分发完成；运行结果、失败、审批与终态由后续事件确认。
输入、options、事件和结果沿用 SDK JSON 限制；过大的事件会报告 transport.error，调用者可分页读取历史。
连接寿命绑定创建它的上下文：页面卸载、插件停用、调用取消均释放资源；普通 RPC 不适合承载长期订阅。

## BOT 完整模块

`host.bots.list/create/get/configure/clear/remove` 管理 BOT 角色及对话；create 输入沿用宿主 title、bot_type、
workspace、model 等字段，get 返回权威快照，configure 与 clear/remove 保留原有 revision 并发检查。
`host.bots.connect(botSessionId, listener)` 返回同样的实时句柄，可聊天、排队、回应审批并恢复快照。
BOT 变化通过 person.updated 事件通知，可重新 get 权威配置、任务、记忆和协作状态。

| BOT 子模块 | 方法 |
| --- | --- |
| models | list / agents / execution：模型及执行 Agent 目录 |
| tasks | list / apply：查询和变更任务；messages / send：任务对话；insert / remove：待执行输入队列；executions / events：执行历史与事件 |
| flows | list / apply / messages：BOT 协作及协作对话 |
| schedules | apply：查询、创建及控制原有定时计划 |
| memory | forget(id, expectedRevision)：遗忘指定记忆；记忆新增修订仍通过 BOT 对话 |
| interactions | answer(id, expectedRevision, answer)：回应 BOT 原有交互 |

这些 HTTP 方法保留现有服务的 JSON 请求/返回、action、revision、幂等键、工作区和归属校验。
其中 POST 查询也遵循 api.write 的现有方法授权规则；SDK 不代填 revision 或跳过业务确认。
模型直接调用 host.models.respond 仍是非流式 JSON；单聊实时会话通过现有引擎保留流式体验。

## 桌面内置浏览器 CDP

声明 `browser.cdp` 后，使用 `host.browser.tabs.list/create/close` 和 `host.browser.cdp.attach/send/events/release`。
该权限独立于 api.read/api.write；host.request 不能绕过浏览器模块访问浏览器代理接口。
仅使用当前账号/Profile 已授权共享、且仍绑定的桌面浏览器；无桌面或授权已撤销时明确失败。
不开放调试端口或 Studio 认证凭证，不创建另外的浏览器或浏览器 Profile。CDP 可以访问当前页面的调试及会话数据。

```js
const { tabs } = await ctx.host.browser.tabs.list()
const tab = tabs[0] || await ctx.host.browser.tabs.create('https://example.com')
const attached = await ctx.host.browser.cdp.attach(tab.id)
try {
  const result = await ctx.host.browser.cdp.send(tab.id, 'Runtime.evaluate', {
    expression: 'document.title', returnByValue: true
  })
  const batch = await ctx.host.browser.cdp.events(tab.id, attached.cursor)
} finally {
  await ctx.host.browser.cdp.release(tab.id)
}
```

CDP 面向指定标签页及 attach 返回的已知 iframe session；不是浏览器进程级 WebSocket。
支持 Page/Runtime/DOM/DOMDebugger/CSS/Network/Fetch/Input/Emulation/Accessibility/Performance/Profiler/HeapProfiler/Log/Security/Audits/Overlay/Animation/Debugger/IO 域。
Browser/Target 域由宿主管理，未知 frame session 拒绝。commands 保留 CDP JSON 结果，错误直接 reject。
events 是有界游标轮询，每批最多 64 条；保留 64 条，过期游标返回 dropped=true 和 oldestCursor。
单条事件超过 16000 字节时返回空 params 并标记 truncated=true。调用者自行启用需要的 CDP 域。
标签页控制沿用现有租约、串行队列和用户接管；release 释放控制，不拆卸宿主共用 debugger。
取消后不接收迟到结果，已发送到 Chromium 的命令可能已执行，禁止据此自动重放。
