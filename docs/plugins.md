# Studio 插件与 ctx SDK

Studio 插件用于定制工作台页面、设置页面、独立工作区、Agent 工具、命令和自动化动作。
插件功能尚未开放，暂时隐藏导航栏的 **插件中心**、主侧栏插件页面及设置侧栏插件入口。
内部调试可直接访问 `/#/studio/plugins`，插件页面与工作区的直达路由仍保留。插件中心与 Hermes、DSH
各自的原生插件管理分开。插件安装、启用、配置和运行实例属于整个 Studio，所有账号、Profile 和任务均可使用，无需重复安装。

## 运行示例

仓库提供四个不需要构建的示例：

- `examples/plugins/session-dashboard`（会话看板）：纯前端页面，读取已有会话接口，展示统计、按 Agent 筛选、搜索已加载会话、分页和跳转。
- `examples/plugins/notebook`（工作便签）：独立工作区、动态便签侧栏、个人偏好设置页、Agent 工具、聊天命令、工作流共享持久化便签；支持完成状态和删除，显示记录来源。
- `examples/plugins/activity-digest`：订阅业务事件，定期生成摘要，也可以由命令或工作流触发。
- `examples/plugins/tool-demo`（工具注入演示）：仅注册一个只读 `hello` 工具。启用后，在 MCP 管理页的 `ekko-studio-plugins` 工具列表中查找 `tool-demo__hello`（描述为 `[工具注入演示/hello]`），参数为 `{"name":"Ekko"}`；工具返回问候语和实际调用的 Profile。

在插件中心点击“安装插件”，输入示例目录的绝对路径，确认信任、安装，再启用。配置位于“详情 → 配置”。
本地安装会复制目录；编辑源文件后使用“升级”重新安装。重载重新执行已安装的版本。
也可运行 `node scripts/create-plugin.mjs /absolute/path/my-plugin my-plugin` 创建完整示例。

### 两个可操作示例

开发环境打开 `http://localhost:8649/#/studio/plugins`，任意账号与 Profile 均可看到全局插件列表。安装与维护仍由超级管理员执行。
启用后，点击卡片的“打开”进入独立页面：

1. **会话看板**：搜索标题、选择 Agent；点击会话返回原对话。总会话数来自接口，消息数和最近七天活跃数仅统计已加载会话。
2. **工作便签**：添加一条内容，勾选完成，再刷新页面验证仍然存在。删除会先弹确认框；数据跨账号和 Profile 共享，最多保留最近 100 条。
3. 在任意 Profile 的空闲聊天中发送 `/notebook:note 这是从聊天保存的便签`，回到插件页面即可看到来源为“聊天命令”的记录。
4. “详情 → 开发与维护”中选择 `append` 工具，输入 `{"text":"这是工具写入的便签"}` 并执行；结果会同步出现在插件独立页面。Agent 同样可以调用 `notebook/append`、`notebook/list`、`notebook/complete`。
5. 工作流节点选择插件动作 `notebook/capture`，将上游输出保存成便签；已有的工具列表可能需要刷新或新开一轮运行才能看到新插件。
6. 工作区侧栏显示最近便签，点击后通过 URL 查询参数定位；刷新仍可恢复。通过插件详情的“配置”进入“便签偏好”，选择当前账号的默认筛选。

这里的会话来自真实后端；便签从空白开始，不会自动创建示例数据或发起模型请求。

插件安装支持本地目录、`package@1.2.3` 或 `github:owner/repository#完整40位提交`。
远程安装禁止生命周期脚本，必须提供编译后的入口。版本必须是精确版本。
启停、配置、升级、回滚和卸载使用版本号防止同时修改。升级激活失败会恢复旧版本。
依赖使用 manifest 中的精确版本，启用前必须先启用依赖；禁用依赖前要禁用使用它的插件。
卸载释放运行资源，但保留数据与历史包目录，方便恢复；它不是清除磁盘数据操作。

## 插件中心与使用入口

插件中心使用卡片、名称/描述/作者/标签搜索、能力分类和状态筛选管理全局已安装插件，不是公共社区目录。详情展示作者、许可证、仓库、主页、文档、问题反馈和更新记录。安装与维护操作收进弹窗和详情抽屉；进入中心不会加载所有插件业务页面。

以下为三类入口的声明规则。当前统一关闭对外导航显示，后续开放时通过 `PLUGIN_NAVIGATION_VISIBLE` 恢复；直接打开插件页面后，工作区自身的侧栏仍可使用。

- `page`：主侧栏入口，打开独立路由 `/studio/plugins/:pluginId/:viewId`。每个页面有自己的导航项。
- `settings`：设置侧栏入口，打开 `/studio/plugin-settings/:pluginId/:viewId`。插件中心的“配置”页保留宿主管理的 `configSchema` 表单，并链接到这些自定义页面。
- `workspace`：插件独立侧栏里的页面，路由同 `page`。主侧栏为一个插件展示一个工作区入口；进入后显示类似 Agent 配置区的专属侧栏，统一处理折叠、选中、拖宽、主题和移动端抽屉。

`views[].title/icon/order` 定义标题、图标和插件内排序（默认 `0`，同序保留声明顺序）。
`workspace.sidebar` 可指定一个不与页面 ID 重复的动态侧栏视图；宿主仍使用同一个客户端入口调用
`mount(root, ctx)`，其中 `ctx.slot === 'workspace-sidebar'`，`ctx.view` 为该 ID。
插件在这里通过 RPC 获取群列表、项目列表等内容。`ctx.location.path/query` 提供当前插件路由，
`ctx.ui.navigate()` 可切换页面或查询参数；路由变化会重新挂载视图，持久化状态应存于后端。

插件 UI 仅支持以上三类入口，不挂载到单聊 Session 列表、聊天侧边或消息下方。

例如 `/#/studio/plugins/session-dashboard/sessions` 和 `/#/studio/plugins/notebook/notes`。独立页面使用完整内容区。切换 Profile 后插件列表与导航入口不变，页面重新绑定当前调用上下文。全局禁用或卸载会移除各账号的入口与挂载实例；不存在的页面显示返回中心的提示。`ctx.ui.navigate('/studio/plugins/notebook/notes')` 可跳到其他已声明页面，实际访问仍受目标插件状态约束。

### 全局安装与调用上下文

全局注册表位于 Web UI 状态目录的 `plugins/global/state.json`。一个插件只激活一个后端实例，依赖检查、配置、版本并发控制和启停均为全局；定时器不会因切换账号或 Profile 重复启动。插件自身定时任务使用最近激活它的管理员默认 Profile。该身份失去权限时相应后台 API 调用会被拒绝，不影响其他合法账号调用插件。

RPC、工具、聊天命令、钩子、业务事件和工作流始终使用实际调用者的账号、Profile、会话和任务上下文。宿主通过异步调用上下文绑定根 `ctx.identity / api / models / signal`，并发请求不会复用安装者权限。业务数据的共享与分区由插件开发者决定；宿主不按账号、Profile、会话或工作区自动划分插件存储。现有 Studio API 仍按实际调用者校验访问权限。

## 包格式

每个插件必须在包根目录提供 `plugin.json`，它是唯一的插件清单来源。`package.json` 保留 npm 包信息和 npm 依赖，
插件版本必须与其中声明的包版本一致。缺少 `plugin.json` 时安装失败。

示例 `plugin.json`：

```json
{
  "id": "my-plugin",
  "name": "My plugin",
  "version": "1.0.0",
  "apiVersion": 1,
  "description": "A plugin with its own workspace",
  "author": { "name": "Example team", "url": "https://example.com" },
  "repository": "https://github.com/example/my-plugin",
  "homepage": "https://example.com",
  "documentation": "https://example.com/docs",
  "issues": "https://github.com/example/my-plugin/issues",
  "changelog": "https://github.com/example/my-plugin/releases",
  "license": "MIT",
  "keywords": ["collaboration"],
  "icon": "assets/icon.png",
  "server": "dist/server.mjs",
  "client": "dist/client.mjs",
  "capabilities": ["api.read", "api.write", "ui"],
  "views": [
    { "id": "overview", "title": "Overview", "slot": "page" },
    { "id": "rooms", "title": "Rooms", "slot": "workspace", "order": 1 },
    { "id": "history", "title": "History", "slot": "workspace", "order": 2 },
    { "id": "preferences", "title": "Preferences", "slot": "settings" }
  ],
  "workspace": { "sidebar": "room-list" }
}
```

`server` 和 `client` 至少声明一个。使用 ES module `.mjs` 最直接；`.js`
需要包声明 `type: module`。客户端必须是一个自包含 bundle，资源内联为 data/blob URL，
React/Vue 等框架可一并打包。配置 JSON Schema 支持对象、数组、基础类型、必填、枚举、
默认值、数值和长度范围，以及 `secret`。不支持的关键字会报错，不会被静默忽略。
`secret` 字段不会传给客户端；空白配置输入保留已保存的密钥，后端仍可读取完整配置。

作者和项目链接仅允许不含账号密码的 HTTP(S) 地址。图标允许包内相对路径的 PNG/JPEG/WebP/GIF
（每个文件不超过 256 KB）或相应的 base64 data URL；安装器读取并内联，拒绝越界路径和符号链接。
项目信息均可选。`apiVersion` 声明 SDK 兼容版本，当前只接受 `1`。

发布前由作者构建前后端，发布包需包含 `plugin.json`、`package.json` 和所有入口/资源。
npm/GitHub 安装在独立版本目录安装生产依赖，禁止安装脚本；本地目录安装只复制成品。
清单的 `dependencies` 表示其他 Studio 插件，`package.json.dependencies` 表示普通 npm 库。
原生依赖和系统工具需自行满足运行平台要求；宿主不会在安装时构建 Vue/React/TypeScript 源码。

TypeScript 契约位于 `packages/plugin-sdk/src/index.ts`；可将
`packages/plugin-sdk` 作为本地开发依赖安装。类型导入应使用 `import type`，
运行时辅助函数随自己的包打包。SDK v1 不需要插件导入 Studio 服务端实现。

## 后端 ctx

```js
export function apply(ctx) {
  ctx.tools.register({
    name: 'hello', description: 'Return a greeting', readOnly: true,
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    async execute({ name }, run) {
      return { ok: true, content: `Hello ${name} in ${run.identity.profile}` }
    }
  })
  return () => { /* 关闭自己创建的资源 */ }
}
```

| 入口 | 用途 |
| --- | --- |
| `ctx.plugin / identity / config / signal` | 全局包信息与配置、当前调用者身份与生命周期；启动时使用激活身份 |
| `ctx.api.request(path, options)` | 当前用户权限下调用现有 JSON 后端接口 |
| `ctx.api.studio.sessions / groupChats / workflows / files` | 单聊、群聊、工作流和文件操作 |
| `ctx.models.list / respond` | 已配置模型及 Responses API；返回完整响应，使用现有用量统计 |
| `ctx.storage` | 插件级全局 JSON 存储；`namespace(...)` 显式分区 |
| `ctx.tools.register` | 注册跨 Agent 工具；返回 `{ok, content, data?, error?}` |
| `ctx.commands.register` | 注册 `/插件id:命令 参数` 聊天命令 |
| `ctx.rpc.register` | 为前端注册后端函数 |
| `ctx.on(type, handler)` | 订阅 Studio 业务事件，支持精确名称、`chat.*`、`chat.run.*` 等前缀及 `*` |
| `ctx.hooks.register` | 注册 Ekko 输入、上下文与工具拦截钩子 |
| `ctx.automation.register / every` | 工作流可用动作、非重叠定时执行 |
| `ctx.effect / onDispose` | 追踪异步资源获取与清理 |
| `ctx.log` | 写入管理页可查看的最近 200 条插件日志 |

注册返回 disposer；宿主会在禁用、重载、升级、卸载或启动失败时自动清理。
定时任务由启用状态恢复，重启后从当前时间重新计时，不补跑离线期间的任务。
插件自己创建的监听、连接和定时器必须通过 `effect` 或 `onDispose` 管理。

工具、命令、RPC、钩子和动作收到独立的 `run` context。它带有本次会话、工作区、
运行标识及取消信号，操作最长 120 秒；结束后 context 失效。不要缓存后继续调用。
`ctx.storage` 与 `run.storage` 访问同一份插件级存储。根上下文的身份与 API 在每次调用中自动绑定实际调用者，异步代码也保持此绑定。
`run.session.get()` 读取当前会话；`run.workspace.read/write()` 使用会话工作区接口；
`run.tools.call('插件id/工具名', args)` 调用插件工具；`run.ui.notify/emit` 向页面发事件。
共享记录的 read-modify-write 需要插件串行处理，Notebook 示例展示了这一点。

### 数据范围由插件决定

```js
// 同一插件的所有账号、Profile、任务共享。
await ctx.storage.set('announcements', [])

// 以下是开发者主动选择的分区，可以任意组合或使用项目、团队等业务维度。
const user = run.storage.namespace('users', String(run.identity.userId))
const profile = user.namespace('profiles', run.identity.profile)
await profile.set('preferences', { compact: true })
```

命名空间可累计，最多 16 段，每段 1–256 个字符；段边界保留，不能利用路径字符访问其他插件。每个命名空间都支持 `get/set/delete/keys`。插件之间使用独立存储，命名空间本身是数据组织方式，不是访问控制。

前端直读存储需要开发者在 manifest 声明 `storage.client`，该能力开放本插件的全部存储及命名空间。无需直读时不声明，通过 RPC 暴露业务操作，例如由后端根据可信 `run.identity` 选定私有分区；不要使用浏览器传入的账号 ID 决定私有数据归属。`ctx.config` 是全局配置，不应放用户私有偏好。

```js
// 不声明 storage.client：客户端只能调用开发者定义的操作。
ctx.rpc.register('preferences', async (_input, run) => {
  return await run.storage.namespace('users', String(run.identity.userId)).get('preferences') ?? {}
})
```

插件发出的 `run.ui.emit(type, data)` 默认发给当前账号/Profile 下匹配会话的页面；共享业务可以显式广播：

```js
run.ui.emit('notebook.updated', { id: note.id }, { audience: 'plugin' })
```

`audience: 'plugin'` 让所有账号/Profile/会话中的本插件页面收到事件，数据及事件中的调用身份都会对它们可见。`run.ui.notify` 仍是调用者提示；已有 Studio 业务事件按宿主原有权限分发。

工作便签示例选择全局共享；Activity Digest 示例自行按账号和 Profile 分区。数据位于 `plugins/global/data`，由插件 ID 和命名空间数组确定文件名。

## 前端 ctx 与现有后端 API

```js
export async function mount(element, ctx) {
  const result = await ctx.api.studio.sessions.list()
  element.textContent = JSON.stringify(result)
  const unsubscribe = ctx.events.on('notebook.updated', event => {
    element.textContent = JSON.stringify(event.data)
  })
  return unsubscribe
}
```

前端可以调用已有后端接口，无需复制一套业务接口：

```js
const result = await ctx.api.request('/api/studio/sessions', { query: { limit: 20 } })
await ctx.rpc('append', { text: 'A note' })
```

宿主提供认证和 Profile 绑定，插件拿不到 token。普通请求限相对 `/api/` 路径和 JSON，
并沿用各接口原有的权限校验；不能通过此入口管理账号、密钥或插件，也不能切换 Profile。
`api.read` 授予 GET，`api.write` 授予写操作。SDK 不把原始数据库、路由器、密钥仓库注入前端。
模型 `respond` 使用非流式响应；底层二进制下载和 SSE 不属于此 JSON API 入口。

### 会话、群聊与工作流操作

前后端使用同一份 `ctx.api.studio` SDK；写操作需要 `api.write`，读操作需要 `api.read`。
返回值保留对应 HTTP 接口的 JSON 结构，不自动解包。

| 命名空间 | 方法 |
| --- | --- |
| `sessions` | `list(query?)`、`get(id)`、`create({title?,agent?,mode?})`、`run(id,input,options?)`、`stop(id)`、`remove(id)`、`rename(id,title)`、`archive(id,archived?)`、`setModel(id,model)`、`setWorkspace(id,path)`、`messages(id,query?)` |
| `groupChats` | `list()`、`get(id)`、`create({name,inviteCode,...})`、`update(id,config)`、`remove(id)`、`send(id,content,mentions?)`、`stop(id,agentName)`、`messages(id,query?)` |
| `groupChats.agents` | `list(roomId)`、`add(roomId,config)`、`update(roomId,agentId,config)`、`remove(roomId,agentId)` |
| `workflows` | `list()`、`get(id)`、`create({name,nodes?,edges?,...})`、`update(id,definition)`、`remove(id)`、`run(id,input?)`、`stop(id,runId)`、`runs(id)`、`getRun(id,runId)` |
| `workflows.schedules` | `list(workflowId)`、`create(workflowId,config)`、`update(workflowId,scheduleId,config)`、`remove(workflowId,scheduleId)` |

```js
// 创建空会话不会发起模型调用；默认 Agent 为 ekko-agent。
const { session } = await ctx.api.studio.sessions.create({ title: '每日摘要' })
const accepted = await ctx.api.studio.sessions.run(session.id, '整理今日进展', {
  provider: 'custom:my-provider', model: 'my-model', apiMode: 'chat_completions'
})
// accepted.status 为 running 或 queued；后续通过事件或会话历史获取结果。
await ctx.api.studio.sessions.stop(session.id)

const { room } = await ctx.api.studio.groupChats.create({ name: '写作组', inviteCode: 'writing-team' })
await ctx.api.studio.groupChats.send(room.id, '请开始整理')
// 按群内 Agent 名称中断，沿用群聊界面的中断权限。
await ctx.api.studio.groupChats.stop(room.id, 'Writer')

const { workflow } = await ctx.api.studio.workflows.create({ name: '每日整理', nodes: [], edges: [] })
// 配好节点与边后调用 run；运行记录可用 runs/getRun 查询，stop 需要该次 runId。
```

`sessions.run` 默认在启动或入队后返回；传 `wait:true` 可等待终态，仍受插件调用的 120 秒生命周期约束。
Ekko/Coding Agent 首次运行需提供完整的 `provider/model/apiMode`；后续可沿用会话保存的模型配置。
`sessions.stop` 返回 `{ok,session_id,stopped}`，只中断当前运行，保留会话和历史，队列行为与聊天界面的停止一致。
群聊消息接口复用认证后的 Socket 操作，不接受伪造的发送者；停止指定 Agent 不删除房间。
群聊历史支持 `limit/offset` 或 `before` 消息游标。配置及工作流节点、定时字段沿用 OpenAPI 定义。

### 可订阅事件

后端使用 `ctx.on(pattern, (event, run) => ...)`，前端使用 `ctx.events.on(pattern, event => ...)`。
两者均支持 `*` 和以 `.*` 结尾的前缀匹配；同一函数匹配多个订阅时只执行一次。
全部内置事件名导出为 SDK 的 `PLUGIN_EVENT_TYPES`，也可继续订阅插件自定义的前端事件。

| 范围 | 事件 |
| --- | --- |
| 单聊 | `chat.session.created/removed`、`chat.message.created/delta`、`chat.reasoning.delta` |
| 单聊运行 | `chat.run.queued/started/updated/completed/failed/stopped` |
| 工具与任务 | `chat.tool.started/completed/failed`、`chat.task.created/completed`、`chat.plan.updated` |
| 群聊 | `group.message.created/started/delta/completed`、`group.reasoning.delta`、`group.run.updated/failed/stopped`、`group.plan.updated` |
| 工作流 | `workflow.run.started/updated/completed/failed/stopped`、`workflow.plan.updated`；节点共享运行事件仍使用 `chat.*`，通过 `source` 和 `subject.workflow_id` 区分 |
| 审批与澄清 | `chat.approval.requested/resolved`、`chat.clarification.requested/resolved`，群聊对应 `group.*` |
| Person | 保留原有 `person.run.completed/failed/updated` 和审批、澄清事件；不公开私有工作会话、工具细节和文本流 |

```js
ctx.on('chat.run.*', async (event, run) => {
  const { subject, summary, state } = event.data
  run.ui.emit('dashboard.run', { type: event.type, subject, summary: summary ?? null, state: state ?? null })
})
ctx.on('group.message.delta', event => {
  ctx.log.info(`${event.data.subject.room_id}: ${event.data.delta}`)
})
```

事件有 `id/type/timestamp/identity/data`；`data.subject` 保存会话、运行、群聊、工作流等标识。
文本增量位于 `data.delta`，生命周期摘要位于 `data.summary`，运行快照位于 `data.state`；字段随事件类型变化。
消息/完成文本使用规范化且可能截断的 `data.content`，需要完整记录时读取历史。
`chat.session.created` 当前指通过空会话创建接口创建的会话；群聊 `message.completed` 指流片段结束，最终持久化消息另发 `message.created`。

插件事件不再受 App 通知展示条件过滤。普通会话按 Profile 访问权限分发，群聊还校验成员或房间访问权限；
审批、Person 和工作流保留原有所有者限制。事件身份来自当前接收用户，不借用安装者权限。
群聊向接收者有权使用的 Profile 上下文分发，不要求成员拥有群摘要模型的 Profile；
`data.profile` 仍标识事件来源。同一业务事件可能按多个用户/Profile 分发，跨上下文自动化应按事件 ID 去重。
事件是内存中的实时观察，前端轮询仅保留最近 500 条，不保证离线补发、严格顺序或恰好一次；
高频流可覆盖较早事件，插件应按事件 ID 去重并用历史接口恢复状态。观察回调不阻塞原始运行；
需要拦截时使用 `ctx.hooks`。自定义 `ui.emit` 发给前端，不重新进入后端 `ctx.on`。

前端还可使用 `ctx.storage`、`ctx.models`、`ctx.ui.notify/confirm/prompt/navigate`、
`ctx.events.on` 和 `ctx.onDispose`。入口类型为 `page`、`settings`、`workspace`；
动态工作区侧栏挂载时的 `ctx.slot` 为 `workspace-sidebar`。这些页面不绑定当前单聊会话，
需要访问会话时由插件通过 SDK 显式指定 ID，宿主照常检查当前调用者权限。
页面挂在独立 iframe 中，复用宿主主题变量，通过消息桥调用功能。iframe 不共享 DOM、
localStorage 或登录凭证；HTTP 请求统一通过 `ctx.api`。

## Agent 与工作流

启用的工具自动出现在独立的 `ekko-studio-plugins` MCP 服务中，由 `ekko-studio-mcp plugins` 启动；`ekko-studio-api` 只保留接口文档和接口调用工具。工具名使用 `插件ID__工具名`，例如 `notebook__append`、`tool-demo__hello`，并附带插件描述。为兼容各 Agent，标识符中的下划线和点分别转义为 `_u`、`_d`；名称超过 64 个字符时保留两端可读前缀并附加稳定的防重名后缀。
适用于启用了该 MCP server 的 Hermes、Ekko 和已接入 Studio MCP 的 Coding Agent。升级后刷新 MCP 管理页，已有 Agent 连接需重新连接或新开一轮运行，以加载独立服务和新工具名。外部运行时可能缓存工具目录，
安装/启用后刷新 MCP 或开始新一轮运行；禁用后即使目录缓存仍在，调用也会被拒绝。

`input.transform` 接收本轮输入消息，`context.transform` 接收每次模型调用的消息副本，
`tool.before` 接收 `{name,input}`，`tool.after` 接收 `{name,input,result}`。
返回 `{value}` 修改内容，或 `{deny: 'reason'}` 阻止操作。同一插件按 priority 升序，
插件间按 ID 排序。工具名不可替换，修改参数后仍经过正常授权。失败或被拒绝的工具
不会进入 `tool.after`。这些深度钩子仅支持 Ekko；其他 Agent 提供共享工具与业务事件，
不会伪装为具有模型内部控制能力。Pi/DSH 原生插件不是无需修改就兼容此 SDK。

工作流节点可选择插件动作，填写 JSON 参数。动作 schema 声明 `input` 且参数未提供它时，
宿主填入节点任务及上游输出。节点复用现有审批、分支、循环、状态、重试和取消机制，
结果保存到节点会话。调度工作流使用调度创建者身份；没有有效用户身份的任务不能调用插件。
外部系统可通过已认证的 `POST /api/studio/plugins/:id/invoke` 调用动作。

## 运行与权限边界

只有超级管理员的交互登录可以安装和修改可执行插件。Agent 运行凭证不能安装插件。
后端插件是可信 Node.js 代码，拥有 Studio 进程的操作系统权限；manifest capability
约束 SDK 使用，不是 Node.js 沙箱。只安装可信包。前端 iframe 有独立的浏览器隔离。
宿主状态保存在 Studio 应用目录下的 `plugins/`，不写入 Hermes Agent 状态目录。

验证命令：`npx vitest run tests/server/studio-plugins.test.ts tests/server/studio-plugin-*.test.ts tests/ekko-agent/plugin-hooks.test.ts`；
浏览器旅程：`npm run test:e2e -- tests/e2e/studio-plugins.spec.ts tests/e2e/studio-plugin-navigation.spec.ts`。
