# Studio 插件与 ctx SDK

Studio 插件用于定制工作台页面、聊天扩展、Agent 工具、命令和自动化动作。
入口是导航栏的 **插件中心**，对应 `/studio/plugins`。它与 Hermes、DSH
各自的原生插件管理分开。插件安装、启用、配置和运行实例属于整个 Studio，所有账号、Profile 和任务均可使用，无需重复安装。

## 运行示例

仓库提供四个不需要构建的示例：

- `examples/plugins/session-dashboard`（会话看板）：纯前端页面，读取已有会话接口，展示统计、按 Agent 筛选、搜索已加载会话、分页和跳转。
- `examples/plugins/notebook`（工作便签）：页面、侧栏、Agent 工具、聊天命令、工作流共享持久化便签；支持完成状态和删除，显示记录来源。
- `examples/plugins/activity-digest`：订阅业务事件，定期生成摘要，也可以由命令或工作流触发。
- `examples/plugins/tool-demo`（工具注入演示）：仅注册一个只读 `hello` 工具。启用后，在 MCP 管理页的 `ekko-studio-plugins` 工具列表中查找 `tool-demo__hello`（描述为 `[工具注入演示/hello]`），参数为 `{"name":"Ekko"}`；工具返回问候语和实际调用的 Profile。

在插件中心点击“安装插件”，输入示例目录的绝对路径，确认信任、安装，再启用。配置位于“详情 → 配置”。
本地安装会复制目录；编辑源文件后使用“升级”重新安装。重载重新执行已安装的版本。
也可运行 `node scripts/create-plugin.mjs /absolute/path/my-plugin my-plugin` 创建完整示例。

### 两个可操作示例

开发环境打开 `http://localhost:8649/#/studio/plugins`，任意账号与 Profile 均可看到全局插件列表。安装与维护仍由超级管理员执行。
启用后，点击卡片的“打开”或导航栏的插件入口，进入独立页面：

1. **会话看板**：搜索标题、选择 Agent；点击会话返回原对话。总会话数来自接口，消息数和最近七天活跃数仅统计已加载会话。
2. **工作便签**：添加一条内容，勾选完成，再刷新页面验证仍然存在。删除会先弹确认框；数据跨账号和 Profile 共享，最多保留最近 100 条。
3. 在任意 Profile 的空闲聊天中发送 `/notebook:note 这是从聊天保存的便签`，回到插件页面即可看到来源为“聊天命令”的记录。
4. “详情 → 开发与维护”中选择 `append` 工具，输入 `{"text":"这是工具写入的便签"}` 并执行；结果会同步出现在插件独立页面。Agent 同样可以调用 `notebook/append`、`notebook/list`、`notebook/complete`。
5. 工作流节点选择插件动作 `notebook/capture`，将上游输出保存成便签；已有的工具列表可能需要刷新或新开一轮运行才能看到新插件。

这里的会话来自真实后端；便签从空白开始，不会自动创建示例数据或发起模型请求。

插件安装支持本地目录、`package@1.2.3` 或 `github:owner/repository#完整40位提交`。
远程安装禁止生命周期脚本，必须提供编译后的入口。版本必须是精确版本。
启停、配置、升级、回滚和卸载使用版本号防止同时修改。升级激活失败会恢复旧版本。
依赖使用 manifest 中的精确版本，启用前必须先启用依赖；禁用依赖前要禁用使用它的插件。
卸载释放运行资源，但保留数据与历史包目录，方便恢复；它不是清除磁盘数据操作。

## 插件中心与使用入口

插件中心使用卡片、名称/描述搜索、能力分类和状态筛选管理全局已安装插件，不是公共社区目录。安装与维护操作收进弹窗和详情抽屉；进入中心不会加载所有插件业务页面。

- `page`：独立路由 `/studio/plugins/:pluginId/:viewId`，可直接收藏、刷新。省略 `viewId` 打开第一个页面，多页面插件通过页内标签切换；启用后自动出现在导航栏。
- `sidebar`：聊天侧栏，保留当前会话上下文。
- `message`：助手消息下方，可访问当前消息数据。
- `settings`：插件详情的“配置”页签和 Studio 设置里的扩展区。

例如 `/#/studio/plugins/session-dashboard/sessions` 和 `/#/studio/plugins/notebook/notes`。独立页面使用完整内容区。切换 Profile 后插件列表与导航入口不变，页面重新绑定当前调用上下文。全局禁用或卸载会移除各账号的入口与挂载实例；不存在的页面显示返回中心的提示。`ctx.ui.navigate('/studio/plugins/notebook/notes')` 可跳到其他已声明页面，实际访问仍受目标插件状态约束。

### 全局安装与调用上下文

全局注册表位于 Web UI 状态目录的 `plugins/global/state.json`。一个插件只激活一个后端实例，依赖检查、配置、版本并发控制和启停均为全局；定时器不会因切换账号或 Profile 重复启动。插件自身定时任务使用最近激活它的管理员默认 Profile；迁移的旧任务保留原激活身份。该身份失去权限时相应后台 API 调用会被拒绝，不影响其他合法账号调用插件。

RPC、工具、聊天命令、钩子、业务事件和工作流始终使用实际调用者的账号、Profile、会话和任务上下文。宿主通过异步调用上下文绑定根 `ctx.identity / api / models / signal`，并发请求不会复用安装者权限。业务数据的共享与分区由插件开发者决定；宿主不按账号、Profile、会话或工作区自动划分插件存储。现有 Studio API 仍按实际调用者校验访问权限。

首次启动会自动合并旧的账号/Profile 注册表。同 ID 多份安装按最近安装时间选择，时间相同按原作用域路径稳定排序；选定版本的启用状态和配置一起保留，冲突来源记录在 `plugins/global/migration.json`。旧包、注册表与业务数据目录保留，不覆盖或混合不同账号的数据；迁移只执行一次，卸载后不会因重启再次导入。

## 包格式

`package.json` 中声明 `studioPlugin`：

```json
{
  "name": "my-studio-plugin",
  "version": "1.0.0",
  "type": "module",
  "studioPlugin": {
    "id": "my-plugin",
    "name": "My plugin",
    "version": "1.0.0",
    "apiVersion": 1,
    "server": "server.mjs",
    "client": "client.mjs",
    "capabilities": ["api.read", "api.write", "tools", "commands", "events", "hooks", "automation", "ui"],
    "views": [{ "id": "home", "title": "My page", "slot": "page" }]
  }
}
```

`server` 和 `client` 至少声明一个。使用 ES module `.mjs` 最直接；`.js`
需要包声明 `type: module`。客户端必须是一个自包含 bundle，资源内联为 data/blob URL，
React/Vue 等框架可一并打包。配置 JSON Schema 支持对象、数组、基础类型、必填、枚举、
默认值、数值和长度范围，以及 `secret`。不支持的关键字会报错，不会被静默忽略。
`secret` 字段不会传给客户端；空白配置输入保留已保存的密钥，后端仍可读取完整配置。

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
| `ctx.api.studio.sessions / workflows / files` | 常用接口的便捷入口 |
| `ctx.models.list / respond` | 已配置模型及 Responses API；返回完整响应，使用现有用量统计 |
| `ctx.storage` | 插件级全局 JSON 存储；`namespace(...)` 显式分区 |
| `ctx.tools.register` | 注册跨 Agent 工具；返回 `{ok, content, data?, error?}` |
| `ctx.commands.register` | 注册 `/插件id:命令 参数` 聊天命令 |
| `ctx.rpc.register` | 为前端注册后端函数 |
| `ctx.on(type, handler)` | 订阅现有 Studio 业务事件，`*` 订阅全部可见事件 |
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

工作便签示例选择全局共享；Activity Digest 示例自行按账号和 Profile 分区。旧版本存储原样保留在原目录，不会自动混入全局共享数据；插件作者应根据业务规则选择迁移哪些旧分区。新版数据位于 `plugins/global/data`，由插件 ID 和命名空间数组确定文件名。

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

前端还可使用 `ctx.storage`、`ctx.models`、`ctx.ui.notify/confirm/prompt/navigate`、
`ctx.events.on` 和 `ctx.onDispose`。视图类型有 `page`、`sidebar`、`message`、`settings`；
消息视图的 `ctx.data` 包含消息 ID、角色及文本，`ctx.identity.sessionId` 绑定当前会话。
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

验证命令：`npm test -- tests/server/studio-plugins.test.ts tests/server/studio-plugin-policy.test.ts tests/server/studio-plugin-mcp.test.ts`；
浏览器旅程：`npm run test:e2e -- tests/e2e/studio-plugins.spec.ts`。
