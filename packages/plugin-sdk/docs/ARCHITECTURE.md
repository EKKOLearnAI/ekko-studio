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
host.browser 在本地和远程 Desktop 使用同一条由主窗口登录身份建立的连接，沿用相同的页面登录状态。
Desktop 仅允许当前 Studio 主文档持有浏览器连接能力，插件不会接收本机 Broker 凭据。
开发登记只保存源码路径；管理员启用开发链接后才执行构建及插件代码。
开发重载会释放旧实例、建立新运行目录并重新挂载页面，页面内存状态不会保留。
加载失败保留上一个可运行版本。插件数据不放在源码目录或安装版本目录中。

## 页面与桥接

`views` 声明页面布局，支持 `page`、`settings`、`workspace`、`agent-settings`；声明页面不会自动产生全局侧栏入口。
`navigation.main` 和 `navigation.settings` 分别显式声明主侧栏与设置侧栏入口，各项包含 `viewId`、必填 `icon`，以及可选 `title/order`。
`navigation.main` 仅注册可选入口，不会在安装、启用或升级时自动显示到外层导航栏。
用户从头像菜单打开「导航栏设置」后，手动添加已启用插件的已注册入口；仅有 `views`、工具、Agent 设置页或 `workspace.sidebar` 不会进入候选列表。
选择和顺序按 Studio 登录账号保存，独立于 Profile。插件停用、失败或移除注册后入口暂时隐藏，原选择保留；恢复可用后按用户原有顺序显示。`navigation.settings` 保持原有设置侧栏行为。
两类入口可独立指向同一已声明页面；省略某个列表或设置为空数组，表示该侧栏不展示入口，页面和 Agent 设置按钮仍可用。
主侧栏与设置侧栏都接受宿主命名线条 icon、包内 PNG/JPEG/WebP/GIF 或 base64 图片，均不得省略 icon 或依赖插件头像回退。
命名 icon 清单见 SDK 的 `PLUGIN_ICON_PATHS`。`workspace` 和 `agent-settings` 页面的专属配置侧栏也必须提供命名 `views[].icon`。
`agent-settings` 使用 `/studio/plugin-agent-settings/:pluginId/:viewId`，同类页面自动组成 Agent 设置导航，返回 Agent 管理；不会自动注册主侧栏或设置侧栏入口。
`workspace.sidebar` 是可选动态侧栏视图，仅用于 workspace。

页面布局由 views[].slot 声明，全局入口独立由 navigation 声明。Agent 设置回调必须指向 agent-settings 视图。
每个视图由同一个客户端入口按 `ctx.view / slot / location` 渲染。路由变化会重新挂载。
前端在同源、无 sandbox 属性的 iframe 内运行，按可信插件代码执行，可访问宿主 DOM 和浏览器存储。
插件使用独立的 `plugin-frame.html` 文档，不继承宿主页 CSP；该文档只限制被同源页面嵌入，不限制脚本、网络连接或资源来源。
宿主为该文档提供与常规页面共用的细滚动条和透明轨道，颜色及滑块圆角随宿主主题更新，保留文档、内部容器和表单控件所需的滚动。
插件页面外层复用 Studio 普通页面的留白、圆角和区域主题；iframe 本身不叠加卡片边框、圆角、阴影或根节点内边距，填满外层容器的可用区域。顶部导航、管理入口及必要侧栏仍由宿主提供。
插件自行决定内容布局和留白，可用视口单位填满窗口，并自行设置内部滚动区域；默认主题变量继承所在内容或侧栏区域。
主题桥同时提供字体、字号、间距及 card/input/overlay 区域的颜色、边框、圆角、阴影和滤镜变量，重置主题后移除旧覆盖。
插件需自行消费这些变量，按区域绘制一次半透明背景；iframe 内的 backdrop-filter 只能采样本 iframe 的内容，不能采样宿主壁纸。
插件自己的 CSS 仍可覆盖默认样式；嵌套的独立 iframe 文档不继承这些规则，需要由其内容方适配，宿主不会跨来源访问或修改它们。
前端入口仍由宿主获取后作为 Blob 模块挂载；可打包框架，也可从外部 URL 加载模块、样式、字体和媒体，或直接使用 fetch、XHR、WebSocket。
Blob 入口中的相对模块地址不能自动指向插件包目录，使用完整 URL 或打包进客户端入口。
宿主业务 API 使用 `ctx.host`，插件业务使用 `ctx.rpc.call`；这些桥接调用继续检查 manifest 权限、真实用户和 Profile，不主动向 SDK 上下文注入登录凭证。
直接网络访问仍遵循浏览器的 CORS、混合内容、安全上下文和目标服务器策略。

插件音视频可使用远程 URL、内联 `data:` 或当前 iframe 中创建的 `blob:` URL；宿主不再施加媒体来源白名单或禁止直接 fetch。
包内相对资源不会自动作为插件静态文件发布，本地文件和远程媒体仍受浏览器及目标站点策略约束。
后端资源也可经 RPC/API 交付；当前桥接是有大小限制的 JSON 通道，不是二进制流式媒体代理。
普通媒体播放不需要额外 manifest 权限；录音仍取决于浏览器和系统授权。
插件应提供真实点击的播放/启用声音操作，处理 `audio.play()` 的拒绝和 `AudioContext` 的 suspended 状态，
并在 disposer 中暂停媒体、关闭音频上下文、撤销自己创建的 Blob URL。
宿主不承诺自动播放，也不默认委派 autoplay；浏览器/WebView 的手势策略和 Electron 默认行为可能不同。

需要静音内联自动播放时，插件在设置 src 之前配置 muted、autoplay 和 playsInline，
仍要处理 play() 拒绝并保留点击播放入口；有声自动播放不受宿主保证。静音音轨仍是音轨，
仅把录制内容变成静音不等于设置 video.muted。真实 Safari/WKWebView 还受站点设置、可见性和容器配置影响。
`allow="autoplay"` 不会自动满足浏览器的用户激活要求。

```js
// bytes 可来自内联资源、RPC 或通过 CORS 允许的远程 fetch。
const video = document.createElement('video')
video.controls = true
video.muted = true
video.autoplay = true
video.playsInline = true
const url = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }))
video.src = url
root.append(video)
void video.play().catch(() => { /* 保留原生控件，让用户点击播放。 */ })
ctx.lifecycle.add(() => {
  video.pause()
  video.removeAttribute('src')
  video.load()
  URL.revokeObjectURL(url)
})
```

需要声音时由原生控件或真实点击回调取消静音并调用 play()；程序自行取消静音可能使播放被暂停。
可直接加载网络 MP4、HLS/DASH 分片或外站播放器 iframe；实际可用性仍取决于编解码支持、CORS、目标站点嵌入策略和浏览器播放策略。

Studio 插件页面可在普通 HTTP 下加载：宿主通道标识使用加密随机数，不依赖仅安全上下文提供的
`crypto.randomUUID()`。HTTP localhost 与 HTTPS 通常属于安全上下文，普通局域网 HTTP 不属于；
页面能打开不代表录音等需要安全上下文的 API 可用，具体能力仍取决于浏览器、系统权限与部署策略。

`ctx.ui.selectModel()` 经页面桥接打开宿主现有的通用模型选择器；模型目录绑定该页面的 Profile，
凭证和供应商地址留在宿主，只回传选中的模型引用。插件自行决定保存和调用，页面结束时关闭选择器。
`ctx.ui.selectWorkspace({ current })` 同样通过桥接打开宿主目录选择器，复用目录树、手动路径、账号收藏和最近记录。
确认只返回 `{ profile, workspace }`，取消返回 null；不自动绑定会话或修改插件配置。收藏是用户显式操作，
最近记录只在确认后更新。Profile/路由变化或页面销毁会关闭选择器，旧页面不能将结果交给新页面。

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
| `extensions` | 注册 agents/tools/commands/hooks/actions/rpc/http；不承担宿主目录查询 |
| `state` | 显式 plugin/user/profile/session/agentSession 数据作用域 |
| `events` | 订阅宿主业务事件；只观察，不修改原业务 |
| `messages` | 后端向插件页面发消息、前端订阅；不回流业务事件总线 |
| `output` | Agent 单轮流式文本、推理、状态和工具事件 |
| `scheduler` | 插件级定时执行；与 host.workflows.schedules 的工作流计划分开 |
| `ui` | 前端提示、确认、输入、导航、模型选择器 |
| `lifecycle` | add/acquire 统一登记同步与异步资源；signal 是上下文根部的取消元数据 |

源码按 core/state/host/browser/sessions/bots/contexts/agents/http 分文件，index.ts 只作为统一导出入口。
插件包管理和 Agent 引擎维护属于宿主管理面；注册 Agent 的插件实现自己的管理回调。
六种上下文分别是 PluginContext、RunContext、ClientContext、AgentManagementContext、AgentSessionContext、AgentRunContext。
身份、配置、路径和取消信号是上下文元数据；功能入口不得再放置同义的根级别名。

## 后端 HTTP 拦截

清单声明独立 `http` 权限，通过 `extensions.http.register` 注册服务端入站请求和响应拦截器。
中间件位于通用请求体解析之后、公开与鉴权路由之前；覆盖经过该位置的 API 和静态页面请求。
请求回调升序执行，响应回调按已进入的拦截器逆序执行；同优先级按插件 ID、注册名称排序。
请求回调可以修改路由输入，也可以直接返回完整响应。禁用、重载、卸载释放注册并取消未结束的回调。
这是可信后端插件的全局 HTTP 权限，可接触尚未鉴权的请求及凭证头，不能当作用户级数据授权。
鉴权前的回调没有调用者身份，闭包中的 `ctx.host/state/identity` 也不会继承激活管理员；
鉴权后使用实际请求账号与 Profile。SDK 的内部 HTTP 传输保留原有鉴权并跳过再次拦截，避免递归。
HTTP body 为进程内 Koa 数据，可保留 Buffer 和流，不经过前端 JSON 桥；详细契约见能力与返回指南。
统一模型网关复用同一入口，包括内部模型凭据、Coding Agent 专用凭据与分享 API key，
不在协议适配器或出站 Provider 传输层重复注册 HTTP 钩子。请求改写先于鉴权和协议转换，
响应回调后于网关处理、先于 Koa 发送；SSE 通过 Readable/Transform 保持流式传输。
专用凭据的响应身份来自绑定账号/Profile，目录路由的推理响应身份来自实际选中的账号/Profile。

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

## 插件名称、描述与入口国际化

保留 `name`、`description`、`views[].title` 和可选导航 `title` 的字符串作为旧宿主与旧插件兼容值。
新版 SDK 项目必须覆盖 `PLUGIN_LOCALES` 中 Studio 支持的全部语言，逐种提供 `name`、`description`，并用 `views: {viewId: title}` 翻译每个页面。
独立声明了导航 title 时，还须提供 `navigation: {main?: {viewId: title}, settings?: {viewId: title}}`；省略导航 title 时沿用本语言的页面标题。
其他语言可按 BCP 47 代码增加，显示按完整语言代码、基础语言、英文、原字符串依次回退。安装目录、插件 ID、视图 ID、数据与权限不随语言变化。
Studio 的插件中心、详情、页面标题与两类侧栏统一使用这些翻译；插件内容仍须根据 `ctx.locale` 自行国际化，切换语言会重新挂载。
没有 i18n 或只覆盖旧语言集的已发布插件仍可安装、启用和更新，原名称、描述、图标与入口保持可用。升级 SDK 时一起补齐翻译；新版项目的 harness:check/prepack 检查为必需项。

```json
{
  "name": "Version Preview",
  "description": "Preview Studio versions with isolated source, data and services.",
  "i18n": {
    "en": {
      "name": "Version Preview",
      "description": "Preview Studio versions with isolated source, data and services.",
      "views": {
        "preview": "Version Preview"
      }
    },
    "zh": {
      "name": "版本预览",
      "description": "独立预览 Studio 版本，自动管理源码、数据目录与运行服务。",
      "views": {
        "preview": "版本预览"
      }
    },
    "zh-TW": {
      "name": "版本預覽",
      "description": "獨立預覽 Studio 版本，自動管理原始碼、資料目錄與執行服務。",
      "views": {
        "preview": "版本預覽"
      }
    },
    "ja": {
      "name": "バージョンプレビュー",
      "description": "ソースコード、データ、サービスを分離して Studio の各バージョンをプレビューします。",
      "views": {
        "preview": "バージョンプレビュー"
      }
    },
    "ko": {
      "name": "버전 미리보기",
      "description": "소스 코드, 데이터 및 서비스를 격리해 Studio 버전을 미리 봅니다.",
      "views": {
        "preview": "버전 미리보기"
      }
    },
    "fr": {
      "name": "Aperçu de version",
      "description": "Prévisualisez les versions de Studio avec du code source, des données et des services isolés.",
      "views": {
        "preview": "Aperçu de version"
      }
    },
    "es": {
      "name": "Vista previa de versión",
      "description": "Previsualiza versiones de Studio con código, datos y servicios aislados.",
      "views": {
        "preview": "Vista previa de versión"
      }
    },
    "de": {
      "name": "Versionsvorschau",
      "description": "Studio-Versionen mit getrenntem Quellcode, eigenen Daten und Diensten in der Vorschau ausführen.",
      "views": {
        "preview": "Versionsvorschau"
      }
    },
    "pt": {
      "name": "Prévia de versão",
      "description": "Visualize versões do Studio com código-fonte, dados e serviços isolados.",
      "views": {
        "preview": "Prévia de versão"
      }
    },
    "ru": {
      "name": "Предпросмотр версий",
      "description": "Предварительный просмотр версий Studio с изолированными исходным кодом, данными и службами.",
      "views": {
        "preview": "Предпросмотр версий"
      }
    },
    "ar": {
      "name": "معاينة الإصدار",
      "description": "عاين إصدارات Studio باستخدام شيفرة مصدرية وبيانات وخدمات معزولة.",
      "views": {
        "preview": "معاينة الإصدار"
      }
    },
    "tr": {
      "name": "Sürüm önizlemesi",
      "description": "Studio sürümlerini yalıtılmış kaynak kodu, veri ve hizmetlerle önizleyin.",
      "views": {
        "preview": "Sürüm önizlemesi"
      }
    }
  }
}
```

插件市场列表支持可选的 i18n 名称/描述元数据，旧目录与旧条目仍显示原字段。修改名称、描述或翻译时也应增加插件版本，使目录同步能够识别新清单。

Studio 与 SDK 共用 `PLUGIN_LOCALES` 语言清单，当前包含 en、zh、zh-TW、ja、ko、fr、es、de、pt、ru、ar、tr 共 12 种。新项目的名称、描述、全部页面和显式导航标题必须逐种提供；缺少任一项即检查失败，不能以英文回退代替翻译。回退仅用于旧插件、旧语言集或未知语言的运行兼容。创建模板同时提供全部语言的描述、设置标题与保存文案。插件文档自动使用 ctx.locale 设置 lang/dir，阿拉伯语为 RTL。
