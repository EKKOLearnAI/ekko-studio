# Studio 插件架构

本文是与项目内 SDK 一起分发的宿主架构说明。精确类型见 项目根目录下的 `sdk/src/index.ts`、`sdk/src/agents.ts`；
插件自己的结构见 `CONTRACTS.md`，业务设计补充在单独的项目文档中。

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
  → 前端 ctx.rpc / ctx.api 通过认证桥进入后端
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

迁移：旧版 `views[].slot` 自动产生全局导航的行为已移除。保留旧 slot 可继续直接打开页面；需要侧栏入口的插件应补充 navigation 与 icon。
旧 `management.settings` 指向 settings 视图的行为仍兼容；新 Agent 建议使用 agent-settings 视图。
每个视图由同一个客户端入口按 `ctx.view / slot / location` 渲染。路由变化会重新挂载。
前端在不透明来源 iframe 内运行，不共享宿主 DOM、localStorage、登录 token。
前端 bundle 必须自包含，框架可打包，资源需内联；iframe 不允许直接网络连接。
宿主业务 API 使用 `ctx.api`，插件业务使用 `ctx.rpc`；不能通过相对模块或远程脚本加载额外客户端包。

## 权限与数据

后端是可信 Node.js 代码，capability 约束 SDK 使用，不是操作系统沙箱。
只声明实际需要的能力；宿主业务 API 仍按真实调用者校验权限。
根 `ctx.storage` 是插件全局存储，不会自动按用户或 Profile 分区。
使用 `run.identity` 决定 namespace；浏览器传来的 userId/profile 不可信。
Agent 的 `run.storage` 则由宿主按 Agent、用户、Profile、会话和模式分区。
`ctx.paths.dataDir` 供插件原生引擎、缓存和配置文件使用，升级/卸载保留。

插件定时任务全局运行一次，使用激活管理员身份；更换 Profile 不会复制定时器。
业务事件是内存观察流，不保证离线补发和恰好一次。需要可靠恢复时查询历史并做幂等处理。

## Agent 运行时

清单声明 `agents`，后端调用 `ctx.agents.register(definition)`。
宿主生成 `plugin:<pluginId>/<agentId>`，接入单聊、群聊、工作流与 API。
`createSession(sessionCtx)` 创建实例；实例按插件运行版本、Agent、用户、Profile、会话及模式隔离，
同实例串行执行。`run(input, runCtx)` 输出事件并返回最终完整结果；`dispose()` 清理实例。

`global` 模式由插件维护原生模型目录及配置；`scoped` 模式使用宿主注入的模型代理和短期 token。
不要记录 token，运行结束后不能继续使用它。图片和文件是必需输入能力，使用 attachments 解析，不能静默丢弃。
宿主负责运行 ID、终态、消息持久化、审批界面及权限；插件负责引擎协议适配、进程和连接清理。
