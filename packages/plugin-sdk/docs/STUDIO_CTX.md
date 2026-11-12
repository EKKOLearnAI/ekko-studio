# Studio ctx 能力与使用规则

精确方法签名、字段可选性、类型枚举见 项目根目录下的 `sdk/src/index.ts`、`sdk/src/agents.ts`。
本文解释各上下文的用途。返回要求见 `STUDIO_RETURNS.md`。

## 后端 PluginContext：apply(ctx)

| 成员 | 用途与边界 |
| --- | --- |
| `plugin` | 只读清单，包含 id、version、capabilities、views 等。 |
| `identity` | handler 内是当前调用者，激活及定时工作中是激活身份；不要跨调用缓存。 |
| `config` | 宿主校验后的全局配置，后端可读取 secret；不是用户私有设置。 |
| `signal` | 插件生命周期取消信号；禁用、重载、卸载时失效。 |
| `paths.dataDir` | 稳定的插件私有文件目录，独立于安装版本。 |
| `storage` | 全局 JSON 存储：namespace/get/set/delete/keys；get 缺失返回 undefined。 |
| `api` | 当前用户权限下的 Studio API，见下表；不返回宿主内部服务对象。 |
| `models` | 与 api.models 相同：list/respond，respond 是非流式 JSON 响应。 |
| `log.info/warn/error` | 结构化日志；管理页保留最近 200 条，不写密钥和完整凭证。 |
| `rpc.register(name, handler)` | 注册前端 RPC，handler(input, run) 返回 JSON；普通 RPC 不要求额外 capability。 |
| `tools.register(definition)` | 注册工具，需要 tools；定义 inputSchema、execute、readOnly。 |
| `commands.register(definition)` | 注册 /插件id:命令，需要 commands；参数是字符串。 |
| `on(pattern, handler)` | 观察业务事件，需要 events；精确名称、前缀及 *；不阻塞原运行。 |
| `hooks.register(name, handler, priority)` | Ekko 输入、上下文及工具拦截，需要 hooks；其他 Agent 不支持深度钩子。 |
| `automation.register/every` | 工作流动作和非重叠定时任务，需要 automation；定时器不补跑离线期间。 |
| `agents.register(definition)` | 注册 Agent 运行时，需要 agents，返回带 id/dispose 的注册句柄。 |
| `effect(acquire) / onDispose(dispose)` | 跟踪异步资源及清理；自己创建的连接、监听和进程必须登记。 |

除 agents 外，各注册方法返回 disposer。清理需幂等，禁止在已结束的上下文中再次调用宿主。

## 普通 RunContext：RPC、工具、命令、钩子与动作

| 成员 | 说明 |
| --- | --- |
| `identity` | userId/profile，以及可选 sessionId/runId/runtime/surface/workspace。 |
| `signal` | 本次调用取消信号，调用结束后失效；普通调用上限 120 秒。 |
| `capabilities / config` | 只读的能力列表和配置。 |
| `api / models / storage` | 绑定真实调用者；普通 run.storage 与根 ctx.storage 是同一插件存储。 |
| `session.get()` | 当前会话；页面调用没有默认会话时不能假定存在。 |
| `workspace.read/write()` | 当前会话工作区操作，受宿主权限约束。 |
| `tools.call('plugin/tool', input)` | 调用插件工具，返回 ToolResult。 |
| `ui.notify(message, level)` | 给当前调用者提示，level 为 info/error/success。 |
| `ui.emit(type, data, options)` | 向页面发事件，默认 audience=caller；plugin 会广播给本插件所有账号/Profile 页面。 |

## 前端 ClientContext：mount(root, ctx)

`plugin / identity / config / signal / api / models / storage` 与后端同名但经桥接限制；
config 不含 secret，storage 仅在清单声明 `storage.client` 时开放本插件全部存储。
用户私有数据优先通过后端 RPC 读取，不通过前端传入的身份决定 namespace。

| 成员 | 说明 |
| --- | --- |
| `locale` | 当前语言，可选；切换语言会重新挂载。 |
| `view / slot` | 当前声明的视图与入口类型，包括 workspace-sidebar。 |
| `location.path/query` | 当前插件路由和参数，参数不能用作可信身份。 |
| `data` | 宿主传入的 JSON 数据；未提供时为 null。 |
| `rpc(name, input?)` | 默认 input=null，Promise 返回插件后端的 JSON 值。 |
| `events.on(pattern, handler)` | 订阅允许接收的事件，返回取消订阅函数。 |
| `ui.notify/confirm/prompt/navigate` | 宿主提示、确认、文本输入和导航。confirm 返回 boolean，prompt 返回 string/null。 |
| `onDispose` | 注册清理；也可从 mount 返回 disposer。 |

## StudioApi

`ctx.api.request(path, options)` 仅接受相对 `/api/` 路径及 JSON；GET 需要 api.read，
写操作需要 api.write。账号、密钥、插件管理等敏感路径不开放。认证和 Profile 由宿主绑定。
返回值保留业务接口的 JSON 形状，不自动解包。具体资源字段以宿主当前接口文档为准，不能因 Promise<Json> 自行猜测。

| 分组 | 方法 |
| --- | --- |
| `models` | list、respond（非流式） |
| `studio.sessions` | list/get/create/run/stop/remove/rename/archive/setModel/setWorkspace/messages |
| `studio.groupChats` | list/get/create/update/remove/send/stop/messages；agents.list/add/update/remove |
| `studio.workflows` | list/get/create/update/remove/run/stop/runs/getRun；schedules.list/create/update/remove |
| `studio.files` | list/read |

## Agent 专用上下文

| 上下文 | 字段及用途 |
| --- | --- |
| `AgentManagementContext` | identity（含 agentId）、可选 mode、signal、log、resources.add、progress({message, percent?})。不绑定会话。 |
| `AgentSessionContext` | identity（含 agentId/sessionId）、mode、paths.runtimeDir/workspaceDir、可选 resumeState、signal、log、resources.add。 |
| `AgentRunContext` | 继承普通 RunContext；identity 增加 runId；增加 paths、deadlineAt、log、resources、events、mcpServers、interactions、attachments、mode/model。 |

`events.emit(event)` 返回 Promise，必须 await，提供背压。运行最长一小时，父任务可更早取消。
`resources.add(dispose)` 分别登记单轮或会话资源。`mcpServers` 是本轮受管 MCP 配置，凭证不得留到下一轮。
`interactions.approve` 只有 outcome=approved 才能继续；denied/cancelled/timeout 都不能当作批准。
`interactions.clarify` 返回 answered+text 或 dismissed/cancelled/timeout。
`attachments.resolve(assetId)` 返回元信息及 localPath；read 返回 Uint8Array，均校验访问权限。
scoped 的 model 包括 provider/model/apiMode/baseUrl/token/reasoningEffort/contextWindow/outputLimit；
global 的 model 只有可选原生 model/reasoningEffort。
