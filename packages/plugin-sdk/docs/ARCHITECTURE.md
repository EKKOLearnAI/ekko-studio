# Studio 插件架构

本文是与项目内 SDK 一起分发的宿主架构说明。精确类型见 项目根目录下的 `sdk/src/index.ts`、`sdk/src/agents.ts`；
插件自己的结构见 `CONTRACTS.md`，业务设计补充在单独的项目文档中。
完整字段与边界见 `FIELD_REFERENCE.md`，宿主业务参数与返回包装见 `HOST_API.md`；这些指南均随项目分发。

## 包与加载

一个插件是独立的 npm/文件目录包，根目录的 `plugin.json` 是唯一插件清单，
`package.json` 负责包版本、依赖及构建命令。两者版本必须一致，当前 `apiVersion` 为 1。
至少声明 `server` 或 `client`。入口必须是编译后的 JavaScript；推荐 `.mjs`。
后端导出 `apply(ctx)`，前端导出 `mount(element, ctx)`，均可返回清理函数。
宿主不会提供任意服务端内部模块作为依赖。

```text
独立项目源码与 contracts/plugin.json
  → harness 校验文档与结构 → 可选 build → 安装到独立版本目录
  → PluginManager 激活 server.apply(ctx)
  → 注册 RPC / 工具 / 命令 / 事件 / 自动化 / Agent
  → Studio iframe 调用 client.mount(root, ctx)
  → 前端 ctx.rpc.call / ctx.host 通过认证桥进入后端
```

插件中心维护安装、启用、配置、回滚和卸载。插件全局安装一次，不按账号或 Profile 重复安装。
每次调用的账号、Profile、会话、运行信息由 Studio 绑定。禁止把激活者身份缓存给后续调用。
开发登记只保存源码路径；管理员启用开发链接后才执行构建及插件代码。
开发重载会释放旧实例、建立新运行目录并重新挂载页面，页面内存状态不会保留。
加载失败保留上一个可运行版本。插件数据不放在源码目录或安装版本目录中。

## 页面与桥接

`views` 声明页面布局，支持 `page`、`settings`、`workspace`、`agent-settings`；声明页面不会自动产生全局侧栏入口。
`navigation.main` 和 `navigation.settings` 分别显式声明主侧栏与设置侧栏入口，各项包含 `viewId`、必填 `icon`，以及可选 `title/order`。
两类入口可独立指向同一已声明页面；省略某个列表或设置为空数组，表示该侧栏不展示入口，页面和 Agent 设置按钮仍可用。
设置侧栏只接受宿主命名线条 icon；主侧栏还可使用包内 PNG/JPEG/WebP/GIF 或 base64 图片，均不得省略 icon 或依赖插件头像回退。
命名 icon 清单见 SDK 的 `PLUGIN_ICON_PATHS`。`workspace` 和 `agent-settings` 页面的专属配置侧栏也必须提供命名 `views[].icon`。
`agent-settings` 使用 `/studio/plugin-agent-settings/:pluginId/:viewId`，同类页面自动组成 Agent 设置导航，返回 Agent 管理；不会自动注册主侧栏或设置侧栏入口。
`workspace.sidebar` 是可选动态侧栏视图，仅用于 workspace。

页面布局由 views[].slot 声明，全局入口独立由 navigation 声明。Agent 设置回调必须指向 agent-settings 视图。
每个视图由同一个客户端入口按 `ctx.view / slot / location` 渲染。路由变化会重新挂载。
前端在不透明来源 iframe 内运行，不共享宿主 DOM、localStorage、登录 token。
前端 bundle 必须自包含，框架可打包，资源需内联；iframe 不允许直接网络连接。
宿主业务 API 使用 `ctx.host`，插件业务使用 `ctx.rpc.call`；不能通过相对模块或远程脚本加载额外客户端包。
`ctx.ui.selectModel()` 经页面桥接打开宿主现有的通用模型选择器；模型目录绑定该页面的 Profile，
凭证和供应商地址留在宿主，只回传选中的模型引用。插件自行决定保存和调用，页面结束时关闭选择器。

## 权限与数据

后端是可信 Node.js 代码，capability 约束 SDK 使用，不是操作系统沙箱。
只声明实际需要的能力；宿主业务 API 仍按真实调用者校验权限。
根 `ctx.state.plugin` 是插件全局存储，不会自动按用户或 Profile 分区。
使用 `run.identity` 决定 namespace；浏览器传来的 userId/profile 不可信。
Agent 的 `run.state.agentSession` 由宿主按 Agent、用户、Profile、会话和模式分区。
`ctx.paths.dataDir` 供插件原生引擎、缓存和配置文件使用，升级/卸载保留。

插件定时任务全局运行一次，使用激活管理员身份；更换 Profile 不会复制定时器。
业务事件是内存观察流，不保证离线补发和恰好一次。需要可靠恢复时查询历史并做幂等处理。

## Agent 运行时

清单声明 `agents`，后端调用 `ctx.extensions.agents.register(definition)`。
宿主生成 `plugin:<pluginId>/<agentId>`，接入单聊、群聊、工作流与 API。
`createSession(sessionCtx)` 创建实例；实例按插件运行版本、Agent、用户、Profile、会话及模式隔离，
同实例串行执行。`run(input, runCtx)` 输出事件并返回最终完整结果；`dispose()` 清理实例。

`global` 模式由插件维护原生模型目录及配置；`scoped` 模式使用宿主注入的模型代理和短期 token。
不要记录 token，运行结束后不能继续使用它。图片和文件是必需输入能力，使用 attachments 解析，不能静默丢弃。
宿主负责运行 ID、终态、消息持久化、审批界面及权限；插件负责引擎协议适配、进程和连接清理。

## SDK v1 模块规范

SDK v1 是插件模块首次上线采用的协议基线。manifest 使用 `apiVersion: 1` 和 `permissions`；
Agent 使用 `agentApiVersion: 1` 与 `features`。只实现这一份最新契约，不提供旧入口别名或旧字段转换。
包版本 `version` 标识插件发布版本；权限、功能声明和协议版本分别承担不同职责。

| 模块 | 唯一职责 |
| --- | --- |
| `host` | 调用宿主 models/agents/sessions/bots/groupChats/workflows/files/browser，request 是受限 JSON 逃生口 |
| `extensions` | 注册 agents/tools/commands/hooks/actions/rpc；不承担宿主目录查询 |
| `state` | 显式 plugin/user/profile/session/agentSession 数据作用域 |
| `events` | 订阅宿主业务事件；只观察，不修改原业务 |
| `messages` | 后端向插件页面发消息、前端订阅；不回流业务事件总线 |
| `output` | Agent 单轮流式文本、推理、状态和工具事件 |
| `scheduler` | 插件级定时执行；与 host.workflows.schedules 的工作流计划分开 |
| `ui` | 前端提示、确认、输入、导航、模型选择器 |
| `lifecycle` | add/acquire 统一登记同步与异步资源；signal 是上下文根部的取消元数据 |

源码按 core/state/host/browser/sessions/bots/contexts/agents 分文件，index.ts 只作为统一导出入口。
插件包管理和 Agent 引擎维护属于宿主管理面；注册 Agent 的插件实现自己的管理回调。
六种上下文分别是 PluginContext、RunContext、ClientContext、AgentManagementContext、AgentSessionContext、AgentRunContext。
身份、配置、路径和取消信号是上下文元数据；功能入口不得再放置同义的根级别名。

## 完整单聊与 BOT

`host.sessions.connect(sessionId, listener)` 开放核心单聊的完整会话通道，
包括流式文本、推理、工具、子任务、队列、审批、澄清、使用量和恢复快照。
后端适配宿主现有 `/chat-run` Socket 协议；前端由宿主管理 `/plugins` 桥接连接，
iframe 通过消息桥收发事件。插件不接收登录凭证或共享 Socket 对象。
会话查询、配置、历史等一次性操作继续复用 HTTP API；控制指令和实时事件复用同一聊天运行时。

`host.bots` 是独立宿主业务模块，统一 BOT 角色/对话、配置、模型、任务、协作、定时计划、
记忆和交互。`host.bots.connect` 使用相同实时会话句柄，目标必须是当前调用者有权访问的 BOT 对话。
BOT 业务与 `host.agents` 的执行引擎目录分别归属；创建 BOT 仍遵循宿主现有模型、工作区和版本检查。

读取和连接需要 `api.read`；运行、停止、队列和交互回应需要 `api.write`。
连接固定真实账号、Profile 和目标会话，每次控制和事件交付重新校验授权。
宿主处理断线重连并重新请求原会话快照，只恢复订阅，不重发运行或变更指令。
关闭句柄只释放它自己的资源；停止运行使用 `stop()`。插件结束、页面卸载和调用取消均关闭相应连接。

无效已安装清单保持失败状态，可从插件中心更新或卸载；缺失权限元数据不会使整个页面崩溃。
宿主不把旧字段转换为新契约，启用前必须通过当前清单校验。
